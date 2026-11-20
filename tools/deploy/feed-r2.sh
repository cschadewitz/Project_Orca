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
exists() { s3 head-object --bucket "$FEED_BUCKET" --key "$1" >/dev/null 2>&1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

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
    # A snapshot is complete once its metadata exists, and complete snapshots are immutable.
    # Payload left by a failed attempt is overwritten; the metadata, written last, never is.
    exists "$version/$channel-x64.yml" && fail "feed snapshot $version already exists"
    for arch in x64 arm64; do
      for name in "ORCA-$version-win-$arch.exe" "ORCA-$version-win-$arch.exe.blockmap"; do
        [[ -f "$dir/$name" ]] || fail "missing $name"
        s3 put-object --bucket "$FEED_BUCKET" --key "$version/$name" --body "$dir/$name" \
          --content-type application/octet-stream >/dev/null
      done
    done
    for arch in x64 arm64; do
      name="$channel-$arch.yml"
      [[ -f "$dir/$name" ]] || fail "missing $name"
      s3 put-object --bucket "$FEED_BUCKET" --key "$version/$name" --body "$dir/$name" \
        --content-type "text/yaml; charset=utf-8" --if-none-match '*' >/dev/null
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
