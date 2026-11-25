# Shared by the cutover scripts in tools/rename/ (sourced, never run). See tools/rename/README.md.
#
# Every script takes --dry-run, which prints each change instead of making it, and is idempotent:
# it reads the current state first and changes only what is not yet as it should be. Each change
# made is appended to the cutover log (CUTOVER_LOG, default ./cutover-log.json), one JSON object
# per line with the state before it, so rollback.sh can undo it in reverse order.
#
# Commands come from PATH (gh, curl, az, git, jq, node), so the tests put stubs first in PATH.
# Nothing here holds a secret: Cloudflare is reached with $CLOUDFLARE_API_TOKEN, GitHub with gh's
# own login, Azure with az's.

set -euo pipefail

OWNER="${CUTOVER_OWNER:-cschadewitz}"
OLD_REPO="Project_Orca"
NEW_REPO="Orrery"
OLD_INFRA="Project_Orca_Infra"
NEW_INFRA="Orrery-Infra"
DOCS_HOST="docs.orrery-control.dev"
DOCS_ZONE="orrery-control.dev"
SITE_ZONE="orrery-control.com"
FEED_HOST="feed.orrery-control.com"
FEED_WORKER="orca-desktop-feed"
PAGES_PROJECT="orrery-docs"
ENTRA_APP="orca-infra-ci"
CF_API="${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}"
CUTOVER_LOG="${CUTOVER_LOG:-$PWD/cutover-log.json}"
DRY_RUN=0
FAILED=0

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
ok() { printf '  ok    %s\n' "$*"; }
bad() {
  printf '  FAIL  %s\n' "$*"
  FAILED=1
}
todo() { printf '  TODO  %s\n' "$*"; }

# Parses --dry-run and passes everything else back in REST.
REST=()
parse_common() {
  REST=()
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      *) REST+=("$arg") ;;
    esac
  done
}

# The report goes to fd 3 (the script's stdout), so `out=$(change ...)` captures only the command.
exec 3>&1

# change DESCRIPTION -- COMMAND...: runs COMMAND, or only prints it with --dry-run.
change() {
  local what="$1"
  shift
  [[ "$1" == "--" ]] && shift
  if ((DRY_RUN)); then
    printf '  would %s\n' "$what" >&3
    printf '        $ %s\n' "$*" >&3
    return 0
  fi
  printf '  do    %s\n' "$what" >&3
  "$@"
}

# record KIND JSON: appends one undo record to the cutover log (not in a dry run).
record() {
  ((DRY_RUN)) && return 0
  jq -cn --arg kind "$1" --argjson data "$2" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{at: $at, kind: $kind} + $data' >>"$CUTOVER_LOG"
}

# GitHub: `gh api`, JSON out. ghq PATH prints the body, or nothing and status 1 when it is not there.
ghq() { gh api "$@" 2>/dev/null; }

# Cloudflare: cf METHOD PATH [JSON]. Prints the response body; fails unless .success is true.
cf() {
  local method="$1" path="$2" body="${3:-}"
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || die "CLOUDFLARE_API_TOKEN is not set"
  local args=(-sS -X "$method" "$CF_API$path" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
    -H "Content-Type: application/json")
  [[ -n "$body" ]] && args+=(--data "$body")
  local out
  out=$(curl "${args[@]}") || return 1
  printf '%s' "$out"
  jq -e '.success == true' >/dev/null <<<"$out"
}

zone_id() {
  cf GET "/zones?name=$1" | jq -r '.result[0].id // empty'
}

account_id() {
  [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] || die "CLOUDFLARE_ACCOUNT_ID is not set"
  printf '%s' "$CLOUDFLARE_ACCOUNT_ID"
}
