#!/usr/bin/env bash
# The work of .github/workflows/feature-sync.yml: for each origin `feature/*` branch, merge main
# into `feature-sync/<name>` and keep one pull request open for it; merge that pull request once
# its head is current and every check on it passed; report a conflict on one `sync-conflict`
# issue per branch. Run from main's checkout with every branch fetched.
# Environment: GH_TOKEN, REPO, GITHUB_STEP_SUMMARY.
set -euo pipefail
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
summary() { echo "$*" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"; }
gh label create sync-conflict --repo "$REPO" --force --color d93f0b \
  --description "main does not merge cleanly into a feature branch" >/dev/null 2>&1 || true

git fetch -q --prune origin '+refs/heads/*:refs/remotes/origin/*'
main=$(git rev-parse refs/remotes/origin/main)
mapfile -t branches < <(git for-each-ref --format='%(refname:lstrip=4)' 'refs/remotes/origin/feature/')

# conflict_issue NAME: the open sync-conflict issue for feature/NAME, or empty.
conflict_issue() {
  gh issue list --repo "$REPO" --state open --label sync-conflict --search "\"feature/$1\" in:title" \
    --json number,title --jq ".[] | select(.title == \"Sync conflict: feature/$1\") | .number" | head -n 1
}

for name in "${branches[@]}"; do
  [ -n "$name" ] || continue
  feature="feature/$name"
  sync="feature-sync/$name"
  head=$(git rev-parse "refs/remotes/origin/$feature")
  if git merge-base --is-ancestor "$main" "$head"; then
    summary "$feature already contains main."
    issue=$(conflict_issue "$name")
    [ -z "$issue" ] || gh issue close "$issue" --repo "$REPO" --comment "$feature now contains main." >/dev/null
    continue
  fi

  # An open sync pull request at a still-current head: merge it once every check passed.
  read -r pr pr_head < <(gh pr list --repo "$REPO" --state open --base "$feature" --head "$sync" \
    --json number,headRefOid --jq '.[0] | "\(.number // "") \(.headRefOid // "")"') || true
  if [ -n "${pr:-}" ] && git cat-file -e "$pr_head^{commit}" 2>/dev/null &&
    git merge-base --is-ancestor "$head" "$pr_head" && git merge-base --is-ancestor "$main" "$pr_head"; then
    verdict=$(gh api "repos/$REPO/commits/$pr_head/check-runs?per_page=100" --jq '
      [.check_runs[] | .conclusion // "pending"] as $c
      | if ($c | length) == 0 or ($c | index("pending")) then "pending"
        elif ($c | all(. == "success" or . == "neutral" or . == "skipped")) then "green"
        else "failing" end')
    case "$verdict" in
      green)
        gh pr merge "$pr" --repo "$REPO" --merge --match-head-commit "$pr_head" >/dev/null
        summary "$feature: merged sync #$pr." ;;
      pending) summary "$feature: sync #$pr is waiting for its checks." ;;
      *) summary "$feature: sync #$pr has failing checks; its owner looks at it." ;;
    esac
    continue
  fi

  git checkout -q -B "$sync" "$head"
  if ! git merge -q --no-ff --no-edit -m "sync: merge main into $feature" "$main" >/dev/null 2>&1; then
    files=$(git diff --name-only --diff-filter=U | sed 's/^/- `/; s/$/`/')
    git merge --abort || true
    body=$(printf 'main (`%s`) does not merge cleanly into `%s` (`%s`). Conflicting files:\n\n%s\n\nThe workstream owner merges main into the branch by hand (a pull request into `%s`); the next clean nightly sync closes this issue.' \
      "$main" "$feature" "$head" "${files:-- (none listed)}" "$feature")
    issue=$(conflict_issue "$name")
    if [ -n "$issue" ]; then
      gh issue comment "$issue" --repo "$REPO" --body "$body" >/dev/null
    else
      gh issue create --repo "$REPO" --title "Sync conflict: $feature" --label sync-conflict --body "$body" >/dev/null
    fi
    summary "$feature: main conflicts; reported."
    continue
  fi
  # The sync branch is the bot's own and is rebuilt from the feature head every time.
  git push -q -f origin "HEAD:refs/heads/$sync"
  if [ -z "${pr:-}" ]; then
    gh pr create --repo "$REPO" --base "$feature" --head "$sync" --label no-changelog \
      --title "sync: merge main into $feature" \
      --body "Merges main (\`$main\`) into \`$feature\` so the workstream stays current. Opened by the Feature sync workflow, which merges it with a merge commit once its checks pass. Nothing else changes." >/dev/null
    summary "$feature: opened a sync pull request."
  else
    summary "$feature: refreshed sync #$pr."
  fi
  issue=$(conflict_issue "$name")
  [ -z "$issue" ] || gh issue close "$issue" --repo "$REPO" --comment "main merges cleanly into $feature again." >/dev/null
done
