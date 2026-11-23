# One ORCA machine for the two-machine acceptance test (#885): a clean Ubuntu 24.04 with sshd and
# the headless server bundle (#876) unpacked, and nothing else of the repository. The test
# (packages/testing/src/two-machines.ts) builds this from the checkout's own bundle and runs
# one container per machine on a private Docker network, so a parent daemon reaches its
# worker exactly as it would another host: over the network, through sshd, as a login user.
#
# BASE is ubuntu:24.04 pinned by digest. A base that already holds the packages below (a
# cached or mirrored copy, where the build has no route to the Ubuntu archive) skips the
# download; nothing else about the image changes. CI builds that base from base.Dockerfile and
# caches it, so keep its package list the same as the one below.
ARG BASE=ubuntu@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289
FROM ${BASE}

# git: delegated runs check out workspaces; procps: the test drops the tunnel with pkill.
# Each container makes its own host keys when it starts, so no two machines share one.
RUN if ! [ -x /usr/sbin/sshd ]; then \
      apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update -q \
      && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 \
         install -yq --no-install-recommends \
         openssh-server openssh-client git procps xz-utils ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi \
 && rm -f /etc/ssh/ssh_host_* \
 && printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/orca-test.conf \
 && useradd --create-home --shell /bin/bash orca \
 && mkdir -p /run/sshd

# The bundle exactly as a release ships it, unpacked where an operator would put a release,
# and the `orca` launcher on PATH for login sessions (enrollment runs `orca auth issue` there).
ARG BUNDLE
COPY ${BUNDLE} /tmp/orca-server.tar.xz
RUN mkdir -p /opt/orca-server \
 && tar -xJf /tmp/orca-server.tar.xz -C /opt/orca-server --strip-components=1 \
 && rm /tmp/orca-server.tar.xz \
 && printf '#!/bin/sh\nexec /opt/orca-server/runtime/bin/node /opt/orca-server/orca-daemon.mjs "$@"\n' > /usr/local/bin/orca \
 && chmod 0755 /usr/local/bin/orca

# Test-side helper: one JSON-RPC call to this machine's daemon on its own loopback.
COPY rpc.mjs /opt/orca-test/rpc.mjs

CMD ["sleep", "infinity"]
