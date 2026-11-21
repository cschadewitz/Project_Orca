#!/usr/bin/env bash
# Attach a final's signed x64 installer to its staged draft (release-attach-signed.yml).
#
#   release-attach.sh select RUN_ID     print artifact=, sha=, id=, version= for the one final
#                                       draft at the commit RUN_ID signed (nothing if none)
#   release-attach.sh attach ID SHA VERSION RUN_ID FILE
#                                       upload FILE to draft ID and record RUN_ID and its digest
#                                       in the notes; re-validates the draft before every write
#   release-attach.sh reconcile         dispatch the attach for every final draft still missing
#                                       its installer or record, with the newest successful
#                                       signed run of its commit that still has the artifact
#
# Every write is preceded by a fresh read of the exact draft: still a draft, the same target
# and name, only the expected assets, and no other record. A draft published (or changed) in
# the meantime stops the run before it writes. Environment: GH_TOKEN, REPO.
set -euo pipefail
fail() { echo "::error::$*" >&2; exit 1; }
note() { echo "$*" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"; }
MARK_RE='<!-- orca-signed-run: [0-9]+ sha256:[0-9a-f]{64} -->'

# Refuse unless draft ID is still exactly what we selected. Prints its body.
validate() {
  local id=$1 sha=$2 version=$3 marker=$4 json names recorded
  json=$(gh api "repos/$REPO/releases/$id") || fail "release $id is gone"
  [[ "$(jq -r '.draft' <<<"$json")" == true ]] || fail "release $id is no longer a draft; nothing written"
  [[ "$(jq -r '.prerelease' <<<"$json")" == false ]] || fail "release $id is a prerelease"
  [[ "$(jq -r '.target_commitish' <<<"$json")" == "$sha" ]] || fail "release $id no longer targets $sha"
  [[ "$(jq -r '.name' <<<"$json")" == "v$version" ]] || fail "release $id is no longer named v$version"
  names=$(jq -r '[.assets[].name] | sort | join(" ")' <<<"$json")
  case "$names" in
    "ORCA-$version-linux-amd64.deb" | "ORCA-$version-linux-amd64.deb ORCA-$version-win-x64.exe") ;;
    *) fail "release $id has unexpected assets: $names" ;;
  esac
  recorded=$(jq -r '.body // ""' <<<"$json" | grep -oE "$MARK_RE" || true)
  [[ -z "$recorded" || "$recorded" == "$marker" ]] || fail "release $id already records another signing run: $recorded"
  jq -r '.body // ""' <<<"$json"
}

case "${1:-}" in
  select)
    [[ "${2:-}" =~ ^[0-9]+$ ]] || fail "usage: release-attach.sh select RUN_ID"
    artifact=$(gh api "repos/$REPO/actions/runs/$2/artifacts?per_page=100" \
      --jq '[.artifacts[] | select(.expired | not) | .name | select(test("^windows-signed-[0-9a-f]{40}$"))] | .[0] // ""')
    [[ -n "$artifact" ]] || { note "Signed run $2 has no unexpired signed artifact; nothing to attach."; exit 0; }
    sha=${artifact#windows-signed-}
    ids=$(gh api --paginate "repos/$REPO/releases" \
      --jq ".[] | select(.draft and (.prerelease | not) and .target_commitish == \"$sha\") | .id")
    count=$(grep -c . <<<"$ids" || true)
    [[ "$count" -ne 0 ]] || { note "No final draft targets $sha; nothing to attach."; exit 0; }
    [[ "$count" -eq 1 ]] || fail "$count final drafts target $sha ($(echo $ids)); attach by hand"
    name=$(gh api "repos/$REPO/releases/$ids" --jq .name)
    [[ "$name" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "draft $ids is named '$name', not a final"
    printf 'artifact=%s\nsha=%s\nid=%s\nversion=%s\n' "$artifact" "$sha" "$ids" "${name#v}"
    ;;
  attach)
    [[ $# -eq 6 ]] || fail "usage: release-attach.sh attach ID SHA VERSION RUN_ID FILE"
    id=$2 sha=$3 version=$4 run=$5 file=$6
    name="ORCA-$version-win-x64.exe"
    [[ "$(basename "$file")" == "$name" ]] || fail "$file is not $name"
    want="sha256:$(sha256sum "$file" | cut -d' ' -f1)"
    marker="<!-- orca-signed-run: $run $want -->"
    validate "$id" "$sha" "$version" "$marker" >/dev/null
    have=$(gh api "repos/$REPO/releases/$id" --jq ".assets[] | select(.name == \"$name\") | .digest")
    if [[ -z "$have" ]]; then
      gh api -X POST -H "Content-Type: application/octet-stream" \
        "https://uploads.github.com/repos/$REPO/releases/$id/assets?name=$name" --input "$file" >/dev/null
    elif [[ "$have" != "$want" ]]; then
      fail "draft $id already has $name with $have, not this run's $want"
    fi
    body=$(validate "$id" "$sha" "$version" "$marker")
    if ! grep -qF "$marker" <<<"$body"; then
      jq -n --arg body "$body"$'\n\n'"$marker" '{body: $body}' |
        gh api -X PATCH "repos/$REPO/releases/$id" --input - >/dev/null
    fi
    check=$(gh api "repos/$REPO/releases/$id" --jq \
      "[.draft, .target_commitish == \"$sha\", ([.assets[] | select(.name == \"$name\") | .digest] == [\"$want\"]), ((.body // \"\") | contains(\"$marker\"))] | map(tostring) | join(\" \")")
    [[ "$check" == "true true true true" ]] || fail "draft $id does not read back with $name and its record ($check)"
    note "Attached $name (\`$want\`) from signed run $run to draft v$version (release \`$id\`, \`$sha\`)."
    ;;
  reconcile)
    drafts=$(gh api --paginate "repos/$REPO/releases" \
      --jq '.[] | select(.draft and (.prerelease | not)) | [.id, .target_commitish, .name, ((.body // "") | test("<!-- orca-signed-run: [0-9]+ sha256:[0-9a-f]{64} -->")), ([.assets[].name] | any(endswith("-win-x64.exe")))] | @tsv')
    [[ -n "$drafts" ]] || { note "No final drafts."; exit 0; }
    runs=$(gh api "repos/$REPO/actions/workflows/windows-signed.yml/runs?branch=main&status=success&per_page=30" \
      --jq '.workflow_runs[].id')
    while IFS=$'\t' read -r id sha name recorded attached; do
      [[ "$name" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || continue
      if [[ "$recorded" == true && "$attached" == true ]]; then continue; fi
      found=""
      for run in $runs; do
        if gh api "repos/$REPO/actions/runs/$run/artifacts?per_page=100" \
          --jq ".artifacts[] | select(.name == \"windows-signed-$sha\" and (.expired | not)) | .id" | grep -q .; then
          found=$run
          break
        fi
      done
      if [[ -z "$found" ]]; then
        note "$name (release $id): no unexpired signed run for $sha yet."
        continue
      fi
      gh workflow run release-attach-signed.yml --repo "$REPO" --ref main -f signed_run_id="$found"
      note "$name (release $id): dispatched the attach with signed run $found."
    done <<<"$drafts"
    ;;
  *) fail "usage: release-attach.sh select RUN_ID | attach ID SHA VERSION RUN_ID FILE | reconcile" ;;
esac
