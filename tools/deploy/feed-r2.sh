#!/usr/bin/env bash
# Write the private desktop feed in Cloudflare R2 through its S3 API. Run by
# release-publish.yml and feed-promote.yml; tools/deploy/feed-worker serves what this writes.
#
#   feed-r2.sh snapshot DIR VERSION        upload VERSION's Windows feed files from DIR, then
#                                          offer it in the internal ring
#   feed-r2.sh promote RING VERSION PERCENT
#                                          offer VERSION to PERCENT of RING (0 halts a rollout)
#
# Environment: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (an R2 API token limited to the
# bucket), FEED_ACCOUNT_ID (Cloudflare account id), FEED_BUCKET.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fail() { echo "::error::$*" >&2; exit 1; }
[[ "${FEED_ACCOUNT_ID:-}" =~ ^[0-9a-f]{32}$ ]] || fail "FEED_ACCOUNT_ID must be a Cloudflare account id"
[[ "${FEED_BUCKET:-}" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || fail "FEED_BUCKET is not a bucket name"
export AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true
s3() { aws s3api --endpoint-url "https://$FEED_ACCOUNT_ID.r2.cloudflarestorage.com" "$@"; }
check_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail "invalid version: $1"; }
channel_of() { if [[ "$1" == *-* ]]; then echo prerelease; else echo latest; fi; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# 0 = present, 1 = absent. Any other failure (credentials, network, service) stops the run
# rather than being read as absence.
exists() {
  if s3 head-object --bucket "$FEED_BUCKET" --key "$1" >/dev/null 2>"$work/head-error"; then return 0; fi
  if grep -Eq '\((404|NoSuchKey)\)|Not Found' "$work/head-error"; then return 1; fi
  cat "$work/head-error" >&2
  fail "could not look up $1"
}

# Write KEY from FILE only if KEY is absent. If it already exists, it must hold the same bytes:
# a retry after an interruption resumes, and nothing ever replaces published bytes.
put_once() {
  local key=$1 file=$2 type=$3
  if s3 put-object --bucket "$FEED_BUCKET" --key "$key" --body "$file" --content-type "$type" \
    --if-none-match '*' >/dev/null 2>"$work/put-error"; then
    return 0
  fi
  grep -Eq 'PreconditionFailed|\(412\)' "$work/put-error" || { cat "$work/put-error" >&2; fail "could not write $key"; }
  s3 get-object --bucket "$FEED_BUCKET" --key "$key" "$work/existing" >/dev/null 2>"$work/get-error" ||
    { cat "$work/get-error" >&2; fail "could not read existing $key"; }
  cmp -s "$file" "$work/existing" || fail "$key already exists with different bytes"
  rm -f "$work/existing"
  echo "$key already present with identical bytes"
}

# Read-modify-write rings.json, conditional on the copy read, so a concurrent writer fails
# this step instead of being overwritten. The workflows also share one concurrency group.
update_rings() {
  local condition
  if s3 get-object --bucket "$FEED_BUCKET" --key rings.json --query ETag --output text \
    "$work/rings.json" >"$work/etag" 2>"$work/error"; then
    condition=(--if-match "$(cat "$work/etag")")
  elif grep -q NoSuchKey "$work/error"; then
    condition=(--if-none-match '*')
  else
    cat "$work/error" >&2
    fail "could not read rings.json"
  fi
  node "$here/feed-rings.js" "$work/rings.json" "$@" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  s3 put-object --bucket "$FEED_BUCKET" --key rings.json --body "$work/rings.json" \
    --content-type application/json --cache-control no-store "${condition[@]}" >/dev/null
}

case "${1:-}" in
  snapshot)
    [[ $# -eq 3 ]] || fail "usage: feed-r2.sh snapshot DIR VERSION"
    dir=$2 version=$3
    check_version "$version"
    channel=$(channel_of "$version")
    # Payload first, metadata last, each written once. The Worker only offers a version
    # through rings.json, so a partial snapshot is never visible, and rerunning after an
    # interruption at any point resumes: identical objects are skipped, different ones refused.
    for arch in x64 arm64; do
      for name in "ORCA-$version-win-$arch.exe" "ORCA-$version-win-$arch.exe.blockmap"; do
        [[ -f "$dir/$name" ]] || fail "missing $name"
      done
      [[ -f "$dir/$channel-$arch.yml" ]] || fail "missing $channel-$arch.yml"
    done
    for arch in x64 arm64; do
      for name in "ORCA-$version-win-$arch.exe" "ORCA-$version-win-$arch.exe.blockmap"; do
        put_once "$version/$name" "$dir/$name" application/octet-stream
      done
    done
    for arch in x64 arm64; do
      put_once "$version/$channel-$arch.yml" "$dir/$channel-$arch.yml" "text/yaml; charset=utf-8"
    done
    update_rings publish "$version"
    ;;
  promote)
    [[ $# -eq 4 ]] || fail "usage: feed-r2.sh promote RING VERSION PERCENT"
    check_version "$3"
    channel=$(channel_of "$3")
    for arch in x64 arm64; do
      exists "$3/$channel-$arch.yml" || fail "no complete feed snapshot for $3"
    done
    update_rings promote "$2" "$3" "$4"
    ;;
  *)
    fail "usage: feed-r2.sh snapshot DIR VERSION | promote RING VERSION PERCENT"
    ;;
esac
