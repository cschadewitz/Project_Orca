# Sourced by tools/backport.sh (and its test).
#
# change_of A B: prints a hash of the diff A..B with only what a rebase may move removed (blob ids
# and hunk line numbers). Whitespace and context are kept, so it is content-sensitive. It prints
# nothing, so the caller refuses, when either diff fails, when the diff is empty, and when the
# change holds a binary file (whose contents `git diff` does not print). Each git output is read
# in full before it is inspected, so an early-exiting reader cannot hide a failure.
change_of() {
  local numstat diff
  numstat=$(git diff --no-ext-diff --no-textconv --no-renames --numstat "$1" "$2") || return 0
  if [[ $'\n'"$numstat" == *$'\n-\t-\t'* ]]; then return 0; fi
  diff=$(git diff --no-ext-diff --no-textconv --no-color --no-renames "$1" "$2") || return 0
  [ -n "$diff" ] || return 0
  sed -E '/^index [0-9a-f]+\.\.[0-9a-f]+/d; s/^@@ -[0-9]+(,[0-9]+)? \+[0-9]+(,[0-9]+)? @@.*$/@@/' <<<"$diff" |
    sha256sum | cut -d' ' -f1
}
