#!/usr/bin/python3
"""Stage immutable nonsecret review files only; never execute or install a service."""
import hashlib
import json
import os
import socket
import stat
import sys

SOURCE_COMMIT = "1199f7e4705d904f3f5dfda32a2644d0b8346e01"
STAGE_NAME = "orca-service-review-1199f7e"
EXPECTED_UID = 1000

# Literal bytes rendered from SOURCE_COMMIT, not host files or shell interpolation.
PAYLOAD = {
    'orca-daemon.service': b"""[Unit]
Description=Authenticated ORCA daemon for private MCP
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=5min
StartLimitBurst=6

[Service]
Type=simple
WorkingDirectory=/home/casey/.orca-codex-work
# Clear the manager environment before Node or tunnel-client can read it.
# Optional proxy/CA assignments must be literal reviewed values; see the runbook.
ExecStart=/usr/bin/env -i HOME=/home/casey PATH=/home/casey/.local/share/mise/installs/node/24.21.0/bin:/usr/bin:/bin LANG=C TMPDIR=/srv/dev/orca-temp-cal /home/casey/.local/share/mise/installs/node/24.21.0/bin/node /home/casey/.local/share/orca-runtime/49efcc7236ac127c952bb1f7a50fc6ef72f7df84/packages/cli/dist/main.js --config /home/casey/.orca-codex-work/orca.yaml serve --host 127.0.0.1 --port 33871
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
KillSignal=SIGTERM
KillMode=control-group
SendSIGKILL=yes
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
# GET http://127.0.0.1:33871/health is local liveness only.

[Install]
WantedBy=default.target
""",
    'orca-tunnel.service': b"""[Unit]
Description=Single outbound tunnel-client for authenticated ORCA MCP
Wants=orca-daemon.service
After=orca-daemon.service network-online.target
Wants=network-online.target
StartLimitIntervalSec=5min
StartLimitBurst=6

[Service]
Type=simple
WorkingDirectory=/home/casey/.orca-codex-work
# Clear the manager environment before Node or tunnel-client can read it.
# Optional proxy/CA assignments must be literal reviewed values; see the runbook.
ExecStart=/usr/bin/env -i HOME=/home/casey PATH=/home/casey/.local/share/mise/installs/node/24.21.0/bin:/usr/bin:/bin LANG=C TMPDIR=/srv/dev/orca-temp-cal /opt/orca-tunnel/0.0.15/tunnel-client run --profile-file /home/casey/.orca-codex-work/supervision/tunnel-profile.yaml
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
KillSignal=SIGTERM
KillMode=control-group
SendSIGKILL=yes
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
# Wants/After orders startup only, not readiness or stop/restart propagation.
# No PartOf, BindsTo, Requires, or reverse dependency on this tunnel.
# The reviewed tunnel profile binds /healthz and /readyz to 127.0.0.1 only.

[Install]
WantedBy=default.target
""",
    'tunnel-profile.yaml': b"""# Separate opt-in to retain agent-01's existing private launcher unchanged.
# Fresh authenticated discovery is required before every post-restart mutation.
config_version: 1
control_plane:
  base_url: https://api.openai.com
  tunnel_id: tunnel_6ac0b657e5d88191a442de4978b38ea9
  api_key: file:/home/casey/.orca-codex-work/supervision/tunnel-runtime.key
  poll_channels: [main]
health:
  listen_addr: 127.0.0.1:33872
log:
  level: info
  format: struct-text
mcp:
  commands:
    - channel: main
      command: /home/casey/.local/share/mise/installs/node/24.21.0/bin/node /home/casey/.orca-codex-work/mcp-client.cjs
""",
}
EXPECTED_HASHES = {'orca-daemon.service': 'c9b805d674ed474cf712d2493e6bf0546efea4d9ed67ec4799bfacf4795f63d9', 'orca-tunnel.service': '19ea0774df1abaf0066a9cf4136ecdf4613f4daf1f1f240ed2402fd00cf0b43c', 'tunnel-profile.yaml': 'd9deb85cae77c9da4dbb796daae62a22613ee18182489fb5518d2b7bd3529d38'}


def checked_parent():
    """Walk literal parent directories by descriptor, rejecting symlinks and writable ancestors."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    current = os.open("/", flags)
    try:
        for name, owner in [(None, 0), ("home", 0), ("casey", EXPECTED_UID)]:
            if name is not None:
                child = os.open(name, flags, dir_fd=current)
                os.close(current)
                current = child
            info = os.fstat(current)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022:
                raise ValueError("parent-security")
        return current
    except BaseException:
        os.close(current)
        raise


def stage(parent_fd):
    """Create one new 0700 directory and four exclusive 0600 files; retain partial output on failure."""
    actual = {name: hashlib.sha256(data).hexdigest() for name, data in PAYLOAD.items()}
    if actual != EXPECTED_HASHES:
        raise ValueError("embedded-digest")
    manifest = (json.dumps({"sourceCommit": SOURCE_COMMIT, "sha256": actual}, indent=2) + "\n").encode()
    files = {**PAYLOAD, "rendered-sha256.json": manifest}
    # EEXIST includes an existing directory, file or symlink: never reuse/overwrite.
    os.mkdir(STAGE_NAME, mode=0o700, dir_fd=parent_fd)
    directory = os.open(STAGE_NAME, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        info = os.fstat(directory)
        if info.st_uid != EXPECTED_UID or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("stage-security")
        for name, data in files.items():
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            with os.fdopen(fd, "wb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
        os.fsync(directory)
    finally:
        os.close(directory)


def main():
    if len(sys.argv) != 1 or sys.platform != "linux":
        raise ValueError("owner-host-prerequisite")
    import pwd

    if (
        os.getuid() != EXPECTED_UID
        or os.geteuid() != EXPECTED_UID
        or pwd.getpwuid(EXPECTED_UID).pw_name != "casey"
        or socket.gethostname().split(".")[0] != "agent-01"
    ):
        raise ValueError("owner-host-prerequisite")
    os.umask(0o077)
    parent = checked_parent()
    try:
        stage(parent)
    finally:
        os.close(parent)
    print("STAGED: nonsecret review files only; no service or compatibility acceptance performed.")


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Do not dump paths, argv, environment, exception contents or file contents.
        print("STOP: staging refused or incomplete; existing/partial files retained. No services changed.", file=sys.stderr)
        sys.exit(1)
