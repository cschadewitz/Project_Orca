#!/usr/bin/env bash
# Dispatch feed-publish.yml for published finals whose draft recorded the signing run that
# produced their published installer (see .github/workflows/feed-auto.yml). Reads only;
# writes nothing but dispatches. Feeding a version again is a no-op in feed-publish.yml, so a
# repeated dispatch is safe.
#
# release-attach-signed.yml writes `<!-- orca-signed-run: RUN_ID sha256:HEX -->` into the
# draft's notes when it attaches the signed x64 installer. A release is dispatched only when
# that marker exists, names one run, and its digest equals the published installer's digest;
# anything else is left for a manual dispatch, with a note.
#
# Environment: GH_TOKEN, REPO, EVENT (release | schedule | workflow_dispatch), RELEASE_TAG
# (release event only).
set -euo pipefail
fail() { echo "::error::$*" >&2; exit 1; }
note() { echo "$*" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"; }
TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

# Dispatch one published release, or explain why not. Never fails the job for one release.
feed_release() {
  local tag=$1 json version markers run digest asset
  [[ "$tag" =~ $TAG_RE ]] || { note "$tag: not a version tag; skipped."; return 0; }
  version=${tag#v}
  json=$(gh api "repos/$REPO/releases/tags/$tag") || { note "$tag: no release; skipped."; return 0; }
  if [[ "$(jq -r '.draft == false and .published_at != null' <<<"$json")" != true ]]; then
    note "$tag: not published; skipped."
    return 0
  fi
  markers=$(jq -r '.body // ""' <<<"$json" | grep -oE '<!-- orca-signed-run: [0-9]+ sha256:[0-9a-f]{64} -->' || true)
  if [[ $(grep -c . <<<"$markers") -ne 1 ]]; then
    note "$tag: no single signed-run record in its notes; dispatch feed-publish.yml by hand."
    return 0
  fi
  run=$(awk '{print $3}' <<<"$markers")
  digest=$(awk '{print $4}' <<<"$markers")
  asset=$(jq -r --arg n "ORCA-$version-win-x64.exe" '[.assets[] | select(.name == $n) | .digest] | .[0] // ""' <<<"$json")
  if [[ "$asset" != "$digest" ]]; then
    note "$tag: the published installer ($asset) is not the one signed run $run recorded ($digest); not fed."
    return 0
  fi
  gh workflow run feed-publish.yml --repo "$REPO" --ref main -f version="$version" -f signed_run_id="$run"
  note "$tag: dispatched Desktop feed (publish signed) with signed run $run."
}

case "${EVENT:-}" in
  release)
    [[ "${RELEASE_TAG:-}" =~ $TAG_RE ]] || fail "not a version tag: ${RELEASE_TAG:-}"
    feed_release "$RELEASE_TAG"
    ;;
  schedule | workflow_dispatch)
    # Reconcile: every release published in the last 7 days (the signed artifacts' lifetime),
    # so a dispatch that was dropped or failed is retried.
    since=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)
    tags=$(gh api "repos/$REPO/releases?per_page=30" \
      --jq ".[] | select(.draft == false and .published_at != null and .published_at >= \"$since\") | .tag_name")
    [[ -n "$tags" ]] || { note "No release published since $since."; exit 0; }
    for tag in $tags; do feed_release "$tag"; done
    ;;
  *) fail "unsupported event: ${EVENT:-}" ;;
esac
