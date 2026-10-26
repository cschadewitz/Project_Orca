"""Disposable stage-command and supervisor fixture. Never runs external tools/services."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys


def load_adapter():
    spec = importlib.util.spec_from_file_location("release", Path(__file__).parents[1] / "orca-release.py")
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    return adapter


def command_label(args, root):
    if args[:3] == ["gh", "release", "view"]:
        return "release-view"
    if args[:3] == ["gh", "repo", "clone"]:
        return "clone"
    if args[:2] == ["git", "rev-parse"]:
        return "git-revision"
    if args[:2] == ["mise", "which"]:
        return "node-path"
    if args[:2] in (["mise", "trust"], ["mise", "install"]):
        return "-".join(args[:2])
    if args[:4] == ["mise", "exec", "--", "pnpm"]:
        return "pnpm-" + (args[5] if args[4] == "run" else args[4])
    if "--version" in args:
        return "candidate-version"
    if "demo" in args:
        return "demo"
    if "validate" in args:
        return "validate-" + Path(args[args.index("--config") + 1]).stem
    if "serve" in args:
        return "health"
    raise RuntimeError("Unexpected fixture command: " + repr(args))


def producer(root, target, args):
    label = command_label(args, root)
    if label == target:
        unrelated = (root / "unrelated-descriptor").stat()
        leaked = False
        for name in os.listdir("/proc/self/fd"):
            try:
                observed = os.fstat(int(name))
                leaked |= (observed.st_dev, observed.st_ino) == (unrelated.st_dev, unrelated.st_ino)
            except OSError:
                pass
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notify:
            notify.sendto(json.dumps({"pid": os.getpid(), "label": label, "unrelated": leaked}).encode(), str(root / "notify"))
        # Parent controls termination with a bounded pidfd wait; no age/PID lock inference.
        signal.pause()
    if label == "release-view":
        print(json.dumps({"tagName": "v0.6.2", "isDraft": False, "isPrerelease": False}))
    elif label == "clone":
        checkout = Path(args[4])
        (checkout / "package.json").write_text(json.dumps({"version": "0.6.2"}))
        (checkout / "release-compatibility.json").write_text(json.dumps({"storeEpoch": "v1"}))
    elif label == "git-revision":
        print("a" * 40)
    elif label == "node-path":
        print(sys.executable)
    elif label == "candidate-version":
        print("0.6.2")


def stage_supervisor(root, target):
    adapter = load_adapter()
    original_popen = subprocess.Popen
    unrelated = os.open(root / "unrelated-descriptor", os.O_RDWR | os.O_CREAT, 0o600)
    os.set_inheritable(unrelated, True)

    def fake_executable(args, **kwargs):
        # Replace only the executable/argv. Inheritance and close_fds/pass_fds are
        # exactly those supplied by the actual stage run/capture/Popen dispatch.
        return original_popen([sys.executable, "-B", __file__, "producer", str(root), target, json.dumps(args)], **kwargs)

    subprocess.Popen = fake_executable
    deployment = adapter.Deployment(root / "deployment.json")
    deployment.health = lambda *args, **kwargs: signal.pause()
    deployment.stage("v0.6.2")


if __name__ == "__main__":
    mode, folder, target = sys.argv[1:4]
    if mode == "producer":
        producer(Path(folder), target, json.loads(sys.argv[4]))
    elif mode == "stage":
        stage_supervisor(Path(folder), target)
