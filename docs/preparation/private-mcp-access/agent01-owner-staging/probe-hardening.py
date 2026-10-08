#!/usr/bin/python3
"""One owner-requested transient hardening probe; no ORCA access, file writes, or retries."""
import json
import os
import socket
import stat
import subprocess
import sys

UNIT = "orca-preflight-hardening-20261004.service"
SCRIPT = "/home/casey/orca-staging-download-1199f7e/probe-hardening.py"
TEMP = "/srv/dev/orca-temp-cal"
ENV = {"HOME": "/home/casey", "PATH": "/usr/bin:/bin", "LANG": "C",
       "XDG_RUNTIME_DIR": "/run/user/1000", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus"}
PROPERTIES = ["Type=exec", "PrivateTmp=yes", "NoNewPrivileges=yes", "UMask=0077", "Restart=no",
              "RuntimeMaxSec=15s", "TimeoutStartSec=10s", "TimeoutStopSec=5s",
              "KillMode=control-group", "SendSIGKILL=yes"]


def command(args, timeout=5):
    result = subprocess.run(args, env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    if len(result.stdout) > 16384:
        raise ValueError("output-bound")
    return result.returncode, result.stdout.decode("utf-8", errors="strict")


def absent():
    code, output = command(["/usr/bin/systemctl", "--user", "show", UNIT, "--no-pager", "--all",
                            "--property=LoadState,ActiveState,FragmentPath,DropInPaths"])
    fields = dict(line.split("=", 1) for line in output.splitlines())
    if code not in (0, 4) or fields != {
        "LoadState": "not-found", "ActiveState": "inactive", "FragmentPath": "", "DropInPaths": ""
    }:
        raise ValueError("unit-not-absent")


def precheck():
    absent()
    code, output = command(["/usr/bin/systemctl", "--user", "show", "--property=UnitPath", "--value", "--no-pager"])
    paths = output.split()
    if code or not paths or any(not path.startswith("/") or "\\" in path for path in paths):
        raise ValueError("unit-paths")
    # Refuse exact units and any applicable exact/prefix/type-wide drop-in directory,
    # even an empty one. Missing-unit show alone cannot establish inherited drop-ins.
    names = [UNIT, UNIT + ".d", UNIT + ".wants", UNIT + ".requires", UNIT + ".upholds",
             "orca-preflight-hardening-.service.d",
             "orca-preflight-.service.d", "orca-.service.d", "service.d"]
    for path in paths:
        for name in names:
            try:
                os.lstat(path + "/" + name)
            except FileNotFoundError:
                continue
            raise ValueError("unit-or-dropin-present")


def snapshot():
    # Read only this process's status/namespaces and these three directory metadata records.
    with open("/proc/self/status", encoding="ascii") as source:
        status = dict(line.split(":", 1) for line in source.read(65536).splitlines() if ":" in line)
    namespaces = {}
    for name in ("mnt", "user"):
        info = os.stat("/proc/self/ns/" + name)
        namespaces[name] = [info.st_dev, info.st_ino]
    directories = {}
    for path in ("/tmp", "/var/tmp", TEMP):
        info = os.stat(path, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("directory-kind")
        directories[path] = [info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode)]
    return {"nnp": int(status["NoNewPrivs"].strip()), "umask": status["Umask"].strip(),
            "uids": [int(value) for value in status["Uid"].split()], "ns": namespaces,
            "dirs": directories, "tmpdir_matches": os.environ.get("TMPDIR") == TEMP}


def compare(parent, child):
    checks = {
        "no_new_privileges": child["nnp"] == 1,
        "umask_0077": child["umask"] == "0077",
        "casey_uid": child["uids"] == [1000] * 4,
        "private_mount_namespace": parent["ns"]["mnt"] != child["ns"]["mnt"],
        "private_tmp": parent["dirs"]["/tmp"][:2] != child["dirs"]["/tmp"][:2],
        "private_var_tmp": parent["dirs"]["/var/tmp"][:2] != child["dirs"]["/var/tmp"][:2],
        "custom_tmp_visible_unchanged": parent["dirs"][TEMP] == child["dirs"][TEMP],
        "custom_tmp_private": child["dirs"][TEMP][2:] == [1000, 0o700],
        "tmpdir_matches": child["tmpdir_matches"] is True,
    }
    return {"checks": checks, "passed": all(checks.values()),
            "user_namespace_changed": parent["ns"]["user"] != child["ns"]["user"]}


def invocation():
    return ["/usr/bin/systemd-run", "--user", "--unit=" + UNIT, "--wait", "--pipe", "--collect", "--quiet",
            "--expand-environment=no", *("--property=" + item for item in PROPERTIES),
            "/usr/bin/env", "-i", "HOME=/home/casey", "PATH=/usr/bin:/bin", "LANG=C", "TMPDIR=" + TEMP,
            "/usr/bin/python3", "-I", "-S", "-B", SCRIPT, "--inside"]


def main():
    if sys.platform != "linux" or os.getuid() != 1000 or os.geteuid() != 1000:
        raise ValueError("owner-platform")
    if socket.gethostname().split(".")[0] != "agent-01":
        raise ValueError("owner-host")
    if sys.argv[1:] == ["--inside"]:
        print(json.dumps(snapshot(), separators=(",", ":")))
        return
    if len(sys.argv) != 1 or os.path.abspath(__file__) != SCRIPT:
        raise ValueError("invocation")
    for path, uid, mode in [("/home", 0, None), ("/home/casey", 1000, None),
                            (os.path.dirname(SCRIPT), 1000, 0o700), (SCRIPT, 1000, 0o600)]:
        info = os.lstat(path)
        if (stat.S_ISLNK(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022
                or (mode is not None and stat.S_IMODE(info.st_mode) != mode)):
            raise ValueError("source-security")
        if path == SCRIPT and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
            raise ValueError("source-kind")
    precheck()
    parent = snapshot()
    code, output = command(invocation(), timeout=40)
    # One read-only collection check, not a cleanup command or an automatic retry.
    absent()
    if code:
        raise ValueError("transient-failed")
    result = compare(parent, json.loads(output))
    result["unit_collected"] = True
    print(json.dumps(result, separators=(",", ":")))
    if not result["passed"]:
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt):
        print("STOP: probe refused/failed or collection unconfirmed; no retry or protection changes.", file=sys.stderr)
        sys.exit(1)
