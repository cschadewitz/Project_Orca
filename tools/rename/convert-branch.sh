#!/usr/bin/env bash
# Brings a branch that was still open at cutover onto the Orrery names.
#
#   tools/rename/convert-branch.sh <branch> [<pre-rename-main-commit>]
#
# 1. merges the last pre-rename main into the branch (so only the branch's own work differs),
# 2. runs the same codemod over the branch and commits it,
# 3. merges today's (renamed) main.
# Both sides then carry the identical mechanical transform, so step 3 conflicts only where the
# branch and main really disagree. The pre-rename commit defaults to the tag `pre-orrery`,
# which cutover sets on main just before the codemod commit.
set -euo pipefail

branch=${1:?usage: convert-branch.sh <branch> [<pre-rename-main-commit>]}
base=${2:-pre-orrery}

if [[ -n $(git status --porcelain) ]]; then
  echo "convert-branch: working tree is not clean" >&2
  exit 1
fi

git fetch origin main "$branch" --tags
git checkout -B "$branch" "origin/$branch"
git merge --no-edit "$base"

# The codemod and map come from today's main, not from the branch.
tmp=$(mktemp -d)
git show origin/main:tools/rename/map.json > "$tmp/map.json"
for f in lib.mjs codemod.mjs; do git show "origin/main:tools/rename/$f" > "$tmp/$f"; done
node "$tmp/codemod.mjs" --apply
rm -rf "$tmp"
git add -A
git commit -m "rename: apply Orrery codemod to $branch" || echo "convert-branch: nothing to rename"

git merge --no-edit origin/main
echo "convert-branch: $branch is on the Orrery names. Review, run the checks, then push."
