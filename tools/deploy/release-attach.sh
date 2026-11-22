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
#   release-attach.sh publish ID VERSION SHA DEB_SHA256 EXE_SHA256
#                                       publish draft ID as vVERSION only if it targets SHA and
#                                       holds exactly the accepted .deb and x64 installer (the
#                                       recorded one), plus either the recorded arm64 installer
#                                       with verified native acceptance (tools/deploy/
#                                       feed-arches.js verify) or the x64-only decision, and
#                                       the server bundle with its receipt, and VERSION is newer
#                                       than Latest
#   release-attach.sh run-with-jobs RUN_ID
#                                       print run RUN_ID with its latest attempt's jobs under
#                                       "jobs", for feed-arches.js's upgrade baseline receipt
#
# A final is published only with its signed server bundle (#876), checked by its receipt (see
# server_receipt). Release (server bundle), release-server-bundle.yml, uses:
#
#   release-attach.sh server-target VERSION SHA
#                                       print id= and kind= (final|prerelease) for the one
#                                       release vVERSION the bundle belongs to: SHA on main, a
#                                       final still a draft or a prerelease already published,
#                                       targeting SHA; fail otherwise
#   release-attach.sh server-attach ID SHA VERSION RUN_ID DIR
#                                       upload DIR's three bundle files to release ID, then record
#                                       RUN_ID and their digests in its notes; re-validates the
#                                       release before every write. Only an interrupted attach
#                                       (server files, no record at all) is replaced; a recorded,
#                                       duplicated or malformed record is never touched
#   release-attach.sh server-receipt ID SHA VERSION DIR
#                                       print digests= (DIR's three files, record order) and
#                                       receipt= (sha256 of the canonical receipt line committing
#                                       to ID, VERSION, SHA and those digests)
#   release-attach.sh server-reconcile  dispatch release-server-bundle.yml for every release on a
#                                       version line newer than Latest (final drafts, published
#                                       prereleases) that has no server record
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
SERVER_RE='<!-- orca-server-run: [0-9]+ sha256:[0-9a-f]{64} sha256:[0-9a-f]{64} sha256:[0-9a-f]{64} -->'
# The three server bundle files, in record order: archive, manifest, signature.
server_names() { local s="orca-server-$1-linux-x64"; echo "$s.tar.xz $s.manifest.json $s.manifest.json.sigstore.json"; }
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
  # The server bundle's files may be there too (any of them, mid-attach); nothing else.
  names=$(jq -r --arg s "$(server_names "$version")" '($s | split(" ")) as $server
    | [.assets[].name | select(. as $n | $server | index($n) | not)] | sort | join(" ")' <<<"$json")
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

# server_state BODY: "none", "one" (exactly one well-formed record) or "bad" (more than one,
# or anything that looks like a record but is not one). Only "none" may be written over.
server_state() {
  local strict loose
  strict=$(records "$SERVER_RE" <<<"$1" | grep -c . || true)
  loose=$(grep -o 'orca-server-run' <<<"$1" | grep -c . || true)
  if [[ "$loose" -eq 0 ]]; then echo none
  elif [[ "$strict" -eq 1 && "$loose" -eq 1 ]]; then echo one
  else echo bad; fi
}
# receipt_hash ID VERSION SHA "ARCHIVE MANIFEST SIGNATURE": the canonical receipt's digest.
receipt_hash() {
  printf 'orca-server-receipt/1 release=%s version=%s sha=%s files=%s' "$1" "$2" "$3" "$4" |
    sha256sum | awk '{print "sha256:" $1}'
}
# server_record BODY: the one record's "RUN archive manifest signature".
server_record() { records "$SERVER_RE" <<<"$1" | awk '{print $3, $4, $5, $6}'; }
# server_digests VERSION < JSON: the three server files' digests in record order ("" if absent).
server_digests() {
  jq -r --arg s "$(server_names "$1")" '. as $r | [($s | split(" "))[] as $n
    | ([$r.assets[] | select(.name == $n) | .digest] | .[0] // "")] | join(" ")'
}
# release_for_server ID SHA VERSION KIND: refuse unless release ID is still what server-target
# selected. Prints its JSON.
release_for_server() {
  local id=$1 sha=$2 version=$3 kind=$4 json
  json=$(gh api "repos/$REPO/releases/$id") || fail "release $id is gone"
  [[ "$(jq -r '.target_commitish' <<<"$json")" == "$sha" ]] || fail "release $id no longer targets $sha"
  [[ "$(jq -r '.name' <<<"$json")" == "v$version" ]] || fail "release $id is no longer named v$version"
  if [[ "$kind" == final ]]; then
    [[ "$(jq -r '[.draft, .prerelease] | map(tostring) | join(" ")' <<<"$json")" == "true false" ]] ||
      fail "release $id is no longer a final draft; nothing written"
  else
    [[ "$(jq -r '[.draft, .prerelease] | map(tostring) | join(" ")' <<<"$json")" == "false true" ]] ||
      fail "release $id is no longer a published prerelease; nothing written"
    [[ "$(gh api "repos/$REPO/git/ref/tags/v$version" --jq .object.sha)" == "$sha" ]] ||
      fail "tag v$version does not point at $sha"
  fi
  echo "$json"
}
# server_receipt ID VERSION SHA JSON: refuse unless release ID carries the signed server bundle
# for exactly this version and commit, proven by its receipt: one well-formed record; the three
# files with exactly its digests; the signed manifest (its bytes match the record) naming this
# version, commit and archive digest; and the recorded run a successful Release (server
# bundle) dispatch from main of this repository for this version and commit, whose signing,
# clean-host staging and attach jobs passed. Signature and clean host were checked in that run
# by those jobs against the same files.
server_receipt() {
  local id=$1 version=$2 sha=$3 json=$4 body record run want names tmp manifest_id facts jobs
  body=$(jq -r '.body // ""' <<<"$json")
  case "$(server_state "$body")" in
    none) fail "release $id has no server bundle record; let Release (server bundle) finish for $sha (it is dispatched with the release and reconciled every 6 hours)" ;;
    bad) fail "release $id has more than one or a malformed server bundle record; fix it by hand" ;;
  esac
  record=$(server_record "$body")
  run=${record%% *} want=${record#* }
  [[ "$(server_digests "$version" <<<"$json")" == "$want" ]] ||
    fail "release $id's server bundle files do not match their record"
  read -r -a names <<<"$(server_names "$version")"
  tmp=$(mktemp -d)
  manifest_id=$(jq -r --arg n "${names[1]}" '[.assets[] | select(.name == $n) | .id] | .[0] // ""' <<<"$json")
  gh api -H "Accept: application/octet-stream" "repos/$REPO/releases/assets/$manifest_id" >"$tmp/manifest.json" ||
    fail "could not read release $id's server manifest; nothing written"
  [[ "sha256:$(sha256sum "$tmp/manifest.json" | cut -d' ' -f1)" == "$(awk '{print $2}' <<<"$want")" ]] ||
    fail "release $id's server manifest bytes are not the recorded ones"
  jq -e --arg v "$version" --arg s "$sha" --arg a "${names[0]}" --arg d "$(awk '{print $1}' <<<"$want")"     '.schema == "orca-server-bundle/1" and .version == $v and .sourceSha == $s and .platform == "linux-x64"
     and .archive.name == $a and ("sha256:" + .archive.sha256) == $d' "$tmp/manifest.json" >/dev/null ||
    fail "release $id's server manifest is not for v$version at $sha with the attached archive"
  rm -rf "$tmp"
  facts=$(run_with_jobs "$run" 2>/dev/null) || fail "release $id's server bundle run $run cannot be read; nothing written"
  [[ "$(jq -r '[.path, .repository.full_name, .head_repository.full_name, .event, .head_branch, .status, .conclusion, .display_title] | join("|")' <<<"$facts")" == \
    ".github/workflows/release-server-bundle.yml|$REPO|$REPO|workflow_dispatch|main|completed|success|Release (server bundle) v$version at $sha" ]] ||
    fail "release $id's server bundle run $run is not a successful Release (server bundle) dispatch from main for v$version at $sha"
  jobs=$(jq -r '[.jobs[] | select(.conclusion == "success") | .name] | sort | join("|")' <<<"$facts")
  receipt="server bundle receipt: release $id v$version $sha $(receipt_hash "$id" "$version" "$sha" "$want")"
  for job in "sign the manifest (keyless, GitHub OIDC)" "stage --bundle on a clean host" "$receipt"; do
    [[ "|$jobs|" == *"|$job|"* ]] || fail "release $id's server bundle run $run has no successful '$job' job"
  done
}

case "${1:-}" in
  server-receipt)
    [[ $# -eq 5 && "$2" =~ ^[0-9]+$ && "$3" =~ ^[0-9a-f]{40}$ ]] || fail "usage: release-attach.sh server-receipt ID SHA VERSION DIR"
    read -r -a names <<<"$(server_names "$4")"
    digests=""
    for name in "${names[@]}"; do
      [[ -f "$5/$name" && ! -L "$5/$name" ]] || fail "$5/$name is missing"
      digests="$digests sha256:$(sha256sum "$5/$name" | cut -d' ' -f1)"
    done
    digests=${digests# }
    printf 'digests=%s\nreceipt=%s\n' "$digests" "$(receipt_hash "$2" "$4" "$3" "$digests")"
    ;;
  server-target)
    [[ $# -eq 3 && "$2" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ && "$3" =~ ^[0-9a-f]{40}$ ]] ||
      fail "usage: release-attach.sh server-target VERSION SHA"
    version=$2 sha=$3
    status=$(gh api "repos/$REPO/compare/$sha...main" --jq .status) || fail "cannot compare $sha with main"
    [[ "$status" == ahead || "$status" == identical ]] || fail "$sha is not on main ($status); nothing built"
    ids=$(gh api --paginate "repos/$REPO/releases" --jq ".[] | select(.name == \"v$version\") | .id")
    count=$(grep -c . <<<"$ids" || true)
    [[ "$count" -eq 1 ]] || fail "$count releases are named v$version, not one; nothing built"
    kind=final
    case "$version" in *-*) kind=prerelease ;; esac
    release_for_server "$ids" "$sha" "$version" "$kind" >/dev/null
    printf 'id=%s\nkind=%s\n' "$ids" "$kind"
    ;;
  server-attach)
    [[ $# -eq 6 && "$2" =~ ^[0-9]+$ && "$3" =~ ^[0-9a-f]{40}$ && "$5" =~ ^[0-9]+$ ]] ||
      fail "usage: release-attach.sh server-attach ID SHA VERSION RUN_ID DIR"
    id=$2 sha=$3 version=$4 run=$5 dir=$6
    kind=final
    case "$version" in *-*) kind=prerelease ;; esac
    read -r -a names <<<"$(server_names "$version")"
    want=""
    for name in "${names[@]}"; do
      [[ -f "$dir/$name" && ! -L "$dir/$name" ]] || fail "$dir/$name is missing"
      want="$want sha256:$(sha256sum "$dir/$name" | cut -d' ' -f1)"
    done
    want=${want# }
    marker="<!-- orca-server-run: $run $want -->"
    json=$(release_for_server "$id" "$sha" "$version" "$kind")
    body=$(jq -r '.body // ""' <<<"$json")
    case "$(server_state "$body")" in
      one)
        [[ "$(server_record "$body")" == "$run $want" && "$(server_digests "$version" <<<"$json")" == "$want" ]] ||
          fail "release $id already records another server bundle; not replaced"
        note "Release $id already carries this server bundle."
        exit 0
        ;;
      bad) fail "release $id has more than one or a malformed server bundle record; nothing written, fix it by hand" ;;
    esac
    # No record at all: any server files there are an interrupted attach's, and nothing has
    # vouched for them. Replace them with this run's.
    for name in "${names[@]}"; do
      stale=$(jq -r --arg n "$name" '.assets[] | select(.name == $n) | .id' <<<"$json")
      if [[ -n "$stale" ]]; then
        [[ "$(server_state "$(release_for_server "$id" "$sha" "$version" "$kind" | jq -r '.body // ""')")" == none ]] ||
          fail "release $id gained a server record; nothing replaced"
        gh api -X DELETE "repos/$REPO/releases/assets/$stale" >/dev/null
      fi
    done
    for name in "${names[@]}"; do
      [[ "$(server_state "$(release_for_server "$id" "$sha" "$version" "$kind" | jq -r '.body // ""')")" == none ]] ||
        fail "release $id gained a server record; nothing uploaded"
      gh api -X POST -H "Content-Type: application/octet-stream" \
        "https://uploads.github.com/repos/$REPO/releases/$id/assets?name=$name" --input "$dir/$name" >/dev/null
    done
    json=$(release_for_server "$id" "$sha" "$version" "$kind")
    [[ "$(server_digests "$version" <<<"$json")" == "$want" ]] || fail "release $id does not read back with this run's server files"
    [[ "$(server_state "$(jq -r '.body // ""' <<<"$json")")" == none ]] || fail "release $id gained a server record; not recorded"
    # The record last: it is what says the set is complete.
    jq -n --arg body "$(jq -r '.body // ""' <<<"$json")"$'\n\n'"$marker" '{body: $body}' |
      gh api -X PATCH "repos/$REPO/releases/$id" --input - >/dev/null
    json=$(release_for_server "$id" "$sha" "$version" "$kind")
    body=$(jq -r '.body // ""' <<<"$json")
    [[ "$(server_state "$body")" == one && "$(server_record "$body")" == "$run $want" &&
      "$(server_digests "$version" <<<"$json")" == "$want" ]] ||
      fail "release $id does not read back with the server bundle and its record"
    note "Attached the signed server bundle from run $run to v$version (release \`$id\`, \`$sha\`)."
    ;;
  server-reconcile)
    rc=0
    latest=$(lookup "repos/$REPO/releases/latest" .tag_name) || rc=$?
    if ! found "$rc"; then latest=v0.0.0; fi
    candidates=$(gh api --paginate "repos/$REPO/releases" \
      --jq '.[] | select((.draft and (.prerelease | not)) or ((.draft | not) and .prerelease)) | [.id, .target_commitish, .name] | @tsv')
    while IFS=$'\t' read -r id sha name; do
      [[ -n "$id" ]] || continue
      [[ "$name" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || continue
      version=${name#v} base=${name#v}
      base=${base%%-*}
      # Only a version line newer than Latest: older releases (and the release candidates of
      # Latest itself) predate the bundle or are done.
      [[ "$(printf '%s\n%s\n' "${latest#v}" "$base" | sort -V | tail -n1)" == "$base" && "$base" != "${latest#v}" ]] || continue
      case "$(server_state "$(gh api "repos/$REPO/releases/$id" --jq '.body // ""')")" in
        one) continue ;;
        bad) note "$name (release $id): more than one or a malformed server bundle record; fix by hand."; continue ;;
      esac
      gh workflow run release-server-bundle.yml --repo "$REPO" --ref main -f version="$version" -f source_sha="$sha"
      note "$name (release $id): dispatched the server bundle for $sha."
    done <<<"$candidates"
    ;;
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
    body=$(jq -r '.body // ""' <<<"$json")
    records=$(records "$MARK_RE" <<<"$body")
    [[ $(grep -c . <<<"$records") -eq 1 ]] || fail "release $id has no single signing record"
    [[ "$(awk '{print $4}' <<<"$records")" == "$exe" ]] || fail "release $id's signing record is not the accepted installer $exe"
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
    # The installers plus the server bundle's three files.
    expected="$([[ -n "$arm" ]] && echo 6 || echo 5) $deb $exe $arm"
    [[ "$(digests <<<"$json")" == "$expected" ]] ||
      fail "release $id's assets ($(digests <<<"$json")) are not exactly the accepted $deb_name $deb and $exe_name $exe${arm:+ and $arm_name $arm} and the server bundle"
    server_receipt "$id" "$version" "$sha" "$json"
    server=$(server_digests "$version" <<<"$json")
    gh api -X PATCH "repos/$REPO/releases/$id" -f tag_name="v$version" -f target_commitish="$sha" \
      -F draft=false -f make_latest=true >/dev/null
    after=$(gh api "repos/$REPO/releases/$id")
    [[ "$(jq -r '.draft' <<<"$after")" == false && "$(digests <<<"$after")" == "$expected" &&
      "$(server_digests "$version" <<<"$after")" == "$server" ]] ||
      fail "release $id does not read back published with the accepted assets"
    [[ "$(gh api "repos/$REPO/git/ref/tags/v$version" --jq .object.sha)" == "$sha" ]] || fail "tag v$version does not point at $sha"
    [[ "$(gh api "repos/$REPO/releases/latest" --jq .id)" == "$id" ]] || fail "release $id is not latest"
    note "Published v$version (release \`$id\`, \`$sha\`): $deb_name \`$deb\`, $exe_name \`$exe\`${arm:+, $arm_name \`$arm\` (natively accepted)}."
    ;;
  *) fail "usage: release-attach.sh select RUN_ID | attach ID SHA VERSION RUN_ID FILE [ARM64_FILE] | reconcile | accept-select [ID] | accept ID SHA VERSION RUN_ID DIGEST | x64-only ID SHA VERSION | publish ID VERSION SHA DEB_SHA256 EXE_SHA256 | run-with-jobs RUN_ID | server-receipt ID SHA VERSION DIR | server-target VERSION SHA | server-attach ID SHA VERSION RUN_ID DIR | server-reconcile" ;;
esac
