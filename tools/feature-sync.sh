#!/usr/bin/env bash
# The work of .github/workflows/feature-sync.yml: for each origin `feature/*` branch, merge main
# into `feature-sync/<name>` and keep one pull request open for it; merge that pull request once
# its head is exactly that merge and the required CI job passed on it (and AUTO_MERGE is true); report a conflict on one `sync-conflict`
# issue per branch. Run from main's checkout with every branch fetched.
# Environment: GH_TOKEN, REPO, AUTO_MERGE, GITHUB_STEP_SUMMARY.
set -euo pipefail
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
summary() { echo "$*" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"; }
gh label create sync-conflict --repo "$REPO" --force --color d93f0b \
  --description "main does not merge cleanly into a feature branch" >/dev/null 2>&1 || true

git fetch -q --prune origin '+refs/heads/*:refs/remotes/origin/*'
main=$(git rev-parse refs/remotes/origin/main)
mapfile -t branches < <(git for-each-ref --format='%(refname:lstrip=4)' 'refs/remotes/origin/feature/')

# The CI job a sync must pass, from ci.yml, on a `pull_request` run for the sync pull request.
REQUIRED_WORKFLOW=.github/workflows/ci.yml
REQUIRED_CHECK="check (node 24)"

# ci_verdict PR SHA: "green", "pending: why" or "failing: why". Green needs positive evidence:
# the latest ci.yml pull_request run for this pull request at exactly SHA completed, and its own
# `check (node 24)` job (same check suite, GitHub Actions) succeeded; a missing, queued, skipped
# or neutral required job is not green, and no other check on SHA may have failed. CI checks out
# the pull request's merge ref; because the head already contains the feature branch, that ref's
# tree is the head's.
ci_verdict() {
  local run checks
  run=$(gh api "repos/$REPO/actions/runs?head_sha=$2&event=pull_request&per_page=100" --jq "
    [.workflow_runs[] | select(.path == \"$REQUIRED_WORKFLOW\" and .head_sha == \"$2\" and ([.pull_requests[]?.number] | index($1)))]
    | sort_by(.run_number) | last | if . == null then null else {status, conclusion, check_suite_id} end")
  checks=$(gh api "repos/$REPO/commits/$2/check-runs?per_page=100" --jq '[.check_runs[]]')
  jq -n -r --argjson run "${run:-null}" --argjson checks "${checks:-[]}" --arg sha "$2" --arg name "$REQUIRED_CHECK" '
    ($checks | map(select(.head_sha == null or .head_sha == $sha))) as $c
    | if $run == null then "pending: no CI run for this head yet"
      elif $run.status != "completed" then "pending: CI is \($run.status)"
      else
        ([$c[] | select(.name == $name and .app.slug == "github-actions" and .check_suite.id == $run.check_suite_id)] | last) as $req
        | if $req == null then "failing: CI finished without a \($name) result"
          elif $req.conclusion != "success" then "failing: \($name) concluded \($req.conclusion // "nothing")"
          elif any($c[]; .status != "completed") then "pending: other checks are running"
          elif any($c[]; (.conclusion // "") as $x | $x != "success" and $x != "neutral" and $x != "skipped") then "failing: another check failed"
          else "green" end
      end'
}

# candidate_problem SHA FEATURE_HEAD MAIN CROSS IS_BOT: prints why SHA is not exactly the bot's
# clean merge of FEATURE_HEAD and MAIN in this repository, and fails; succeeds silently if it is.
candidate_problem() {
  local parents expected
  if [ "$4" != "false" ]; then echo "it comes from another repository"; return 1; fi
  if [ "$5" != "true" ]; then echo "it was not opened by a bot"; return 1; fi
  parents=$(git rev-list --parents -n 1 "$1" | cut -d' ' -f2-)
  if [ "$parents" != "$2 $3" ]; then echo "its head's parents are not the feature head and main"; return 1; fi
  if ! expected=$(git merge-tree --write-tree "$2" "$3" 2>/dev/null); then
    echo "main does not merge cleanly into the feature head"; return 1
  fi
  if [ "$(git rev-parse "$1^{tree}")" != "$expected" ]; then
    echo "its contents differ from the clean merge"; return 1
  fi
}

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

  # An open sync pull request at a still-current head: merge it once the required CI passed on
  # exactly that head and the head is exactly the bot's merge of the feature head and main.
  read -r pr pr_head cross is_bot labels < <(gh pr list --repo "$REPO" --state open --base "$feature" --head "$sync" \
    --json number,headRefOid,isCrossRepository,author,labels \
    --jq '.[0] | "\(.number // "") \(.headRefOid // "") \(.isCrossRepository // "") \(.author.is_bot // "") \([.labels[]?.name] | join(",") | if . == "" then "-" else . end)"') || true
  if [ -n "${pr:-}" ] && git cat-file -e "$pr_head^{commit}" 2>/dev/null &&
    git merge-base --is-ancestor "$head" "$pr_head" && git merge-base --is-ancestor "$main" "$pr_head"; then
    if ! problem=$(candidate_problem "$pr_head" "$head" "$main" "$cross" "$is_bot"); then
      summary "$feature: sync #$pr is not the expected merge ($problem); left open and not merged."
      echo "::warning::$feature: sync #$pr is not the expected merge: $problem"
      if [[ ",$labels," != *",sync-conflict,"* ]]; then
        gh pr comment "$pr" --repo "$REPO" --body "Feature sync will not merge this pull request: $problem. Its head must be exactly the bot's clean merge of \`$feature\` (\`$head\`) and main (\`$main\`). Check what changed, then close it (the next sync opens a fresh one) or merge it by hand." >/dev/null
        gh pr edit "$pr" --repo "$REPO" --add-label sync-conflict >/dev/null
      fi
      continue
    fi
    verdict=$(ci_verdict "$pr" "$pr_head")
    case "$verdict" in
      green)
        if [ "${AUTO_MERGE:-}" != "true" ]; then
          summary "$feature: sync #$pr passed CI; unattended merging is off (FEATURE_SYNC_AUTO_MERGE), so it waits for a person."
        else
          gh pr merge "$pr" --repo "$REPO" --merge --match-head-commit "$pr_head" >/dev/null
          summary "$feature: merged sync #$pr."
        fi ;;
      pending*) summary "$feature: sync #$pr is waiting for its checks (${verdict#pending: })." ;;
      *) summary "$feature: sync #$pr is not mergeable (${verdict#failing: }); its owner looks at it." ;;
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
