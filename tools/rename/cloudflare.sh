#!/usr/bin/env bash
# The Cloudflare half of the Orrery cutover. See tools/rename/README.md.
#
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... tools/rename/cloudflare.sh [--dry-run]
#
# 1. The Pages project orrery-docs (production branch main), if there is none.
# 2. docs.orrery-control.dev bound to it as a custom domain, with its CNAME to
#    orrery-docs.pages.dev in the orrery-control.dev zone.
# 3. orrery-control.com and www.orrery-control.com redirected (301) to https://docs.orrery-control.dev,
#    by one single-redirect rule in the zone's dynamic redirect ruleset, over proxied placeholder
#    records for the two names (192.0.2.1 / 100::, the documented "originless" addresses).
# 4. feed.orrery-control.com attached to the feed Worker (orca-desktop-feed) as a Workers custom
#    domain, which creates its DNS record. If Orrery-Infra's FEED_DOMAIN_HOSTNAME variable names
#    this host, Terraform owns the domain and this step only checks it.
#
# Every step reads first and changes only what is missing; each change is logged for rollback.sh.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=cutover-lib.sh
. "$here/cutover-lib.sh"

RULE_REF="orrery_cutover_site_to_docs"

parse_common "$@"
((${#REST[@]} == 0)) || die "usage: cloudflare.sh [--dry-run]"
ACCOUNT=$(account_id)
DOCS_ZONE_ID=$(zone_id "$DOCS_ZONE")
SITE_ZONE_ID=$(zone_id "$SITE_ZONE")
[[ -n "$DOCS_ZONE_ID" ]] || die "zone $DOCS_ZONE not found for this token"
[[ -n "$SITE_ZONE_ID" ]] || die "zone $SITE_ZONE not found for this token"

# dns_record ZONE_ID NAME TYPE CONTENT PROXIED: creates it unless a record of that name exists.
dns_record() {
  local zone="$1" name="$2" type="$3" content="$4" proxied="$5" found
  found=$(cf GET "/zones/$zone/dns_records?name=$name" | jq -c '.result')
  if [[ "$(jq length <<<"$found")" -gt 0 ]]; then
    if jq -e --arg t "$type" --arg c "$content" 'any(.type == $t and .content == $c)' >/dev/null <<<"$found"; then
      ok "DNS $type $name -> $content"
    else
      bad "DNS $name exists as $(jq -r 'map(.type + " " + .content) | join(", ")' <<<"$found"); left as it is"
    fi
    return 0
  fi
  local body
  body=$(jq -cn --arg t "$type" --arg n "$name" --arg c "$content" --argjson p "$proxied" \
    '{type: $t, name: $n, content: $c, proxied: $p, ttl: 1, comment: "Orrery cutover (tools/rename/cloudflare.sh)"}')
  if ((DRY_RUN)); then
    change "create DNS $type $name -> $content" -- cf POST "/zones/$zone/dns_records" "$body"
    return 0
  fi
  local out
  out=$(change "create DNS $type $name -> $content" -- cf POST "/zones/$zone/dns_records" "$body")
  record cf-dns-created "$(jq -c --arg zone "$zone" '{zone: $zone, id: .result.id, name: .result.name}' <<<"$out")"
}

step "Pages project $PAGES_PROJECT"
if cf GET "/accounts/$ACCOUNT/pages/projects/$PAGES_PROJECT" >/dev/null 2>&1; then
  ok "exists"
else
  body=$(jq -cn --arg n "$PAGES_PROJECT" '{name: $n, production_branch: "main"}')
  change "create the Pages project $PAGES_PROJECT" -- cf POST "/accounts/$ACCOUNT/pages/projects" "$body" >/dev/null
  record cf-pages-project-created "$(jq -cn --arg a "$ACCOUNT" --arg n "$PAGES_PROJECT" '{account: $a, name: $n}')"
fi

step "Custom domain $DOCS_HOST"
if cf GET "/accounts/$ACCOUNT/pages/projects/$PAGES_PROJECT/domains/$DOCS_HOST" >/dev/null 2>&1; then
  ok "bound to $PAGES_PROJECT"
else
  change "bind $DOCS_HOST to $PAGES_PROJECT" -- \
    cf POST "/accounts/$ACCOUNT/pages/projects/$PAGES_PROJECT/domains" "$(jq -cn --arg n "$DOCS_HOST" '{name: $n}')" >/dev/null
  record cf-pages-domain-created "$(jq -cn --arg a "$ACCOUNT" --arg p "$PAGES_PROJECT" --arg n "$DOCS_HOST" \
    '{account: $a, project: $p, name: $n}')"
fi
dns_record "$DOCS_ZONE_ID" "$DOCS_HOST" CNAME "$PAGES_PROJECT.pages.dev" true

step "$SITE_ZONE and www -> https://$DOCS_HOST"
dns_record "$SITE_ZONE_ID" "$SITE_ZONE" A 192.0.2.1 true
dns_record "$SITE_ZONE_ID" "www.$SITE_ZONE" A 192.0.2.1 true
entry=$(cf GET "/zones/$SITE_ZONE_ID/rulesets/phases/http_request_dynamic_redirect/entrypoint" 2>/dev/null) || entry='{}'
rules=$(jq -c '.result.rules // []' <<<"$entry")
if jq -e --arg ref "$RULE_REF" 'any(.ref == $ref)' >/dev/null <<<"$rules"; then
  ok "redirect rule $RULE_REF"
else
  rule=$(jq -cn --arg ref "$RULE_REF" --arg zone "$SITE_ZONE" --arg docs "$DOCS_HOST" '{
    ref: $ref, description: "Orrery cutover: the site moved to the docs host",
    expression: "(http.host eq \"\($zone)\") or (http.host eq \"www.\($zone)\")",
    action: "redirect",
    action_parameters: {from_value: {status_code: 301, preserve_query_string: false,
      target_url: {value: "https://\($docs)"}}}}')
  # PUT on the entrypoint replaces its rules: the existing ones are kept, ours appended.
  body=$(jq -cn --argjson rules "$rules" --argjson rule "$rule" '{rules: ($rules | map(del(.id, .version, .last_updated)) + [$rule])}')
  change "add the redirect rule $RULE_REF" -- \
    cf PUT "/zones/$SITE_ZONE_ID/rulesets/phases/http_request_dynamic_redirect/entrypoint" "$body" >/dev/null
  record cf-redirect-rule-added "$(jq -cn --arg zone "$SITE_ZONE_ID" --arg ref "$RULE_REF" '{zone: $zone, ref: $ref}')"
fi

step "$FEED_HOST -> Worker $FEED_WORKER"
domains=$(cf GET "/accounts/$ACCOUNT/workers/domains?hostname=$FEED_HOST" | jq -c '.result // []')
if jq -e --arg w "$FEED_WORKER" 'any(.service == $w)' >/dev/null <<<"$domains"; then
  ok "attached"
elif [[ "$(jq length <<<"$domains")" -gt 0 ]]; then
  bad "$FEED_HOST is attached to $(jq -r '.[0].service' <<<"$domains"), not $FEED_WORKER; left as it is"
elif [[ "$(ghq "repos/$OWNER/$NEW_INFRA/environments/production/variables/FEED_DOMAIN_HOSTNAME" | jq -r '.value // empty' 2>/dev/null)" == "$FEED_HOST" ]]; then
  todo "Orrery-Infra's Terraform owns $FEED_HOST (FEED_DOMAIN_HOSTNAME): dispatch Infrastructure to attach it"
else
  body=$(jq -cn --arg h "$FEED_HOST" --arg w "$FEED_WORKER" --arg z "$SITE_ZONE_ID" \
    '{hostname: $h, service: $w, zone_id: $z, environment: "production"}')
  change "attach $FEED_HOST to $FEED_WORKER" -- cf PUT "/accounts/$ACCOUNT/workers/domains" "$body" >/dev/null
  record cf-worker-domain-created "$(jq -cn --arg a "$ACCOUNT" --arg h "$FEED_HOST" '{account: $a, hostname: $h}')"
fi

((DRY_RUN)) && say $'\n(dry run: nothing was changed)'
exit "$FAILED"
