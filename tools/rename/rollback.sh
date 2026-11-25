#!/usr/bin/env bash
# Undoes what the cutover scripts logged, newest first. See tools/rename/README.md.
#
#   tools/rename/rollback.sh [--dry-run] [--log FILE]
#
# Reads the cutover log (CUTOVER_LOG or --log, default ./cutover-log.json): one JSON object per
# line, written by github.sh, cloudflare.sh and relink-clones.sh as they changed things. Each
# record is undone in reverse order, and moved to FILE.undone once it is, so a rerun continues
# where an interrupted one stopped and never undoes anything twice.
#
#   repo-rename               the repository renamed back (placeholders included)
#   repo-settings/-topics     the description, homepage and topics put back
#   variable-created          the ORRERY_ copy deleted (the ORCA_ original was never touched)
#   azure-subject             the federated credential's subject put back
#   cf-*                      the DNS record, Pages domain or project or redirect rule the
#                             cutover created, deleted (the feed's Worker domain is Terraform's)
#   remote-url                a clone's remote URL put back
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=cutover-lib.sh
. "$here/cutover-lib.sh"

parse_common "$@"
set -- "${REST[@]+"${REST[@]}"}"
while (($#)); do
  case "$1" in
    --log)
      CUTOVER_LOG="${2:?--log needs a file}"
      shift 2
      ;;
    *) die "usage: rollback.sh [--dry-run] [--log FILE]" ;;
  esac
done
[[ -s "$CUTOVER_LOG" ]] || {
  say "nothing to roll back: $CUTOVER_LOG is empty or missing"
  exit 0
}

undo() {
  local r="$1" kind
  kind=$(jq -r .kind <<<"$r")
  f() { jq -r ".$1" <<<"$r"; }
  case "$kind" in
    repo-rename)
      change "rename $(f owner)/$(f to) back to $(f from)" -- gh api -X PATCH "repos/$(f owner)/$(f to)" -f name="$(f from)" --silent
      ;;
    repo-settings)
      change "restore the description and homepage of $(f repo)" -- gh api -X PATCH "repos/$OWNER/$(f repo)" \
        -f description="$(f description)" -f homepage="$(f homepage)" --silent
      ;;
    repo-topics)
      local topics
      topics=$(mktemp)
      jq -c '{names}' <<<"$r" >"$topics"
      change "restore the topics of $(f repo) to $(jq -c .names <<<"$r")" -- \
        gh api -X PUT "repos/$OWNER/$(f repo)/topics" --input "$topics" --silent
      rm -f "$topics"
      ;;
    variable-created)
      change "delete $(f name) ($(f path))" -- gh api -X DELETE "$(f path)/$(f name)" --silent
      ;;
    azure-subject)
      change "point federated credential $(f credential) back at $(f before)" -- az ad app federated-credential update \
        --id "$(f app)" --federated-credential-id "$(f credential)" --parameters "$(jq -cn --arg s "$(f before)" '{subject: $s}')"
      ;;
    cf-dns-created)
      change "delete DNS $(f name)" -- cf DELETE "/zones/$(f zone)/dns_records/$(f id)"
      ;;
    cf-pages-domain-created)
      change "unbind $(f name) from $(f project)" -- cf DELETE "/accounts/$(f account)/pages/projects/$(f project)/domains/$(f name)"
      ;;
    cf-pages-project-created)
      change "delete the Pages project $(f name)" -- cf DELETE "/accounts/$(f account)/pages/projects/$(f name)"
      ;;
    cf-redirect-rule-added)
      local entry body
      entry=$(cf GET "/zones/$(f zone)/rulesets/phases/http_request_dynamic_redirect/entrypoint")
      body=$(jq -c --arg ref "$(f ref)" '{rules: [.result.rules[] | select(.ref != $ref) | del(.id, .version, .last_updated)]}' <<<"$entry")
      change "remove the redirect rule $(f ref)" -- cf PUT "/zones/$(f zone)/rulesets/phases/http_request_dynamic_redirect/entrypoint" "$body"
      ;;
    remote-url)
      change "point $(f clone) $(f remote) back at $(f before)" -- git -C "$(f clone)" config --fixed-value --replace-all "remote.$(f remote).url" "$(f before)" "$(f after)"
      ;;
    *) die "unknown record kind $kind; stopping before it" ;;
  esac
}

mapfile -t records <"$CUTOVER_LOG"
for ((i = ${#records[@]} - 1; i >= 0; i--)); do
  [[ -n "${records[i]}" ]] || continue
  undo "${records[i]}"
  if ((!DRY_RUN)); then
    printf '%s\n' "${records[i]}" >>"$CUTOVER_LOG.undone"
    # Drop the record just undone, so a rerun does not undo it again.
    printf '%s\n' "${records[@]:0:i}" | sed '/^$/d' >"$CUTOVER_LOG.tmp"
    mv "$CUTOVER_LOG.tmp" "$CUTOVER_LOG"
  fi
done
((DRY_RUN)) && say $'\n(dry run: nothing was changed)'
exit 0
