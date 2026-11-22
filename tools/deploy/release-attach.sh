#!/usr/bin/env bash
# Attach a final's signed Windows installers to its staged draft (release-attach-signed.yml)
# and record the arm64 installer's native acceptance (release-accept-arm64.yml, #889).
#
#   release-attach.sh select RUN_ID     print artifact=, sha=, id=, version= (stdout holds only
#                                       these) for the one final draft at the commit RUN_ID
#                                       signed; nothing if none. RUN_ID must be a successful
#                                       windows-signed.yml run of this repository, dispatched
#                                       from main, with exactly one unexpired signed artifact
#   release-attach.sh attach ID SHA VERSION RUN_ID FILE [ARM64_FILE]
#                                       record RUN_ID and each file's digest in draft ID's notes,
#                                       then upload FILE (x64) and ARM64_FILE; re-validates the
#                                       draft before every write
#   release-attach.sh reconcile         dispatch the attach for every final draft still missing
#                                       an installer or record: the recorded run if there is
#                                       one, else the newest qualifying run for its commit
#   release-attach.sh accept-select [ID]
#                                       print id=, sha=, version=, digest=, asset= for one final
#                                       draft (ID, or the oldest) whose recorded arm64 installer
#                                       is attached and has no acceptance record yet
#   release-attach.sh accept ID SHA VERSION RUN_ID DIGEST
#                                       record that RUN_ID's native acceptance passed on draft
#                                       ID's arm64 installer, whose digest must be DIGEST
#   release-attach.sh x64-only ID SHA VERSION
#                                       record the decision to release draft ID without arm64,
#                                       then remove its arm64 installer if attached; attach,
#                                       reconcile, accept, publish and the feed all honor it
#   release-attach.sh upgrade-target ID print id=, version=, sha=, exe=, asset=, from=, from_id=,
#                                       from_sha=, from_exe= (stdout holds only these) for final
#                                       draft ID once its signed x64 installer is attached and
#                                       recorded: that installer's digest and asset id, and the
#                                       current Latest's id, version, commit and x64 digest
#   release-attach.sh record-upgrade ID SHA VERSION RUN_ID EXE_SHA256 FROM
#                                       record in draft ID's notes that upgrade-check run RUN_ID
#                                       passed for that x64 installer from vFROM, replacing any
#                                       earlier upgrade record; re-validates the draft first
#   release-attach.sh publish ID VERSION SHA DEB_SHA256 EXE_SHA256
#                                       publish draft ID as vVERSION only if it targets SHA and
#                                       holds exactly the accepted .deb and x64 installer (the
#                                       recorded one), plus either the recorded arm64 installer
#                                       with verified native acceptance (tools/deploy/
#                                       feed-arches.js verify) or the x64-only decision,
#                                       VERSION is newer than Latest, and (when there is a
#                                       Latest) a successful x64 upgrade check whose receipt
#                                       names exactly this draft and the current Latest
#   release-attach.sh run-with-jobs RUN_ID
#                                       print run RUN_ID with its latest attempt's jobs under
#                                       "jobs", for feed-arches.js's upgrade baseline receipt
#
# Every write is preceded by a fresh read of the exact draft: still a draft, the same target
# and name, only the expected assets, and no other record. The records are written before the
# uploads, so an interrupted attach is resumed with the same run, never a newer one. The
# attach, accept and publish workflows share one concurrency group, so they never interleave.
# Environment: GH_TOKEN, REPO.
set -euo pipefail
fail() { echo "::error::$*" >&2; exit 1; }
# Notes go to stderr and the summary: `select`'s stdout is the step's GITHUB_OUTPUT.
note() { echo "$*" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}" >&2; }
MARK_RE='<!-- orca-signed-run: [0-9]+ sha256:[0-9a-f]{64} -->'
ARM_RE='<!-- orca-signed-run-arm64: [0-9]+ sha256:[0-9a-f]{64} -->'
ACCEPT_RE='<!-- orca-arm64-accepted: [0-9]+ sha256:[0-9a-f]{64} -->'
X64_ONLY='<!-- orca-x64-only -->'
# release-upgrade-check.yml's pass: its run, the x64 installer it checked and the release it
# upgraded from.
UPGRADE_RE='<!-- orca-upgrade-check: [0-9]+ sha256:[0-9a-f]{64} from v[0-9]+\.[0-9]+\.[0-9]+ -->'
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# records RE: the body's records matching RE, one per line (read from stdin).
records() { grep -oE "$1" || true; }

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

# Refuse unless draft ID is still exactly what we selected: the .deb, then the x64 installer,
# then the arm64 one, and no record other than MARKER and ARM_MARKER (each checked only when
# given). Prints its body.
validate() {
  local id=$1 sha=$2 version=$3 marker=$4 arm_marker=${5:-} json names recorded
  json=$(gh api "repos/$REPO/releases/$id") || fail "release $id is gone"
  [[ "$(jq -r '.draft' <<<"$json")" == true ]] || fail "release $id is no longer a draft; nothing written"
  [[ "$(jq -r '.prerelease' <<<"$json")" == false ]] || fail "release $id is a prerelease"
  [[ "$(jq -r '.target_commitish' <<<"$json")" == "$sha" ]] || fail "release $id no longer targets $sha"
  [[ "$(jq -r '.name' <<<"$json")" == "v$version" ]] || fail "release $id is no longer named v$version"
  names=$(jq -r '[.assets[].name] | sort | join(" ")' <<<"$json")
  case "$names" in
    "ORCA-$version-linux-amd64.deb" | "ORCA-$version-linux-amd64.deb ORCA-$version-win-x64.exe") ;;
    "ORCA-$version-linux-amd64.deb ORCA-$version-win-arm64.exe ORCA-$version-win-x64.exe") ;;
    *) fail "release $id has unexpected assets: $names" ;;
  esac
  recorded=$(jq -r '.body // ""' <<<"$json" | records "$MARK_RE")
  [[ -z "$marker" || -z "$recorded" || "$recorded" == "$marker" ]] ||
    fail "release $id already records another signing run: $recorded"
  if [[ -n "$arm_marker" ]]; then
    recorded=$(jq -r '.body // ""' <<<"$json" | records "$ARM_RE")
    [[ -z "$recorded" || "$recorded" == "$arm_marker" ]] ||
      fail "release $id already records another signing run for arm64: $recorded"
  fi
  jq -r '.body // ""' <<<"$json"
}

# upload ID NAME FILE WANT: upload FILE as NAME unless the draft already has exactly it.
upload() {
  local id=$1 name=$2 file=$3 want=$4 have
  have=$(gh api "repos/$REPO/releases/$id" --jq ".assets[] | select(.name == \"$name\") | .digest")
  if [[ -z "$have" ]]; then
    gh api -X POST -H "Content-Type: application/octet-stream" \
      "https://uploads.github.com/repos/$REPO/releases/$id/assets?name=$name" --input "$file" >/dev/null
  elif [[ "$have" != "$want" ]]; then
    fail "draft $id already has $name with $have, not this run's $want"
  fi
}

# A run and its latest attempt's jobs, one JSON object: the jobs carry the receipt that binds
# an arm64 acceptance run to the release it accepted (feed-arches.js receipt).
run_with_jobs() {
  [[ "$1" =~ ^[0-9]+$ ]] || fail "invalid run id: $1"
  local run jobs
  run=$(gh api "repos/$REPO/actions/runs/$1") || fail "could not read run $1"
  jobs=$(gh api --paginate "repos/$REPO/actions/runs/$1/jobs?per_page=100" --jq '.jobs[]' | jq -s .) ||
    fail "could not read run $1's jobs"
  jq --argjson jobs "$jobs" '. + {jobs: $jobs}' <<<"$run"
}

case "${1:-}" in
  run-with-jobs)
    [[ $# -eq 2 ]] || fail "usage: release-attach.sh run-with-jobs RUN_ID"
    run_with_jobs "$2"
    ;;
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
    [[ $# -eq 6 || $# -eq 7 ]] || fail "usage: release-attach.sh attach ID SHA VERSION RUN_ID FILE [ARM64_FILE]"
    id=$2 sha=$3 version=$4 run=$5 file=$6 arm_file=${7:-}
    name="ORCA-$version-win-x64.exe" arm_name="ORCA-$version-win-arm64.exe"
    [[ "$(basename "$file")" == "$name" ]] || fail "$file is not $name"
    want="sha256:$(sha256sum "$file" | cut -d' ' -f1)"
    marker="<!-- orca-signed-run: $run $want -->"
    arm_want="" arm_marker=""
    if [[ -n "$arm_file" ]]; then
      [[ "$(basename "$arm_file")" == "$arm_name" ]] || fail "$arm_file is not $arm_name"
      arm_want="sha256:$(sha256sum "$arm_file" | cut -d' ' -f1)"
      arm_marker="<!-- orca-signed-run-arm64: $run $arm_want -->"
    fi
    # An operator's x64-only decision stands: arm64 is neither recorded nor uploaded again.
    if [[ -n "$arm_file" && "$(gh api "repos/$REPO/releases/$id" --jq '.body // ""')" == *"$X64_ONLY"* ]]; then
      note "Draft v$version (release \`$id\`) is marked x64-only; the arm64 installer is not attached."
      arm_file="" arm_want="" arm_marker=""
    fi
    # The records first: if anything interrupts an upload, the draft already names this run,
    # so reconcile resumes with it and no other run's bytes can be attached.
    body=$(validate "$id" "$sha" "$version" "$marker" "$arm_marker")
    add=""
    for m in "$marker" "$arm_marker"; do
      [[ -z "$m" ]] || grep -qF "$m" <<<"$body" || add+=$'\n\n'"$m"
    done
    if [[ -n "$add" ]]; then
      jq -n --arg body "$body$add" '{body: $body}' |
        gh api -X PATCH "repos/$REPO/releases/$id" --input - >/dev/null
    fi
    validate "$id" "$sha" "$version" "$marker" "$arm_marker" >/dev/null
    upload "$id" "$name" "$file" "$want"
    if [[ -n "$arm_file" ]]; then
      validate "$id" "$sha" "$version" "$marker" "$arm_marker" >/dev/null
      upload "$id" "$arm_name" "$arm_file" "$arm_want"
    fi
    check=$(gh api "repos/$REPO/releases/$id" --jq \
      "[.draft, .target_commitish == \"$sha\", ([.assets[] | select(.name == \"$name\") | .digest] == [\"$want\"]), ((.body // \"\") | contains(\"$marker\"))] | map(tostring) | join(\" \")")
    [[ "$check" == "true true true true" ]] || fail "draft $id does not read back with $name and its record ($check)"
    if [[ -n "$arm_file" ]]; then
      check=$(gh api "repos/$REPO/releases/$id" --jq \
        "[([.assets[] | select(.name == \"$arm_name\") | .digest] == [\"$arm_want\"]), ((.body // \"\") | contains(\"$arm_marker\"))] | map(tostring) | join(\" \")")
      [[ "$check" == "true true" ]] || fail "draft $id does not read back with $arm_name and its record ($check)"
      note "Attached $arm_name (\`$arm_want\`) from signed run $run to draft v$version (release \`$id\`); its native acceptance runs next."
    fi
    note "Attached $name (\`$want\`) from signed run $run to draft v$version (release \`$id\`, \`$sha\`)."
    ;;
  reconcile)
    drafts=$(gh api --paginate "repos/$REPO/releases" \
      --jq '.[] | select(.draft and (.prerelease | not)) | [.id, .target_commitish, .name, ([.assets[].name] | any(endswith("-win-x64.exe"))), ([.assets[].name] | any(endswith("-win-arm64.exe")))] | @tsv')
    [[ -n "$drafts" ]] || { note "No final drafts."; exit 0; }
    runs=$(gh api "repos/$REPO/actions/workflows/windows-signed.yml/runs?branch=main&event=workflow_dispatch&status=success&per_page=30" \
      --jq '.workflow_runs[].id')
    while IFS=$'\t' read -r id sha name attached arm_attached; do
      [[ "$name" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || continue
      body=$(gh api "repos/$REPO/releases/$id" --jq '.body // ""')
      records=$(records "$MARK_RE" <<<"$body")
      count=$(grep -c . <<<"$records" || true)
      [[ "$body" != *"$X64_ONLY"* ]] || arm_attached=true
      if [[ "$count" -gt 1 ]]; then
        note "$name (release $id): more than one signing record; fix by hand."
        continue
      fi
      if [[ "$count" -eq 1 && "$attached" == true && "$arm_attached" == true ]]; then continue; fi
      if [[ "$count" -eq 0 && "$attached" == true ]]; then
        note "$name (release $id): an installer without a signing record (attached by hand); not touched."
        continue
      fi
      # Recorded but not (fully) uploaded: resume with exactly the recorded run, never another.
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
  accept-select)
    [[ $# -le 2 && "${2:-0}" =~ ^[0-9]+$ ]] || fail "usage: release-attach.sh accept-select [ID]"
    want_id=${2:-}
    drafts=$(gh api --paginate "repos/$REPO/releases" \
      --jq '.[] | select(.draft and (.prerelease | not)) | [.id, .target_commitish, .name] | @tsv' | sort -n)
    while IFS=$'\t' read -r id sha name; do
      [[ -n "$id" ]] || continue
      [[ -z "$want_id" || "$id" == "$want_id" ]] || continue
      [[ "$name" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || continue
      version=${name#v}
      json=$(gh api "repos/$REPO/releases/$id")
      body=$(jq -r '.body // ""' <<<"$json")
      if grep -qF "$X64_ONLY" <<<"$body"; then
        note "$name (release $id): marked x64-only; nothing to accept."
        continue
      fi
      arm=$(records "$ARM_RE" <<<"$body")
      [[ $(grep -c . <<<"$arm") -eq 1 ]] || { note "$name (release $id): no single arm64 signing record; nothing to accept."; continue; }
      digest=$(awk '{print $4}' <<<"$arm")
      asset=$(jq -r --arg n "ORCA-$version-win-arm64.exe" --arg d "$digest" \
        '[.assets[] | select(.name == $n and .digest == $d) | .id] | if length == 1 then .[0] else "" end' <<<"$json")
      [[ -n "$asset" ]] || { note "$name (release $id): the recorded arm64 installer is not attached yet."; continue; }
      if [[ -n "$(records "$ACCEPT_RE" <<<"$body")" ]]; then
        note "$name (release $id): arm64 acceptance already recorded."
        continue
      fi
      printf 'id=%s\nsha=%s\nversion=%s\ndigest=%s\nasset=%s\n' "$id" "$sha" "$version" "$digest" "$asset"
      exit 0
    done <<<"$drafts"
    note "No final draft is waiting for arm64 acceptance."
    ;;
  accept)
    [[ $# -eq 6 && "$2" =~ ^[0-9]+$ && "$3" =~ ^[0-9a-f]{40}$ && "$5" =~ ^[0-9]+$ && "$6" =~ ^sha256:[0-9a-f]{64}$ ]] ||
      fail "usage: release-attach.sh accept ID SHA VERSION RUN_ID DIGEST"
    id=$2 sha=$3 version=$4 run=$5 digest=$6
    arm_name="ORCA-$version-win-arm64.exe"
    marker="<!-- orca-arm64-accepted: $run $digest -->"
    check_accept() {
      local body arm accepted
      body=$(validate "$id" "$sha" "$version" "" "") || exit 1
      ! grep -qF "$X64_ONLY" <<<"$body" || fail "release $id is marked x64-only; nothing written"
      arm=$(records "$ARM_RE" <<<"$body")
      [[ $(grep -c . <<<"$arm") -eq 1 && "$(awk '{print $4}' <<<"$arm")" == "$digest" ]] ||
        fail "release $id's arm64 signing record is not $digest; nothing written"
      [[ "$(gh api "repos/$REPO/releases/$id" --jq "[.assets[] | select(.name == \"$arm_name\") | .digest] | join(\",\")")" == "$digest" ]] ||
        fail "release $id's $arm_name is not $digest; nothing written"
      accepted=$(records "$ACCEPT_RE" <<<"$body")
      while read -r line; do
        [[ -z "$line" || "$(awk '{print $4}' <<<"$line")" == "$digest" ]] ||
          fail "release $id already records acceptance of other arm64 bytes: $line"
      done <<<"$accepted"
      printf '%s' "$body"
    }
    body=$(check_accept)
    if [[ -n "$(records "$ACCEPT_RE" <<<"$body")" ]]; then
      note "v$version (release \`$id\`): arm64 acceptance of \`$digest\` was already recorded."
      exit 0
    fi
    jq -n --arg body "$body"$'\n\n'"$marker" '{body: $body}' |
      gh api -X PATCH "repos/$REPO/releases/$id" --input - >/dev/null
    [[ "$(gh api "repos/$REPO/releases/$id" --jq "[.draft, ((.body // \"\") | contains(\"$marker\"))] | map(tostring) | join(\" \")")" == "true true" ]] ||
      fail "draft $id does not read back with its arm64 acceptance record"
    note "Recorded native acceptance of $arm_name (\`$digest\`, run $run) on draft v$version (release \`$id\`)."
    ;;
  x64-only)
    [[ $# -eq 4 && "$2" =~ ^[0-9]+$ && "$3" =~ ^[0-9a-f]{40}$ && "$4" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
      fail "usage: release-attach.sh x64-only ID SHA VERSION"
    id=$2 sha=$3 version=$4 arm_name="ORCA-$4-win-arm64.exe"
    # The decision first, so a concurrent attach or reconcile honors it before the asset goes.
    body=$(validate "$id" "$sha" "$version" "" "")
    if ! grep -qF "$X64_ONLY" <<<"$body"; then
      jq -n --arg body "$body"$'\n\n'"$X64_ONLY" '{body: $body}' |
        gh api -X PATCH "repos/$REPO/releases/$id" --input - >/dev/null
    fi
    validate "$id" "$sha" "$version" "" "" >/dev/null
    asset=$(gh api "repos/$REPO/releases/$id" --jq "[.assets[] | select(.name == \"$arm_name\") | .id] | .[0] // \"\"")
    [[ -z "$asset" ]] || gh api -X DELETE "repos/$REPO/releases/assets/$asset" >/dev/null
    check=$(gh api "repos/$REPO/releases/$id" --jq \
      "[.draft, ([.assets[] | select(.name == \"$arm_name\")] | length == 0), ((.body // \"\") | contains(\"$X64_ONLY\"))] | map(tostring) | join(\" \")")
    [[ "$check" == "true true true" ]] || fail "draft $id does not read back x64-only ($check)"
    note "Draft v$version (release \`$id\`) is marked x64-only: it is published and fed without arm64."
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
    validate "$id" "$sha" "$version" "$records" "" >/dev/null
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
    body=$(validate "$id" "$sha" "$version" "$records" "")
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
    body=$(jq -r '.body // ""' <<<"$json")
    records=$(records "$MARK_RE" <<<"$body")
    [[ $(grep -c . <<<"$records") -eq 1 ]] || fail "release $id has no single signing record"
    [[ "$(awk '{print $4}' <<<"$records")" == "$exe" ]] || fail "release $id's signing record is not the accepted installer $exe"
    # The native upgrade check (release-upgrade-check.yml): a pass for exactly this installer,
    # from exactly the release it replaces as Latest. The first release has nothing to upgrade.
    if [[ -n "$latest" ]]; then
      upgrades=$(records "$UPGRADE_RE" <<<"$body")
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
    # arm64: either the recorded installer of the same signing run with verified native
    # acceptance (its run and evidence, tools/deploy/feed-arches.js), or an explicit x64-only
    # decision with no arm64 installer attached.
    arm_name="ORCA-$version-win-arm64.exe"
    arm=$(jq -r --arg n "$arm_name" '[.assets[] | select(.name == $n) | .digest] | .[0] // ""' <<<"$json")
    arm_records=$(records "$ARM_RE" <<<"$body")
    if grep -qF "$X64_ONLY" <<<"$body"; then
      [[ -z "$arm" ]] || fail "release $id is marked x64-only but still has $arm_name"
      arm_records=""
    else
      [[ -n "$arm" ]] ||
        fail "release $id has no $arm_name and no x64-only decision; let the attach finish, or dispatch Release (accept Windows arm64) with x64_only"
      [[ $(grep -c . <<<"$arm_records") -eq 1 && "$(awk '{print $4}' <<<"$arm_records")" == "$arm" &&
        "$(awk '{print $3}' <<<"$arm_records")" == "$(awk '{print $3}' <<<"$records")" ]] ||
        fail "release $id's $arm_name ($arm) is not the one its signing run recorded"
      evidence=$(mktemp -d)
      printf '%s' "$json" >"$evidence/release.json"
      gh api --paginate "repos/$REPO/releases" --jq '.[]' | jq -s . >"$evidence/releases.json" ||
        fail "could not read the releases; nothing written"
      echo '{}' >"$evidence/baseline-run.json"
      base_run=$(node "$HERE/feed-arches.js" baseline-run "$version" "$evidence/releases.json")
      [[ -z "$base_run" ]] || run_with_jobs "$base_run" >"$evidence/baseline-run.json" 2>/dev/null || true
      run=$(node "$HERE/feed-arches.js" acceptance-run "$version" "$evidence/release.json")
      if [[ -n "$run" ]]; then
        gh api "repos/$REPO/actions/runs/$run" >"$evidence/run.json" 2>/dev/null || true
        gh run download "$run" --repo "$REPO" --name arm64-acceptance-evidence --dir "$evidence/artifact" >/dev/null 2>&1 || true
      fi
      node "$HERE/feed-arches.js" verify "$version" "$REPO" "$evidence/release.json" "$evidence/releases.json" \
        "$evidence/baseline-run.json" "$evidence/run.json" "$evidence/artifact/evidence.json" ||
        fail "release $id's $arm_name ($arm) has no verified native acceptance; wait for Release (accept Windows arm64), or dispatch it with x64_only to publish without arm64"
      rm -rf "$evidence"
      arm_records=$(head -n1 <<<"$arm_records")
    fi
    json=$(validate "$id" "$sha" "$version" "$records" "$arm_records" >/dev/null && gh api "repos/$REPO/releases/$id") || exit 1
    digests() { jq -r --arg d "$deb_name" --arg e "$exe_name" --arg a "$arm_name" '[(.assets | length), ([.assets[] | select(.name == $d) | .digest] | .[0] // ""), ([.assets[] | select(.name == $e) | .digest] | .[0] // ""), ([.assets[] | select(.name == $a) | .digest] | .[0] // "")] | map(tostring) | join(" ")'; }
    expected="$([[ -n "$arm" ]] && echo 3 || echo 2) $deb $exe $arm"
    [[ "$(digests <<<"$json")" == "$expected" ]] ||
      fail "release $id's assets ($(digests <<<"$json")) are not exactly the accepted $deb_name $deb and $exe_name $exe${arm:+ and $arm_name $arm}"
    gh api -X PATCH "repos/$REPO/releases/$id" -f tag_name="v$version" -f target_commitish="$sha" \
      -F draft=false -f make_latest=true >/dev/null
    after=$(gh api "repos/$REPO/releases/$id")
    [[ "$(jq -r '.draft' <<<"$after")" == false && "$(digests <<<"$after")" == "$expected" ]] ||
      fail "release $id does not read back published with the accepted assets"
    [[ "$(gh api "repos/$REPO/git/ref/tags/v$version" --jq .object.sha)" == "$sha" ]] || fail "tag v$version does not point at $sha"
    [[ "$(gh api "repos/$REPO/releases/latest" --jq .id)" == "$id" ]] || fail "release $id is not latest"
    note "Published v$version (release \`$id\`, \`$sha\`): $deb_name \`$deb\`, $exe_name \`$exe\`${arm:+, $arm_name \`$arm\` (natively accepted)}."
    ;;
  *) fail "usage: release-attach.sh select RUN_ID | attach ID SHA VERSION RUN_ID FILE [ARM64_FILE] | reconcile | accept-select [ID] | accept ID SHA VERSION RUN_ID DIGEST | x64-only ID SHA VERSION | upgrade-target ID | record-upgrade ID SHA VERSION RUN_ID EXE_SHA256 FROM | publish ID VERSION SHA DEB_SHA256 EXE_SHA256" ;;
esac
