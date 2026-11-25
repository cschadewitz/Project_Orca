#!/usr/bin/env bash
# Points existing clones at the renamed repositories. See tools/rename/README.md.
#
#   tools/rename/relink-clones.sh [--dry-run] [CLONE...]      (default: the current directory)
#
# For every remote of every CLONE whose URL names cschadewitz/Project_Orca or
# cschadewitz/Project_Orca_Infra (https, ssh or git@ form, with or without .git), sets the URL to
# Orrery or Orrery-Infra. GitHub redirects the old names, so nothing breaks before this runs; it
# only stops relying on the redirect. Idempotent; each change is logged for rollback.sh.
# Windows: relink-clones.ps1 does the same.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=cutover-lib.sh
. "$here/cutover-lib.sh"

parse_common "$@"
clones=("${REST[@]+"${REST[@]}"}")
((${#clones[@]})) || clones=("$PWD")

# new_url URL: the URL for the renamed repository, or URL itself.
new_url() {
  sed -E "s#([:/]$OWNER/)$OLD_INFRA(\\.git)?/?\$#\\1$NEW_INFRA\\2#; t; s#([:/]$OWNER/)$OLD_REPO(\\.git)?/?\$#\\1$NEW_REPO\\2#" <<<"$1"
}

for clone in "${clones[@]}"; do
  step "$clone"
  if ! git -C "$clone" rev-parse --git-dir >/dev/null 2>&1; then
    bad "not a Git clone"
    continue
  fi
  clone=$(cd "$clone" && pwd)
  while read -r remote; do
    [[ -n "$remote" ]] || continue
    while read -r url; do
      next=$(new_url "$url")
      if [[ "$next" == "$url" ]]; then
        ok "$remote $url"
        continue
      fi
      change "point $remote at $next" -- git -C "$clone" config --fixed-value --replace-all "remote.$remote.url" "$next" "$url"
      record remote-url "$(jq -cn --arg c "$clone" --arg r "$remote" --arg b "$url" --arg a "$next" \
        '{clone: $c, remote: $r, before: $b, after: $a}')"
    done < <(git -C "$clone" config --get-all "remote.$remote.url")
  done < <(git -C "$clone" remote)
done
((DRY_RUN)) && say $'\n(dry run: nothing was changed)'
exit "$FAILED"
