#!/usr/bin/env bash
# Checks after the Orrery cutover. See tools/rename/README.md.
#
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... tools/rename/verify.sh [--dry-run] [--no-infra-dispatch]
#
# 1. The repositories are renamed, the old names redirect to them, the placeholders are aside.
# 2. Orrery's description, homepage and topics; every ORCA_X variable has its ORRERY_X copy.
# 3. The Pages project and docs.orrery-control.dev are active and the docs answer.
# 4. orrery-control.com and www redirect to https://docs.orrery-control.dev.
# 5. feed.orrery-control.com is the feed Worker: an anonymous request gets its 401 and realm.
# 6. An Infrastructure dispatch on Orrery-Infra signs in to Azure: the federated credential
#    names the new repository. This dispatches infra.yml on main (a guarded plan and apply,
#    as any dispatch is) and waits for its "Plan and apply" step. --dry-run prints the dispatch
#    instead; --no-infra-dispatch skips it.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=cutover-lib.sh
. "$here/cutover-lib.sh"

DISPATCH=1
parse_common "$@"
for arg in "${REST[@]+"${REST[@]}"}"; do
  case "$arg" in
    --no-infra-dispatch) DISPATCH=0 ;;
    *) die "usage: verify.sh [--dry-run] [--no-infra-dispatch]" ;;
  esac
done

step "GitHub: repositories"
for pair in "$OLD_REPO:$NEW_REPO" "$OLD_INFRA:$NEW_INFRA"; do
  old="${pair%%:*}" new="${pair#*:}"
  real=$(ghq "repos/$OWNER/$new") || {
    bad "$OWNER/$new not found"
    continue
  }
  via_old=$(ghq "repos/$OWNER/$old" | jq -r .id) || via_old=""
  [[ "$via_old" == "$(jq -r .id <<<"$real")" ]] && ok "$old redirects to $new" || bad "$OWNER/$old does not resolve to $OWNER/$new"
  ghq "repos/$OWNER/$new-placeholder" >/dev/null && ok "$new-placeholder kept" || say "  note  no $new-placeholder (there was none to move?)"
done

step "GitHub: Orrery settings and variables"
if repo=$(ghq "repos/$OWNER/$NEW_REPO"); then
  [[ "$(jq -r .homepage <<<"$repo")" == "https://$DOCS_HOST" ]] && ok "homepage" || bad "homepage is $(jq -r .homepage <<<"$repo")"
  ghq "repos/$OWNER/$NEW_REPO/topics" | jq -e '.names | index("orrery")' >/dev/null && ok "topics" || bad "topics lack orrery"
fi
for repo in "$NEW_REPO" "$NEW_INFRA"; do
  vars=$(ghq "repos/$OWNER/$repo/actions/variables?per_page=100") || continue
  missing=$(jq -r '[.variables[].name] as $n | $n[] | select(startswith("ORCA_")) | select(("ORRERY_" + ltrimstr("ORCA_")) as $t | $n | index($t) | not)' <<<"$vars")
  [[ -z "$missing" ]] && ok "$repo: every ORCA_ variable has its ORRERY_ copy" || bad "$repo: no ORRERY_ copy of $(tr '\n' ' ' <<<"$missing")"
done

step "Cloudflare: docs"
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  domain=$(cf GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PAGES_PROJECT/domains/$DOCS_HOST" | jq -r .result.status) || domain=""
  [[ "$domain" == "active" ]] && ok "$DOCS_HOST active on $PAGES_PROJECT" || bad "$DOCS_HOST on $PAGES_PROJECT is ${domain:-missing}"
else
  todo "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set: Pages domain not checked"
fi
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOCS_HOST/") || code=000
[[ "$code" == "200" ]] && ok "https://$DOCS_HOST answers 200" || bad "https://$DOCS_HOST answers $code"

step "Redirects"
for host in "$SITE_ZONE" "www.$SITE_ZONE"; do
  answer=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "https://$host/") || answer="000"
  [[ "$answer" == "301 https://$DOCS_HOST"* ]] && ok "$host -> $DOCS_HOST" || bad "$host answers $answer"
done

step "Feed"
headers=$(curl -s -D - -o /dev/null "https://$FEED_HOST/latest-x64.yml") || headers=""
if grep -qi '^HTTP/[0-9.]* 401' <<<"$headers" && grep -Eqi 'www-authenticate: Bearer realm="(orca|orrery)-feed"' <<<"$headers"; then
  ok "$FEED_HOST is the feed Worker (401 with its realm)"
else
  bad "$FEED_HOST does not answer as the feed Worker: $(head -n 1 <<<"$headers")"
fi

step "Azure sign-in from Orrery-Infra"
if ((!DISPATCH)); then
  todo "skipped (--no-infra-dispatch): dispatch Infrastructure on $NEW_INFRA and check its Plan and apply step"
elif ((DRY_RUN)); then
  say "  would dispatch infra.yml on $OWNER/$NEW_INFRA main and wait for its Plan and apply step"
  say "        \$ gh workflow run infra.yml --repo $OWNER/$NEW_INFRA --ref main"
else
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run infra.yml --repo "$OWNER/$NEW_INFRA" --ref main
  run=""
  for _ in $(seq 30); do
    run=$(gh run list --repo "$OWNER/$NEW_INFRA" --workflow infra.yml --event workflow_dispatch --limit 5 \
      --json databaseId,createdAt | jq -r --arg since "$since" '[.[] | select(.createdAt >= $since)][0].databaseId // empty')
    [[ -n "$run" ]] && break
    sleep "${VERIFY_POLL_SECONDS:-5}"
  done
  if [[ -z "$run" ]]; then
    bad "the Infrastructure dispatch did not start"
  else
    gh run watch "$run" --repo "$OWNER/$NEW_INFRA" --exit-status >/dev/null 2>&1 || true
    step_result=$(gh run view "$run" --repo "$OWNER/$NEW_INFRA" --json jobs |
      jq -r '[.jobs[].steps[]? | select(.name | startswith("Plan and apply"))][0].conclusion // "missing"')
    [[ "$step_result" == "success" ]] && ok "run $run signed in and applied" ||
      bad "run $run: Plan and apply is $step_result (federated credential subject? github.sh --repos --apply-azure)"
  fi
fi

if ((FAILED)); then say $'\nverify: NOT complete'; else say $'\nverify: complete'; fi
exit "$FAILED"
