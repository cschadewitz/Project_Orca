#!/usr/bin/env bash
# Checks before the Orrery cutover. Changes nothing (--dry-run is accepted and means the same).
# See tools/rename/README.md.
#
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... tools/rename/preflight.sh [--rings FILE]
#
# 1. Rename-Migration of both repositories is up to date with main (main has nothing it lacks).
# 2. The bridge release (BRIDGE_VERSION, default 0.8.1) or later is on the feed's stable ring,
#    desktop and server: every install can follow the rename. The ring state is rings.json, as
#    tools/deploy/feed-r2.sh read-rings writes it: give a copy with --rings FILE, or set the feed
#    reader's AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / FEED_ACCOUNT_ID / FEED_BUCKET and this
#    reads it the same way.
# 3. Both zones (orrery-control.dev, orrery-control.com) are Active in Cloudflare.
# 4. The Cloudflare token is active and can read what cloudflare.sh changes: Pages, DNS of both
#    zones, the redirect ruleset, Workers domains. gh can administer both repositories.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=cutover-lib.sh
. "$here/cutover-lib.sh"

BRIDGE_VERSION="${BRIDGE_VERSION:-0.8.1}"
RINGS_FILE=""
parse_common "$@"
set -- "${REST[@]+"${REST[@]}"}"
while (($#)); do
  case "$1" in
    --rings)
      RINGS_FILE="${2:?--rings needs a file}"
      shift 2
      ;;
    *) die "usage: preflight.sh [--rings FILE]" ;;
  esac
done

step "GitHub: Rename-Migration up to date with main"
for repo in "$OLD_REPO" "$OLD_INFRA"; do
  if ! info=$(ghq "repos/$OWNER/$repo"); then
    bad "$OWNER/$repo not readable"
    continue
  fi
  [[ "$(jq -r '.permissions.admin // false' <<<"$info")" == "true" ]] && ok "$repo: gh can administer it" ||
    bad "$repo: gh cannot administer it (rename needs admin)"
  if ! compare=$(ghq "repos/$OWNER/$repo/compare/Rename-Migration...main"); then
    bad "$repo: no Rename-Migration branch to compare"
    continue
  fi
  ahead=$(jq -r .ahead_by <<<"$compare")
  if [[ "$ahead" == "0" ]]; then ok "$repo: Rename-Migration has all of main"; else bad "$repo: main is $ahead commit(s) ahead of Rename-Migration; merge main first"; fi
done
for name in "$NEW_REPO" "$NEW_INFRA"; do
  if occupant=$(ghq "repos/$OWNER/$name"); then
    [[ "$(jq -r .private <<<"$occupant")" == "true" ]] && ok "$name is the private placeholder github.sh moves aside" ||
      bad "$OWNER/$name is public: github.sh would refuse to move it"
  else
    ok "$name is free"
  fi
done

step "Feed: the bridge ($BRIDGE_VERSION or later) on the stable ring"
rings=""
if [[ -n "$RINGS_FILE" ]]; then
  rings=$(node "$here/../deploy/feed-rings.js" "$RINGS_FILE" show) || bad "cannot read $RINGS_FILE"
elif [[ -n "${FEED_BUCKET:-}" && -n "${AWS_ACCESS_KEY_ID:-}" ]]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  if bash "$here/../deploy/feed-r2.sh" read-rings "$work/rings.json" >/dev/null; then
    rings=$(cat "$work/rings.json")
  else
    bad "feed-r2.sh read-rings failed"
  fi
else
  todo "no ring state: pass --rings FILE (from the feed watchdog's summary, or feed-r2.sh read-rings)"
  todo "or set the feed reader's AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, FEED_ACCOUNT_ID, FEED_BUCKET"
fi
if [[ -n "$rings" ]]; then
  for channel in desktop server; do
    verdict=$(node --input-type=module -e '
      const { compareVersions } = await import(process.argv[1]);
      const rings = JSON.parse(process.argv[2]);
      const ring = (process.argv[3] === "desktop" ? rings.rings : rings.server ?? {}).stable ?? {};
      const offered = [ring.version, ring.rollout?.version].filter(Boolean);
      const low = offered.length ? offered.reduce((a, b) => (compareVersions(a, b) < 0 ? a : b)) : undefined;
      console.log(low && compareVersions(low, process.argv[4]) >= 0 ? `ok ${offered.join(" + ")}` : `low ${low ?? "nothing"}`);
    ' "$here/../deploy/feed-worker/rings.js" "$rings" "$channel" "$BRIDGE_VERSION")
    if [[ "$verdict" == ok* ]]; then ok "stable $channel offers ${verdict#ok }"; else bad "stable $channel offers ${verdict#low }, not $BRIDGE_VERSION or later"; fi
  done
fi

step "Cloudflare: token and zones"
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  bad "CLOUDFLARE_API_TOKEN is not set"
else
  if status=$(cf GET /user/tokens/verify | jq -r .result.status) && [[ "$status" == "active" ]]; then ok "token active"; else bad "token not active"; fi
  for zone in "$DOCS_ZONE" "$SITE_ZONE"; do
    found=$(cf GET "/zones?name=$zone" | jq -c '.result[0] // empty') || found=""
    if [[ -z "$found" ]]; then
      bad "$zone: not visible to this token"
      continue
    fi
    [[ "$(jq -r .status <<<"$found")" == "active" ]] && ok "$zone: Active" || bad "$zone: $(jq -r .status <<<"$found"), not Active"
    id=$(jq -r .id <<<"$found")
    cf GET "/zones/$id/dns_records?per_page=1" >/dev/null && ok "$zone: DNS readable" || bad "$zone: token cannot read DNS"
  done
  if site=$(zone_id "$SITE_ZONE") && [[ -n "$site" ]]; then
    # A zone without the phase yet answers 404: that is readable enough.
    if out=$(cf GET "/zones/$site/rulesets/phases/http_request_dynamic_redirect/entrypoint" 2>/dev/null) ||
      [[ "$(jq -r '.errors[0].code // empty' <<<"$out" 2>/dev/null)" == "10003" ]]; then
      ok "$SITE_ZONE: redirect rules readable"
    else
      bad "$SITE_ZONE: token cannot read the redirect rules (Zone > Single Redirect / Dynamic URL Redirects)"
    fi
  fi
  if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    cf GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects" >/dev/null && ok "Pages readable" || bad "token cannot read Pages (Account > Cloudflare Pages: Edit)"
    cf GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" >/dev/null && ok "Workers domains readable" ||
      bad "token cannot read Workers domains (Account > Workers Scripts: Edit)"
  else
    bad "CLOUDFLARE_ACCOUNT_ID is not set"
  fi
fi

step "Azure: the Entra app $ENTRA_APP"
if command -v az >/dev/null && app=$(az ad app list --display-name "$ENTRA_APP" --query '[0].appId' -o tsv 2>/dev/null) && [[ -n "$app" ]]; then
  ok "az can read $ENTRA_APP ($app): github.sh --repos --apply-azure can update its subjects"
else
  todo "az cannot read $ENTRA_APP here: github.sh --repos prints the az commands to run elsewhere"
fi

if ((FAILED)); then say $'\npreflight: NOT ready'; else say $'\npreflight: ready'; fi
exit "$FAILED"
