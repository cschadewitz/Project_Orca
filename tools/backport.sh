#!/usr/bin/env bash
# The git half of .github/workflows/backport.yml (tools/backport.js holds the rules). For each
# `backport:X.Y` line this run is for, cherry-pick MERGE_SHA onto release/X.Y in the branch
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

# A merge commit is picked against its first parent; a squash or rebase merge as it is.
parents=$(git rev-list --parents -n 1 "$MERGE_SHA" | wc -w)
pick=(-x)
[ "$parents" -gt 2 ] && pick+=(-m 1)

for line in "${lines[@]}"; do
  base="release/$line"
  branch="backport/$NUMBER-$line"
  if ! git ls-remote --exit-code --heads origin "$base" >/dev/null; then
    gh pr comment "$NUMBER" --repo "$REPO" --body "Backport to \`$base\` skipped: that line does not exist."
    gh pr edit "$NUMBER" --repo "$REPO" --add-label backport-conflict
    continue
  fi
  if git ls-remote --exit-code --heads origin "$branch" >/dev/null; then
    echo "$branch already exists; skipped." | tee -a "$GITHUB_STEP_SUMMARY"
    continue
  fi
  git fetch -q origin "$base"
  git checkout -q -B "$branch" "refs/remotes/origin/$base"
  if ! git cherry-pick "${pick[@]}" "$MERGE_SHA" >/dev/null 2>&1; then
    files=$(git diff --name-only --diff-filter=U | sed 's/^/- `/; s/$/`/')
    git cherry-pick --abort || true
    gh pr comment "$NUMBER" --repo "$REPO" --body "$(printf 'The automatic backport to `%s` did not apply cleanly. Conflicting files:\n\n%s\n\nCherry-pick %s onto `%s` by hand (`git cherry-pick -x`), naming the fixed issue and `Backport of #%s` in the description.' "$base" "${files:-- (none listed)}" "$MERGE_SHA" "$base" "$NUMBER")"
    gh pr edit "$NUMBER" --repo "$REPO" --add-label backport-conflict
    echo "::warning::backport of #$NUMBER to $base conflicted"
    continue
  fi
  git push -q origin "HEAD:refs/heads/$branch"
  node tools/backport.js body "$GITHUB_EVENT_PATH" "$line" > "$RUNNER_TEMP/backport-body.md"
  url=$(gh pr create --repo "$REPO" --base "$base" --head "$branch" \
    --title "[$line] $TITLE" --body-file "$RUNNER_TEMP/backport-body.md")
  gh pr edit "$url" --repo "$REPO" --add-reviewer calciferschadewitz || true
  gh pr comment "$url" --repo "$REPO" --body "@calciferschadewitz please review this automatic backport of #$NUMBER to \`$base\`." || true
  echo "Opened $url for $base." | tee -a "$GITHUB_STEP_SUMMARY"
done
