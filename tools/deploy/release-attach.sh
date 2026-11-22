#!/usr/bin/env bash
# Attach a final's signed x64 installer to its staged draft (release-attach-signed.yml).
#
#   release-attach.sh select RUN_ID     print artifact=, sha=, id=, version= (stdout holds only
#                                       these) for the one final draft at the commit RUN_ID
#                                       signed; nothing if none. RUN_ID must be a successful
#                                       windows-signed.yml run of this repository, dispatched
#                                       from main, with exactly one unexpired signed artifact
#   release-attach.sh attach ID SHA VERSION RUN_ID FILE
#                                       record RUN_ID and FILE's digest in draft ID's notes, then
#                                       upload FILE; re-validates the draft before every write
#   release-attach.sh reconcile         dispatch the attach for every final draft still missing
#                                       its installer or record: the recorded run if there is
#                                       one, else the newest qualifying run for its commit
#   release-attach.sh publish ID VERSION SHA DEB_SHA256 EXE_SHA256
#                                       publish draft ID as vVERSION only if it targets SHA and
#                                       holds exactly the accepted .deb and installer (the
#                                       recorded one), and VERSION is newer than Latest
#
# Every write is preceded by a fresh read of the exact draft: still a draft, the same target
# and name, only the expected assets, and no other record. The record is written before the
# upload, so an interrupted attach is resumed with the same run, never a newer one. The attach
# and publish workflows share one concurrency group, so publication through the workflow
# never interleaves with an attach. Environment: GH_TOKEN, REPO.
set -euo pipefail
fail() { echo "::error::$*" >&2; exit 1; }
# Notes go to stderr and the summary: `select`'s stdout is the step's GITHUB_OUTPUT.
note() { echo "$*" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}" >&2; }
MARK_RE='<!-- orca-signed-run: [0-9]+ sha256:[0-9a-f]{64} -->'

# Print RUN_ID's single unexpired signed artifact name if it is a successful
# windows-signed.yml run of this repository, dispatched from main; print nothing otherwise
# (the reason goes to stderr).
signed_artifact() {
  local run=$1 facts names count
  facts=$(gh api "repos/$REPO/actions/runs/$run" --jq \
    '[.path, .repository.full_name, .head_repository.full_name, .event, .head_branch, .status, .conclusion] | join(" ")') ||
    { note "Run $run not found."; return 0; }
  if [[ "$facts" != ".github/workflows/windows-signed.yml $REPO $REPO workflow_dispatch main completed success" ]]; then
    note "Run $run is not a successful Windows signed (spike) run dispatched from main ($facts)."
    return 0
  fi
  names=$(gh api "repos/$REPO/actions/runs/$run/artifacts?per_page=100" \
    --jq '.artifacts[] | select(.expired | not) | .name | select(test("^windows-signed-[0-9a-f]{40}$"))')
  count=$(grep -c . <<<"$names" || true)
  if [[ "$count" -ne 1 ]]; then
    note "Run $run has $count unexpired signed artifacts, not one."
    return 0
  fi
  echo "$names"
}

# lookup PATH JQ: print the value (status 0), status 1 only for an explicit Not Found, and
# status 2 for any other failure (rate limit, outage, access). It runs in a command
# substitution, so callers must stop on 2 themselves (see `found`).
lookup() {
  local out
  if out=$(gh api "$1" --jq "$2" 2>"${TMPDIR:-/tmp}/lookup-error.$$"); then
    rm -f "${TMPDIR:-/tmp}/lookup-error.$$"
    echo "$out"
    return 0
  fi
  if grep -q 'HTTP 404' "${TMPDIR:-/tmp}/lookup-error.$$"; then
    rm -f "${TMPDIR:-/tmp}/lookup-error.$$"
    return 1
  fi
  cat "${TMPDIR:-/tmp}/lookup-error.$$" >&2
  rm -f "${TMPDIR:-/tmp}/lookup-error.$$"
  echo "::error::could not read $1; nothing written" >&2
  return 2
}
# found STATUS: true for 0, false for 1, and stops the run for anything else.
found() { case "$1" in 0) return 0 ;; 1) return 1 ;; *) exit 1 ;; esac; }

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
    artifact=$(signed_artifact "$2")
    [[ -n "$artifact" ]] || { note "Nothing to attach from run $2."; exit 0; }
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
    # The record first: if anything interrupts the upload, the draft already names this run,
    # so reconcile resumes with it and no other run's bytes can be attached.
    body=$(validate "$id" "$sha" "$version" "$marker")
    if ! grep -qF "$marker" <<<"$body"; then
      jq -n --arg body "$body"$'\n\n'"$marker" '{body: $body}' |
        gh api -X PATCH "repos/$REPO/releases/$id" --input - >/dev/null
    fi
    validate "$id" "$sha" "$version" "$marker" >/dev/null
    have=$(gh api "repos/$REPO/releases/$id" --jq ".assets[] | select(.name == \"$name\") | .digest")
    if [[ -z "$have" ]]; then
      gh api -X POST -H "Content-Type: application/octet-stream" \
        "https://uploads.github.com/repos/$REPO/releases/$id/assets?name=$name" --input "$file" >/dev/null
    elif [[ "$have" != "$want" ]]; then
      fail "draft $id already has $name with $have, not this run's $want"
    fi
    check=$(gh api "repos/$REPO/releases/$id" --jq \
      "[.draft, .target_commitish == \"$sha\", ([.assets[] | select(.name == \"$name\") | .digest] == [\"$want\"]), ((.body // \"\") | contains(\"$marker\"))] | map(tostring) | join(\" \")")
    [[ "$check" == "true true true true" ]] || fail "draft $id does not read back with $name and its record ($check)"
    note "Attached $name (\`$want\`) from signed run $run to draft v$version (release \`$id\`, \`$sha\`)."
    ;;
  reconcile)
    drafts=$(gh api --paginate "repos/$REPO/releases" \
      --jq '.[] | select(.draft and (.prerelease | not)) | [.id, .target_commitish, .name, ([.assets[].name] | any(endswith("-win-x64.exe")))] | @tsv')
    [[ -n "$drafts" ]] || { note "No final drafts."; exit 0; }
    runs=$(gh api "repos/$REPO/actions/workflows/windows-signed.yml/runs?branch=main&event=workflow_dispatch&status=success&per_page=30" \
      --jq '.workflow_runs[].id')
    while IFS=$'\t' read -r id sha name attached; do
      [[ "$name" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || continue
      records=$(gh api "repos/$REPO/releases/$id" --jq '.body // ""' | grep -oE "$MARK_RE" || true)
      count=$(grep -c . <<<"$records" || true)
      if [[ "$count" -gt 1 ]]; then
        note "$name (release $id): more than one signing record; fix by hand."
        continue
      fi
      if [[ "$count" -eq 1 && "$attached" == true ]]; then continue; fi
      if [[ "$count" -eq 0 && "$attached" == true ]]; then
        note "$name (release $id): an installer without a signing record (attached by hand); not touched."
        continue
      fi
      # Recorded but not uploaded: resume with exactly the recorded run, never another.
      if [[ "$count" -eq 1 ]]; then
        candidates=$(awk '{print $3}' <<<"$records")
      else
        candidates=$runs
      fi
      found=""
      for run in $candidates; do
        if [[ "$(signed_artifact "$run")" == "windows-signed-$sha" ]]; then
          found=$run
          break
        fi
      done
      if [[ -z "$found" ]]; then
        note "$name (release $id): no qualifying signed run for $sha (recorded: ${records:-none})."
        continue
      fi
      gh workflow run release-attach-signed.yml --repo "$REPO" --ref main -f signed_run_id="$found"
      note "$name (release $id): dispatched the attach with signed run $found."
    done <<<"$drafts"
    ;;
  publish)
    # The operator states what native acceptance passed on: the source commit and both
    # installers' digests. Everything is compared against the draft right before publishing.
    [[ $# -eq 6 && "$2" =~ ^[0-9]+$ && "$3" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$4" =~ ^[0-9a-f]{40}$ ]] ||
      fail "usage: release-attach.sh publish ID VERSION SHA DEB_SHA256 EXE_SHA256"
    id=$2 version=$3 sha=$4 deb="sha256:${5#sha256:}" exe="sha256:${6#sha256:}"
    [[ "$deb" =~ ^sha256:[0-9a-f]{64}$ && "$exe" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "digests must be SHA-256 hex"
    deb_name="ORCA-$version-linux-amd64.deb" exe_name="ORCA-$version-win-x64.exe"
    # Never move Latest backwards or sideways.
    rc=0
    latest=$(lookup "repos/$REPO/releases/latest" .tag_name) || rc=$?
    if found "$rc"; then
      [[ "$latest" != "v$version" && "$(printf '%s\n%s\n' "${latest#v}" "$version" | sort -V | tail -n1)" == "$version" ]] ||
        fail "v$version is not newer than the current latest $latest"
    fi
    rc=0
    tagged=$(lookup "repos/$REPO/git/ref/tags/v$version" .object.sha) || rc=$?
    if found "$rc"; then
      [[ "$tagged" == "$sha" ]] || fail "tag v$version already exists at $tagged, not $sha"
    fi
    json=$(gh api "repos/$REPO/releases/$id") || fail "release $id not found"
    records=$(jq -r '.body // ""' <<<"$json" | grep -oE "$MARK_RE" || true)
    [[ $(grep -c . <<<"$records") -eq 1 ]] || fail "release $id has no single signing record"
    [[ "$(awk '{print $4}' <<<"$records")" == "$exe" ]] || fail "release $id's signing record is not the accepted installer $exe"
    json=$(validate "$id" "$sha" "$version" "$records" >/dev/null && gh api "repos/$REPO/releases/$id") || exit 1
    digests() { jq -r --arg d "$deb_name" --arg e "$exe_name" '[(.assets | length), ([.assets[] | select(.name == $d) | .digest] | .[0] // ""), ([.assets[] | select(.name == $e) | .digest] | .[0] // "")] | map(tostring) | join(" ")'; }
    [[ "$(digests <<<"$json")" == "2 $deb $exe" ]] ||
      fail "release $id's assets ($(digests <<<"$json")) are not exactly the accepted $deb_name $deb and $exe_name $exe"
    gh api -X PATCH "repos/$REPO/releases/$id" -f tag_name="v$version" -f target_commitish="$sha" \
      -F draft=false -f make_latest=true >/dev/null
    after=$(gh api "repos/$REPO/releases/$id")
    [[ "$(jq -r '.draft' <<<"$after")" == false && "$(digests <<<"$after")" == "2 $deb $exe" ]] ||
      fail "release $id does not read back published with the accepted assets"
    [[ "$(gh api "repos/$REPO/git/ref/tags/v$version" --jq .object.sha)" == "$sha" ]] || fail "tag v$version does not point at $sha"
    [[ "$(gh api "repos/$REPO/releases/latest" --jq .id)" == "$id" ]] || fail "release $id is not latest"
    note "Published v$version (release \`$id\`, \`$sha\`): $deb_name \`$deb\`, $exe_name \`$exe\`."
    ;;
  *) fail "usage: release-attach.sh select RUN_ID | attach ID SHA VERSION RUN_ID FILE | reconcile | publish ID VERSION SHA DEB_SHA256 EXE_SHA256" ;;
esac
