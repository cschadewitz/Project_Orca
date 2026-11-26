#!/usr/bin/env bash
# The git half of .github/workflows/backport.yml (tools/backport.js holds the rules). For each
# `backport:X.Y` line this run is for, cherry-pick the pull request's complete change on main
# (MERGE_SHA, or the rebase-merged range ending there) onto release/X.Y in the branch
# backport/NUMBER-X.Y and open a pull request into the line; on a conflict, say so on the
# original pull request instead. Environment: GH_TOKEN, REPO, ACTION, ADDED, NUMBER, TITLE,
# MERGE_SHA, GITHUB_EVENT_PATH, GITHUB_STEP_SUMMARY.
set -euo pipefail
[[ "$MERGE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::no merge commit"; exit 1; }
[[ "$NUMBER" =~ ^[0-9]+$ ]] || { echo "::error::no pull request number"; exit 1; }
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

mapfile -t lines < <(node tools/backport.js lines "$GITHUB_EVENT_PATH")
if [ "$ACTION" = labeled ]; then
  # Only the label just added: the others were handled when they were added or at the merge.
  want=${ADDED#backport:}
  mapfile -t lines < <(printf '%s\n' "${lines[@]}" | grep -Fx -- "$want" || true)
fi
[ ${#lines[@]} -gt 0 ] || { echo "No backport label to act on."; exit 0; }

gh label create backport-conflict --repo "$REPO" --force --color d93f0b \
  --description "The automatic backport did not apply; backport by hand" >/dev/null || true

. "$(dirname "$0")/backport-change.sh"

# The complete change #NUMBER made on main, or nothing. A merge commit is picked against its
# first parent, which holds all of it. A single-parent MERGE_SHA is either a squash (one commit)
# or the last of a rebase merge's COMMITS commits; GitHub does not say which, so take the range
# whose combined change is byte for byte the pull request's own change at the head the merge
# recorded (whitespace included; only line numbers and blob ids may differ), and refuse when
# neither is, rather than pick part of it or something else.
pick=(-x)
if [ "$(git rev-list --parents -n 1 "$MERGE_SHA" | wc -w)" -gt 2 ]; then
  pick+=(-m 1)
  range=("$MERGE_SHA")
  expected=("$MERGE_SHA")
else
  commits=$(jq -r '.pull_request.commits // 0' "$GITHUB_EVENT_PATH")
  recorded=$(jq -r '.pull_request.head.sha // ""' "$GITHUB_EVENT_PATH")
  git fetch -q origin "+refs/pull/$NUMBER/head:refs/backport/pr-head"
  # Compare against the head this merge recorded, not whatever the ref says now.
  if [[ ! "$recorded" =~ ^[0-9a-f]{40}$ ]] || [ "$(git rev-parse refs/backport/pr-head)" != "$recorded" ]; then
    want=""
  else
    fork=$(git merge-base "$recorded" "$MERGE_SHA")
    want=$(change_of "$fork" "$recorded")
  fi
  range=()
  for k in 1 "$commits"; do
    [[ "$k" =~ ^[1-9][0-9]*$ ]] || continue
    mapfile -t candidates < <(git rev-list --first-parent --max-count="$k" "$MERGE_SHA")
    [ ${#candidates[@]} -eq "$k" ] || continue
    linear=true
    for c in "${candidates[@]}"; do [ "$(git rev-list --parents -n 1 "$c" | wc -w)" -eq 2 ] || linear=false; done
    $linear || continue
    got=$(change_of "$MERGE_SHA~$k" "$MERGE_SHA")
    if [ -n "$want" ] && [ "$got" = "$want" ]; then
      range=("$MERGE_SHA~$k..$MERGE_SHA")
      mapfile -t expected < <(git rev-list --reverse "$MERGE_SHA~$k..$MERGE_SHA")
      break
    fi
  done
  if [ ${#range[@]} -eq 0 ]; then
    gh pr comment "$NUMBER" --repo "$REPO" --body "$(printf 'No automatic backport: the complete change of #%s on `main` could not be established (neither %s nor the last %s commit(s) on `main` are exactly the pull request'"'"'s change at the head it merged), and picking part of it would be wrong. Cherry-pick it onto %s by hand (`git cherry-pick -x`), naming the fixed issue and `Backport of #%s` in the description.' "$NUMBER" "$MERGE_SHA" "$commits" "$(printf '`release/%s` ' "${lines[@]}")" "$NUMBER")"
    gh pr edit "$NUMBER" --repo "$REPO" --add-label backport-conflict
    echo "::warning::backport of #$NUMBER refused: its complete change on main could not be established"
    exit 0
  fi
fi

for line in "${lines[@]}"; do
  base="release/$line"
  branch="backport/$NUMBER-$line"
  if ! git ls-remote --exit-code --heads origin "$base" >/dev/null; then
    gh pr comment "$NUMBER" --repo "$REPO" --body "Backport to \`$base\` skipped: that line does not exist."
    gh pr edit "$NUMBER" --repo "$REPO" --add-label backport-conflict
    continue
  fi
  existing=$(gh pr list --repo "$REPO" --head "$branch" --base "$base" --state all --json url --jq '.[0].url // ""')
  if [ -n "$existing" ]; then
    echo "$base already has backport pull request $existing; skipped." | tee -a "$GITHUB_STEP_SUMMARY"
    continue
  fi
  git fetch -q origin "$base"
  if git ls-remote --exit-code --heads origin "$branch" >/dev/null; then
    # A branch with no pull request: an earlier run pushed and then failed to open it. Resume
    # only when the branch is exactly a fresh cherry-pick onto the line's current head, commit by
    # commit (parents and trees, not just messages); never rewrite it.
    git fetch -q origin "+refs/heads/$branch:refs/backport/existing"
    line_head=$(git rev-parse "refs/remotes/origin/$base")
    mapfile -t have < <(git rev-list --reverse --first-parent "$line_head..refs/backport/existing")
    same=false
    if [ ${#have[@]} -eq ${#expected[@]} ] && [ "$(git rev-parse "${have[0]}^")" = "$line_head" ] &&
      [ "$(git rev-list --count "$line_head..refs/backport/existing")" -eq ${#have[@]} ]; then
      git checkout -q --detach "$line_head"
      if git cherry-pick "${pick[@]}" "${range[@]}" >/dev/null 2>&1; then
        mapfile -t fresh < <(git rev-list --reverse "$line_head..HEAD")
        same=true
        for i in "${!have[@]}"; do
          [ "$(git rev-list --parents -n 1 "${have[$i]}" | wc -w)" -eq 2 ] || same=false
          [ "$(git rev-parse "${have[$i]}^{tree}")" = "$(git rev-parse "${fresh[$i]}^{tree}")" ] || same=false
        done
      else
        git cherry-pick --abort >/dev/null 2>&1 || true
      fi
    fi
    if ! $same; then
      gh pr comment "$NUMBER" --repo "$REPO" --body "Backport to \`$base\` stopped: the branch \`$branch\` exists without a pull request and is not exactly a fresh cherry-pick of #$NUMBER onto \`$base\` (its contents differ, or the line has moved), so it was left as it is. Check it and open the pull request by hand, or delete the branch and re-add the \`backport:$line\` label."
      gh pr edit "$NUMBER" --repo "$REPO" --add-label backport-conflict
      echo "::warning::$branch exists but is not the expected backport"
      continue
    fi
    echo "$branch exists without a pull request; opening it." | tee -a "$GITHUB_STEP_SUMMARY"
  else
    git checkout -q -B "$branch" "refs/remotes/origin/$base"
    if ! git cherry-pick "${pick[@]}" "${range[@]}" >/dev/null 2>&1; then
      files=$(git diff --name-only --diff-filter=U | sed 's/^/- `/; s/$/`/')
      git cherry-pick --abort || true
      gh pr comment "$NUMBER" --repo "$REPO" --body "$(printf 'The automatic backport to `%s` did not apply cleanly. Conflicting files:\n\n%s\n\nCherry-pick %s onto `%s` by hand (`git cherry-pick -x`), naming the fixed issue and `Backport of #%s` in the description.' "$base" "${files:-- (none listed)}" "${range[*]}" "$base" "$NUMBER")"
      gh pr edit "$NUMBER" --repo "$REPO" --add-label backport-conflict
      echo "::warning::backport of #$NUMBER to $base conflicted"
      continue
    fi
    git push -q origin "HEAD:refs/heads/$branch"
  fi
  node tools/backport.js body "$GITHUB_EVENT_PATH" "$line" > "$RUNNER_TEMP/backport-body.md"
  url=$(gh pr create --repo "$REPO" --base "$base" --head "$branch" \
    --title "[$line] $TITLE" --body-file "$RUNNER_TEMP/backport-body.md")
  gh pr edit "$url" --repo "$REPO" --add-reviewer calciferschadewitz || true
  gh pr comment "$url" --repo "$REPO" --body "@calciferschadewitz please review this automatic backport of #$NUMBER to \`$base\`." || true
  echo "Opened $url for $base." | tee -a "$GITHUB_STEP_SUMMARY"
done
