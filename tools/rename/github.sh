#!/usr/bin/env bash
# The GitHub half of the Orrery cutover. See tools/rename/README.md.
#
#   tools/rename/github.sh --repos [--apply-azure] [--dry-run]
#   tools/rename/github.sh --settings [--dry-run]
#
# --repos renames, never deletes. First Casey's private placeholders move out of the way
# (Orrery -> Orrery-placeholder, Orrery-Infra -> Orrery-Infra-placeholder), then
# Project_Orca -> Orrery and Project_Orca_Infra -> Orrery-Infra. GitHub redirects the old names.
# Right after the infra rename it updates the Entra app's federated credentials: GitHub's OIDC
# subject carries the repository NAME beside its ids, so CI's Azure sign-in fails until the
# subject names the new repository. It prints the `az` commands; --apply-azure runs them.
#
# --settings sets the description, homepage and topics of Orrery, and copies every Actions
# variable ORCA_X to ORRERY_X (repository and environment variables, both repositories). It
# copies: the old variables stay, because workflows read `vars.ORRERY_X || vars.ORCA_X` for one
# release.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=cutover-lib.sh
. "$here/cutover-lib.sh"

DESCRIPTION="Orrery: orchestration for coding agents. A workflow engine above AI-SDLC agent steps, passing artifacts between agents over ACP."
HOMEPAGE="https://docs.orrery-control.dev"
TOPICS='["orrery","ai-agents","coding-agents","workflow-engine","acp","electron","typescript"]'

usage() {
  say "usage: github.sh --repos [--apply-azure] [--dry-run] | --settings [--dry-run]"
  exit 2
}

# rename_repo OLD NEW PLACEHOLDER: OLD -> NEW, moving an unrelated NEW out of the way first.
rename_repo() {
  local old="$1" new="$2" placeholder="$3" real occupant
  step "$OWNER/$old -> $OWNER/$new"
  # The old name resolves to the real repository before the rename and redirects to it after.
  real=$(ghq "repos/$OWNER/$old") || die "$OWNER/$old not found"
  if [[ "$(jq -r .name <<<"$real")" == "$new" ]]; then
    ok "already renamed ($OWNER/$old redirects to $OWNER/$new)"
    return 0
  fi
  local real_id
  real_id=$(jq -r .id <<<"$real")
  if occupant=$(ghq "repos/$OWNER/$new"); then
    if [[ "$(jq -r .id <<<"$occupant")" == "$real_id" ]]; then
      ok "already renamed"
      return 0
    fi
    [[ "$(jq -r .private <<<"$occupant")" == "true" ]] || die "$OWNER/$new is public and not the placeholder; stopping"
    ghq "repos/$OWNER/$placeholder" >/dev/null && die "$OWNER/$placeholder already exists; move it by hand first"
    change "rename the placeholder $OWNER/$new -> $OWNER/$placeholder" -- \
      gh api -X PATCH "repos/$OWNER/$new" -f name="$placeholder" --silent
    record repo-rename "$(jq -cn --arg from "$new" --arg to "$placeholder" --arg id "$(jq -r .id <<<"$occupant")" \
      --arg owner "$OWNER" '{owner: $owner, from: $from, to: $to, id: $id}')"
  fi
  change "rename $OWNER/$old -> $OWNER/$new" -- gh api -X PATCH "repos/$OWNER/$old" -f name="$new" --silent
  record repo-rename "$(jq -cn --arg from "$old" --arg to "$new" --arg id "$real_id" \
    --arg owner "$OWNER" '{owner: $owner, from: $from, to: $to, id: $id}')"
}

# The Entra app's federated credentials whose subject names an old repository, pointed at the
# new name. Ids are looked up, never written down.
federated_credentials() {
  step "Entra app $ENTRA_APP: federated credential subjects"
  if ! command -v az >/dev/null; then
    todo "az is not installed here. Run, signed in to the tenant:"
    say "        az ad app list --display-name $ENTRA_APP --query '[].appId' -o tsv"
    say "        az ad app federated-credential list --id <appId>"
    say "        az ad app federated-credential update --id <appId> --federated-credential-id <id> \\"
    say "          --parameters '{\"subject\": \"<subject with /$OLD_INFRA@ -> /$NEW_INFRA@, /$OLD_REPO@ -> /$NEW_REPO@>\"}'"
    return 0
  fi
  local app credentials
  app=$(az ad app list --display-name "$ENTRA_APP" --query '[0].appId' -o tsv)
  [[ -n "$app" ]] || die "Entra app $ENTRA_APP not found (az login to the right tenant?)"
  credentials=$(az ad app federated-credential list --id "$app" -o json)
  local count
  count=$(jq length <<<"$credentials")
  for ((i = 0; i < count; i++)); do
    local credential id name subject next
    credential=$(jq -c ".[$i]" <<<"$credentials")
    id=$(jq -r .id <<<"$credential")
    name=$(jq -r .name <<<"$credential")
    subject=$(jq -r .subject <<<"$credential")
    # repo:OWNER[@id]/NAME[@id]:... ; the infra name first, it contains the other.
    next=$(sed -E "s#/$OLD_INFRA([@:])#/$NEW_INFRA\\1#; s#/$OLD_REPO([@:])#/$NEW_REPO\\1#" <<<"$subject")
    if [[ "$next" == "$subject" ]]; then
      ok "$name: $subject"
      continue
    fi
    local parameters
    parameters=$(jq -c --arg subject "$next" '{name, issuer, subject: $subject, audiences, description}
      | with_entries(select(.value != null))' <<<"$credential")
    if ((APPLY_AZURE)); then
      change "point $name at $next" -- az ad app federated-credential update --id "$app" \
        --federated-credential-id "$id" --parameters "$parameters"
      record azure-subject "$(jq -cn --arg app "$app" --arg id "$id" --arg before "$subject" --arg after "$next" \
        '{app: $app, credential: $id, before: $before, after: $after}')"
    else
      todo "$name still names the old repository. Run (or rerun with --apply-azure):"
      say "        az ad app federated-credential update --id $app --federated-credential-id $id --parameters '$parameters'"
    fi
  done
}

# copy_variables REPO: ORCA_X -> ORRERY_X, repository and environment variables, never deleting.
copy_variables() {
  local repo="$1" scope path list envs
  envs=$(ghq "repos/$OWNER/$repo/environments" | jq -r '.environments[]?.name') || envs=""
  for scope in "" $envs; do
    if [[ -z "$scope" ]]; then path="repos/$OWNER/$repo/actions/variables"; else path="repos/$OWNER/$repo/environments/$scope/variables"; fi
    list=$(ghq "$path?per_page=100") || {
      bad "cannot read the variables of $repo${scope:+ ($scope)}"
      continue
    }
    while IFS=$'\t' read -r name value; do
      [[ -n "$name" ]] || continue
      local target="ORRERY_${name#ORCA_}" existing
      existing=$(jq -r --arg n "$target" '.variables[] | select(.name == $n) | .value' <<<"$list")
      if [[ "$existing" == "$value" ]]; then
        ok "$repo${scope:+ ($scope)}: $target = $name"
      elif [[ -n "$existing" ]]; then
        bad "$repo${scope:+ ($scope)}: $target exists with another value than $name; left as it is"
      else
        change "copy $repo${scope:+ ($scope)} $name -> $target" -- \
          gh api -X POST "$path" -f name="$target" -f value="$value" --silent
        record variable-created "$(jq -cn --arg path "$path" --arg name "$target" '{path: $path, name: $name}')"
      fi
    done < <(jq -r '.variables[] | select(.name | startswith("ORCA_")) | [.name, .value] | @tsv' <<<"$list")
  done
}

settings() {
  local repo
  repo=$(ghq "repos/$OWNER/$NEW_REPO") || die "$OWNER/$NEW_REPO not found: run --repos first"
  [[ "$(jq -r .id <<<"$repo")" == "$(ghq "repos/$OWNER/$OLD_REPO" | jq -r .id)" ]] ||
    die "$OWNER/$NEW_REPO is not the renamed $OLD_REPO: run --repos first"
  step "$OWNER/$NEW_REPO: description, homepage, topics"
  local before_topics
  before_topics=$(ghq "repos/$OWNER/$NEW_REPO/topics" | jq -c '.names // []')
  if [[ "$(jq -r .description <<<"$repo")" == "$DESCRIPTION" && "$(jq -r .homepage <<<"$repo")" == "$HOMEPAGE" ]]; then
    ok "description and homepage"
  else
    change "set the description and homepage" -- \
      gh api -X PATCH "repos/$OWNER/$NEW_REPO" -f description="$DESCRIPTION" -f homepage="$HOMEPAGE" --silent
    record repo-settings "$(jq -c '{repo: .name, description, homepage}' <<<"$repo")"
  fi
  if [[ "$(jq -c 'sort' <<<"$before_topics")" == "$(jq -c 'sort' <<<"$TOPICS")" ]]; then
    ok "topics"
  else
    local topics
    topics=$(mktemp)
    jq -cn --argjson names "$TOPICS" '{names: $names}' >"$topics"
    change "set the topics to $TOPICS" -- gh api -X PUT "repos/$OWNER/$NEW_REPO/topics" --input "$topics" --silent
    rm -f "$topics"
    record repo-topics "$(jq -cn --arg repo "$NEW_REPO" --argjson names "$before_topics" '{repo: $repo, names: $names}')"
  fi
  step "Actions variables ORCA_* -> ORRERY_*"
  copy_variables "$NEW_REPO"
  copy_variables "$NEW_INFRA"
}

MODE=""
APPLY_AZURE=0
parse_common "$@"
for arg in "${REST[@]}"; do
  case "$arg" in
    --repos | --settings) MODE="$arg" ;;
    --apply-azure) APPLY_AZURE=1 ;;
    *) usage ;;
  esac
done
case "$MODE" in
  --repos)
    rename_repo "$OLD_REPO" "$NEW_REPO" "$NEW_REPO-placeholder"
    rename_repo "$OLD_INFRA" "$NEW_INFRA" "$NEW_INFRA-placeholder"
    federated_credentials
    ;;
  --settings) settings ;;
  *) usage ;;
esac
((DRY_RUN)) && say $'\n(dry run: nothing was changed)'
exit "$FAILED"
