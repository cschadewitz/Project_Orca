#!/usr/bin/env bash
# Pair a published release with the signed Windows run of its tagged commit and dispatch
# feed-publish.yml for them (see .github/workflows/feed-auto.yml). Reads only; writes nothing
# but the dispatch. Exits 0 with a note when the other half is not there yet.
#
# Environment: GH_TOKEN, REPO, EVENT (release | workflow_run), and RELEASE_TAG (release) or
# SIGNED_RUN_ID (workflow_run).
set -euo pipefail
fail() { echo "::error::$*" >&2; exit 1; }
note() { echo "$*" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"; }
signed_workflow=windows-signed.yml

# The newest successful signed run from main that still has the artifact for SHA.
signed_run_for() {
  local sha=$1 id
  for id in $(gh api "repos/$REPO/actions/workflows/$signed_workflow/runs?branch=main&status=success&per_page=50" \
    --jq '.workflow_runs[].id'); do
    if gh api "repos/$REPO/actions/runs/$id/artifacts?per_page=100" \
      --jq ".artifacts[] | select(.name == \"windows-signed-$sha\" and (.expired | not)) | .id" | grep -q .; then
      echo "$id"
      return 0
    fi
  done
  return 1
}

# A published, non-draft vX.Y.Z[-pre] release whose tag is SHA.
published_version_at() {
  local sha=$1 tag
  for tag in $(git tag --points-at "$sha" 'v*'); do
    [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || continue
    if gh api "repos/$REPO/releases/tags/$tag" --jq 'select(.draft == false and .published_at != null) | .tag_name' 2>/dev/null |
      grep -qx "$tag"; then
      echo "${tag#v}"
      return 0
    fi
  done
  return 1
}

case "${EVENT:-}" in
  release)
    [[ "${RELEASE_TAG:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail "not a version tag: ${RELEASE_TAG:-}"
    version=${RELEASE_TAG#v}
    sha=$(git rev-parse --verify -q "refs/tags/$RELEASE_TAG^{commit}") || fail "tag $RELEASE_TAG not found"
    if ! run=$(signed_run_for "$sha"); then
      note "No signed Windows run for $RELEASE_TAG ($sha) yet; the feed runs when one completes."
      exit 0
    fi
    ;;
  workflow_run)
    [[ "${SIGNED_RUN_ID:-}" =~ ^[0-9]+$ ]] || fail "invalid run id"
    run=$SIGNED_RUN_ID
    artifact=$(gh api "repos/$REPO/actions/runs/$run/artifacts?per_page=100" \
      --jq '[.artifacts[].name | select(test("^windows-signed-[0-9a-f]{40}$"))] | .[0] // ""')
    [[ -n "$artifact" ]] || { note "Signed run $run has no signed artifact; nothing to feed."; exit 0; }
    sha=${artifact#windows-signed-}
    if ! version=$(published_version_at "$sha"); then
      note "Signed run $run ($sha) has no published release yet; the feed runs when it is published."
      exit 0
    fi
    ;;
  *) fail "unsupported event: ${EVENT:-}" ;;
esac

gh workflow run feed-publish.yml --repo "$REPO" --ref main -f version="$version" -f signed_run_id="$run"
note "Dispatched Desktop feed (publish signed) for $version from signed run $run ($sha)."
