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
#   release-attach.sh upgrade-target ID print id=, version=, sha=, exe=, asset=, from= (stdout
#                                       holds only these) for final draft ID once its signed
#                                       installer is attached and recorded: the installer's
#                                       digest and asset id, and the current Latest's version
#   release-attach.sh record-upgrade ID SHA VERSION RUN_ID EXE_SHA256 FROM
#                                       record in draft ID's notes that upgrade-check run RUN_ID
#                                       passed for that installer from vFROM, replacing any
#                                       earlier upgrade record; re-validates the draft first
#   release-attach.sh publish ID VERSION SHA DEB_SHA256 EXE_SHA256
#                                       publish draft ID as vVERSION only if it targets SHA and
#                                       holds exactly the accepted .deb and installer (the
#                                       recorded one), VERSION is newer than Latest, and (when
#                                       there is a Latest) a successful upgrade check from
#                                       exactly that Latest is recorded for that installer
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
# release-upgrade-check.yml's pass: its run, the installer it checked and the release it
# upgraded from.
UPGRADE_RE='<!-- orca-upgrade-check: [0-9]+ sha256:[0-9a-f]{64} from v[0-9]+\.[0-9]+\.[0-9]+ -->'

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

# True if RUN_ID is a successful release-upgrade-check.yml run of this repository, dispatched
# from main (the reason goes to stderr otherwise).
upgrade_run_passed() {
  local run=$1 facts
  facts=$(gh api "repos/$REPO/actions/runs/$run" --jq \
    '[.path, .repository.full_name, .head_repository.full_name, .event, .head_branch, .status, .conclusion] | join(" ")') ||
    { note "Run $run not found."; return 1; }
  [[ "$facts" == ".github/workflows/release-upgrade-check.yml $REPO $REPO workflow_dispatch main completed success" ]] ||
    { note "Run $run is not a successful Release (upgrade check) run dispatched from main ($facts)."; return 1; }
}

# The name of release-upgrade-check.yml's record job, which binds that run's success to the
# candidate (release id, version, source commit, installer digest) and the baseline it was
# installed over (the same four). A job's name comes from the workflow file on main, not from
# anything a draft's notes say: it is the check's receipt. Keep in step with the workflow.
receipt_name() {
  echo "upgrade check receipt: release $1 v$2 $3 $4 from release $5 v$6 $7 $8"
}

# The current Latest as the upgrade baseline: prints "ID VERSION SHA EXE_DIGEST" (status 0),
# or nothing with status 1 when there is no Latest; stops on anything else.
latest_baseline() {
  local rc=0 json tag base_sha base_exe
  json=$(lookup "repos/$REPO/releases/latest" .) || rc=$?
  found "$rc" || return 1
  tag=$(jq -r '.tag_name' <<<"$json")
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Latest is '$tag', not a final"
  base_sha=$(gh api "repos/$REPO/commits/$tag" --jq .sha) || fail "could not resolve $tag to a commit"
  [[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || fail "$tag resolves to '$base_sha', not a commit"
  base_exe=$(jq -r --arg e "ORCA-${tag#v}-win-x64.exe" '[.assets[] | select(.name == $e) | .digest] | .[0] // ""' <<<"$json")
  [[ "$base_exe" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "Latest $tag has no Windows x64 installer to upgrade from"
  echo "$(jq -r .id <<<"$json") ${tag#v} $base_sha $base_exe"
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
  upgrade-target)
    [[ $# -eq 2 && "$2" =~ ^[0-9]+$ ]] || fail "usage: release-attach.sh upgrade-target ID"
    id=$2
    json=$(gh api "repos/$REPO/releases/$id") || fail "release $id not found"
    name=$(jq -r '.name' <<<"$json")
    [[ "$name" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "release $id is named '$name', not a final"
    version=${name#v} sha=$(jq -r '.target_commitish' <<<"$json")
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "release $id targets '$sha', not a commit"
    records=$(jq -r '.body // ""' <<<"$json" | grep -oE "$MARK_RE" || true)
    [[ $(grep -c . <<<"$records") -eq 1 ]] || fail "release $id has no single signing record; attach its installer first"
    validate "$id" "$sha" "$version" "$records" >/dev/null
    exe_name="ORCA-$version-win-x64.exe"
    exe=$(jq -r --arg e "$exe_name" '[.assets[] | select(.name == $e) | .digest] | .[0] // ""' <<<"$json")
    asset=$(jq -r --arg e "$exe_name" '[.assets[] | select(.name == $e) | .id] | .[0] // ""' <<<"$json")
    [[ -n "$exe" && "$exe" == "$(awk '{print $4}' <<<"$records")" && "$asset" =~ ^[0-9]+$ ]] ||
      fail "release $id's installer (${exe:-none}) is not the recorded one"
    base=$(latest_baseline) || fail "there is no Latest release to upgrade from"
    read -r from_id from from_sha from_exe <<<"$base"
    printf 'id=%s\nversion=%s\nsha=%s\nexe=%s\nasset=%s\nfrom=%s\nfrom_id=%s\nfrom_sha=%s\nfrom_exe=%s\n' \
      "$id" "$version" "$sha" "$exe" "$asset" "$from" "$from_id" "$from_sha" "$from_exe"
    ;;
  record-upgrade)
    [[ $# -eq 7 && "$2" =~ ^[0-9]+$ && "$3" =~ ^[0-9a-f]{40}$ && "$4" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$5" =~ ^[0-9]+$ &&
      "$6" =~ ^sha256:[0-9a-f]{64}$ && "$7" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
      fail "usage: release-attach.sh record-upgrade ID SHA VERSION RUN_ID EXE_SHA256 FROM"
    id=$2 sha=$3 version=$4 run=$5 exe=$6 from=$7
    json=$(gh api "repos/$REPO/releases/$id") || fail "release $id not found"
    records=$(jq -r '.body // ""' <<<"$json" | grep -oE "$MARK_RE" || true)
    [[ $(grep -c . <<<"$records") -eq 1 && "$(awk '{print $4}' <<<"$records")" == "$exe" ]] ||
      fail "release $id's signing record is not the checked installer $exe; nothing written"
    body=$(validate "$id" "$sha" "$version" "$records")
    have=$(gh api "repos/$REPO/releases/$id" --jq ".assets[] | select(.name == \"ORCA-$version-win-x64.exe\") | .digest")
    [[ "$have" == "$exe" ]] || fail "release $id's installer is $have, not the checked $exe; nothing written"
    marker="<!-- orca-upgrade-check: $run $exe from v$from -->"
    # One upgrade record: the newest pass replaces any earlier one.
    body=$(grep -vE "^$UPGRADE_RE\$" <<<"$body" || true)
    jq -n --arg body "$body"$'\n\n'"$marker" '{body: $body}' |
      gh api -X PATCH "repos/$REPO/releases/$id" --input - >/dev/null
    check=$(gh api "repos/$REPO/releases/$id" --jq "[.draft, ((.body // \"\") | contains(\"$marker\"))] | map(tostring) | join(\" \")")
    [[ "$check" == "true true" ]] || fail "draft $id does not read back with its upgrade record ($check)"
    note "Recorded upgrade check run $run for ORCA-$version-win-x64.exe (\`$exe\`) from v$from on draft v$version (release \`$id\`)."
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
    else
      latest=""
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
    # The native upgrade check (release-upgrade-check.yml): a pass for exactly this installer,
    # from exactly the release it replaces as Latest. The first release has nothing to upgrade.
    if [[ -n "$latest" ]]; then
      upgrades=$(jq -r '.body // ""' <<<"$json" | grep -oE "$UPGRADE_RE" || true)
      [[ $(grep -c . <<<"$upgrades") -eq 1 ]] || fail "release $id has no single upgrade check record; run Release (upgrade check)"
      read -r _ _ upgrade_run upgrade_exe _ upgrade_from _ <<<"$upgrades"
      [[ "$upgrade_exe" == "$exe" ]] || fail "release $id's upgrade check was for $upgrade_exe, not the accepted installer $exe"
      [[ "$upgrade_from" == "$latest" ]] || fail "release $id's upgrade check was from $upgrade_from, not the current latest $latest"
      upgrade_run_passed "$upgrade_run" || fail "release $id's upgrade check run $upgrade_run did not pass"
      # The run's receipt, not the editable notes, says what it tested: this draft's exact
      # installer over the current Latest's exact installer.
      base=$(latest_baseline) || fail "the Latest release disappeared"
      read -r from_id from from_sha from_exe <<<"$base"
      want=$(receipt_name "$id" "$version" "$sha" "$exe" "$from_id" "$from" "$from_sha" "$from_exe")
      receipts=$(gh api --paginate "repos/$REPO/actions/runs/$upgrade_run/jobs?per_page=100" \
        --jq '.jobs[] | select(.status == "completed" and .conclusion == "success") | .name') ||
        fail "could not read run $upgrade_run's jobs; nothing written"
      grep -qxF "$want" <<<"$receipts" ||
        fail "upgrade check run $upgrade_run has no successful receipt \"$want\""
    fi
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
  *) fail "usage: release-attach.sh select RUN_ID | attach ID SHA VERSION RUN_ID FILE | reconcile | upgrade-target ID | record-upgrade ID SHA VERSION RUN_ID EXE_SHA256 FROM | publish ID VERSION SHA DEB_SHA256 EXE_SHA256" ;;
esac
