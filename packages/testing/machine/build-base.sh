#!/usr/bin/env bash
# Load or build the two-machine test's packages layer (base.Dockerfile) as orca-machine-base:ci,
# and save it to $1 for actions/cache. Used by the PR job (.github/workflows/two-daemons.yml) and
# by the trusted main-branch warm job (.github/workflows/machine-base-cache.yml), so both produce
# the same image under the same cache key.
#
# The pinned Ubuntu base is pulled on its own first, from Docker Hub or else its mirror on
# mirror.gcr.io (the digest pins the content either way), so a stalled registry is told apart
# from a stalled package archive. Every network step has a bounded time, and is killed outright
# if it ignores the stop, so one stuck attempt cannot use up the retries.
set -euo pipefail
tar_path="$1"
here="$(cd "$(dirname "$0")" && pwd)"
digest="$(sed -n 's/^ARG BASE=ubuntu@\(sha256:[0-9a-f]\{64\}\)$/\1/p' "$here/base.Dockerfile")"
[ -n "$digest" ] || { echo "::error::no pinned base digest in base.Dockerfile"; exit 1; }
# Per-attempt time for the package install; the main warm job, which nothing waits on, allows more.
build_timeout="${ORCA_BASE_BUILD_TIMEOUT:-300}"
if [ -s "$tar_path" ] && docker load -i "$tar_path"; then exit 0; fi
# Which Ubuntu mirror to take packages from. Hosted runners do not always come with a nearby
# one configured, so each candidate (this host's own apt source first) is timed fetching the
# release file, and attempts go to the fastest first. ORCA_UBUNTU_MIRRORS, a space-separated list,
# replaces the candidates and is tried in its own order (still dropping any that do not answer).
# Packages are verified against the image's archive keys whichever mirror serves them.
candidates=()
if [ -n "${ORCA_UBUNTU_MIRRORS:-}" ]; then
  read -r -a candidates <<<"$ORCA_UBUNTU_MIRRORS"
  order=(cat)
else
  for list in /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do
    [ -r "$list" ] || continue
    while read -r uri; do candidates+=("${uri%/}"); done < <(
      grep -oE 'https?://[A-Za-z0-9.-]+/ubuntu/?' "$list" | grep -v '//security\.ubuntu\.com/' | sort -u
    )
  done
  candidates+=(http://azure.archive.ubuntu.com/ubuntu http://us-east-1.ec2.archive.ubuntu.com/ubuntu
    https://mirrors.edge.kernel.org/ubuntu http://archive.ubuntu.com/ubuntu)
  order=(sort -rn -k1,1)
fi
ranked=()
while read -r speed uri; do
  echo "mirror $uri: ${speed} B/s"
  [ "${speed%.*}" -gt 0 ] && ranked+=("$uri")
done < <(
  for uri in $(printf '%s\n' "${candidates[@]}" | awk '!seen[$0]++'); do
    speed="$(curl -fsS -o /dev/null --max-time 20 -w '%{speed_download}' "$uri/dists/noble/InRelease" 2>/dev/null)" || speed=0
    echo "${speed:-0} ${uri%/}"
  done | "${order[@]}"
)
echo "mirror order: ${ranked[*]:-none answered}"
[ "${#ranked[@]}" -gt 0 ] || ranked=(http://archive.ubuntu.com/ubuntu)
for attempt in 1 2 3; do
  # The fastest mirror twice, then the next one, in case the fastest is the one that stalls.
  pick=0
  [ "$attempt" = 3 ] && [ "${#ranked[@]}" -gt 1 ] && pick=1
  mirror="${ranked[$pick]}"
  echo "package mirror for attempt $attempt: $mirror"
  base=""
  for repo in docker.io/library/ubuntu mirror.gcr.io/library/ubuntu; do
    echo "pulling $repo@$digest (attempt $attempt)"
    if timeout --kill-after=15 120 docker pull -q "$repo@$digest"; then
      base="$repo@$digest"
      break
    fi
    echo "::warning::pulling $repo@$digest failed or timed out"
  done
  if [ -n "$base" ] && timeout --kill-after=30 "$build_timeout" docker build --progress=plain \
    --build-arg "BASE=$base" --build-arg "UBUNTU_MIRROR=$mirror" -t orca-machine-base:ci -f "$here/base.Dockerfile" "$here"; then
    docker save -o "$tar_path" orca-machine-base:ci
    exit 0
  fi
  echo "::warning::machine base build attempt $attempt failed or timed out"
  sleep $((attempt * 15))
done
exit 1
