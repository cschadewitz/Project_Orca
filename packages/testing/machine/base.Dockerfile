# The packages layer of the two-machine test image (#885), built on its own so CI can cache it
# (.github/workflows/two-daemons.yml) and pass it to the test as ORCA_MACHINE_BASE. Dockerfile in
# this directory installs the same packages itself when its base lacks them: keep the two lists
# the same.
FROM ubuntu@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289

# The archive can be slow or drop connections; retry each download instead of hanging.
RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update -q \
 && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 \
    install -yq --no-install-recommends \
    openssh-server openssh-client git procps xz-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*
