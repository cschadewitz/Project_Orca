# The packages layer of the two-machine test image (#885), built on its own so CI can cache it
# (.github/workflows/two-daemons.yml) and pass it to the test as ORCA_MACHINE_BASE. Dockerfile in
# this directory installs the same packages itself when its base lacks them: keep the two lists
# the same.
# BASE is ubuntu:24.04 pinned by digest; build-base.sh may pass the same digest from a mirror.
ARG BASE=ubuntu@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289
FROM ${BASE}

# UBUNTU_MIRROR, when given, replaces archive.ubuntu.com and security.ubuntu.com for this build;
# build-base.sh passes the mirror the build host's own apt uses. Packages are still checked
# against the image's own Ubuntu archive keys, so a mirror only changes where they come from.
ARG UBUNTU_MIRROR=
# The archive can be slow or drop connections; retry each download instead of hanging. The host
# keys openssh-server makes on install are removed in this same layer, so the cached and shared
# image holds none; each machine makes its own when it starts.
RUN if [ -n "$UBUNTU_MIRROR" ]; then \
      printf '%s\n' "$UBUNTU_MIRROR" | grep -Eq '^https?://[A-Za-z0-9.-]+(/[A-Za-z0-9._/-]*)?$' \
      && sed -i -E "s#https?://(archive|security)\.ubuntu\.com/ubuntu/?#${UBUNTU_MIRROR%/}/#g" \
         /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
 && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update -q \
 && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 \
    install -yq --no-install-recommends \
    openssh-server openssh-client git procps xz-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/ssh/ssh_host_*
