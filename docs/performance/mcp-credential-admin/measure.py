"""Bounded, serialized fresh-process and fixed-consumer measurements for issue 510."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import tempfile
import time

FILES = [
    f"packages/integrations/test/mcp-operator-production-{name}.test.ts"
    for name in ("authority", "lifecycle", "recovery")
]
FIXTURE = "packages/integrations/test/mcp-operator-production-fixture.ts"
MODULES = {
    "before": "packages/daemon/dist/index.js",
    "after": "packages/daemon/dist/auth/bootstrap.js",
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command, cwd, env, limit, data=None):
    # A separate process group owns only this invocation and its descendants.
    start = time.monotonic_ns()
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        child = subprocess.Popen(
            command, cwd=cwd, env=env, stdin=subprocess.PIPE,
            stdout=out, stderr=err, start_new_session=True,
        )
        timed_out = False
        try:
            child.communicate(data, timeout=limit)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.communicate()
        wall = (time.monotonic_ns() - start) / 1e9
        if out.tell() + err.tell() > 5 * 1024 * 1024:
            raise RuntimeError("Child output exceeded 5 MiB; raw output not published")
        out.seek(0)
        err.seek(0)
        return {
            "seconds": wall, "exit": child.returncode,
            "timeout": timed_out, "pid": child.pid,
        }, out.read(), err.read()


def provenance(root, node, env):
    _, head, _ = run(["git", "rev-parse", "HEAD", "HEAD^{tree}"], root, env, 10)
    paths = [root / FIXTURE, root / "pnpm-lock.yaml", *(root / f for f in FILES)]
    paths += sorted(p for p in (root / "packages").glob("*/dist/**/*") if p.is_file())
    return {
        "headAndTree": head.decode().splitlines(),
        "sha256": {str(p.relative_to(root)): digest(p) for p in paths},
        "nodeSha256": digest(Path(node)),
    }


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def admin(node, root, module, action, value, auth, env):
    # Same stdin protocol, openAuthDirectory and issue/revoke dispatch as the fixture.
    code = f"""import {{ openAuthDirectory }} from {json.dumps((root / module).as_uri())};
      let text = ''; for await (const chunk of process.stdin) text += chunk;
      const {{action, value, dir}} = JSON.parse(text); const auth = openAuthDirectory(dir);
      const result = action === 'issue' ? await auth.credentials.issue(value) : await auth.credentials.revoke(value);
      process.stdout.write(JSON.stringify(result ?? null));"""
    record, out, _ = run(
        [node, "--input-type=module", "-e", code], auth.parent, env, 10,
        json.dumps({"action": action, "value": value, "dir": str(auth)}).encode(),
    )
    if record["exit"] != 0 or record["timeout"]:
        raise RuntimeError("Synthetic credential administration failed; output suppressed")
    return record, json.loads(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["micro", "suite"])
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.output.mkdir()  # Refuse overwriting an earlier experiment.
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node missing")
    roots = {"before": args.baseline.resolve(), "after": args.candidate.resolve()}
    env = {"PATH": os.environ["PATH"], "LANG": "C.UTF-8"}
    metadata = {
        "platform": platform.platform(), "loadBefore": os.getloadavg(),
        "cpuAffinityCount": len(os.sched_getaffinity(0)),
        "node": run([node, "--version"], roots["before"], env, 10)[1].decode().strip(),
        "pnpm": run(["pnpm", "--version"], roots["before"], env, 10)[1].decode().strip(),
        "cgroup": {
            f: Path("/sys/fs/cgroup", f).read_text().strip()
            for f in ("cpu.max", "memory.max", "pids.max")
        },
        "checkouts": {key: provenance(root, node, env) for key, root in roots.items()},
    }
    save(args.output / "provenance.json", metadata)
    records = []
    try:
        if args.mode == "micro":
            # Verify export identity outside timed credential operations.
            for key, root in roots.items():
                code = (
                    f'import {{ openAuthDirectory as a }} from {json.dumps((root / MODULES["before"]).as_uri())};'
                    f'import {{ openAuthDirectory as b }} from {json.dumps((root / MODULES["after"]).as_uri())};'
                    'if (a !== b) process.exit(1);'
                )
                record, _, _ = run([node, "--input-type=module", "-e", code], root, env, 10)
                records.append({"kind": "identity", "variant": key, **record})
                if record["exit"] != 0:
                    raise RuntimeError("Emitted function identity differs")
            for pair in range(6):
                order = ["before", "after"] if pair % 2 == 0 else ["after", "before"]
                for variant in order:
                    with tempfile.TemporaryDirectory(prefix="credential-", dir=args.scratch) as directory:
                        auth = Path(directory) / "auth"
                        issue, result = admin(
                            node, roots[variant], MODULES[variant], "issue",
                            {"principal": "benchmark-owner", "preset": "owner"}, auth, env,
                        )
                        credential_id = result["credential"]["id"]
                        # Do not retain tokens, credential IDs, records or child output.
                        del result
                        revoke, _ = admin(
                            node, roots[variant], MODULES[variant], "revoke", credential_id, auth, env,
                        )
                        stored = json.loads((auth / "credentials.json").read_text())["credentials"]
                        if len(stored) != 1 or not stored[0].get("revokedAt"):
                            raise RuntimeError("Revoke did not persist")
                        records.append({
                            "kind": "issue-revoke", "pair": pair + 1, "order": order,
                            "variant": variant, "issue": issue, "revoke": revoke,
                            "seconds": issue["seconds"] + revoke["seconds"],
                            "revokedPersisted": True,
                        })
        else:
            for pair in range(3):
                order = ["before", "after"] if pair % 2 == 0 else ["after", "before"]
                for variant in order:
                    name = f"pair{pair + 1}-{variant}"
                    report = (args.output / f"{name}.json").resolve()
                    command = [
                        node, "node_modules/vitest/vitest.mjs", "run", *FILES,
                        "--maxWorkers=1", "--no-file-parallelism", "--reporter=json",
                        f"--outputFile={report}",
                    ]
                    record, out, err = run(
                        command, roots[variant], {
                            **env, "TMPDIR": str(args.scratch.resolve()),
                            "ORCA_MCP_REQUIRE_PRODUCTION": "1",
                        }, 600,
                    )
                    records.append({"pair": pair + 1, "order": order, "variant": variant, **record})
                    with gzip.GzipFile(str(args.output / f"{name}.log.gz"), "wb", mtime=0) as log:
                        log.write(out + err)
                    if not report.exists():
                        raise RuntimeError("Vitest report missing; see retained log")
                    result = json.loads(report.read_text())
                    tests = [t for f in result["testResults"] for t in f["assertionResults"]]
                    if record["exit"] != 0 or not result["success"] or len(tests) != 60 or any(
                        t["status"] != "passed" for t in tests
                    ):
                        raise RuntimeError("Fixed 60-case workload failed; stopping without retries")
                    print(f"{name}: {record['seconds']:.3f}s; all 60 cases passed", flush=True)
    finally:
        save(args.output / "timings.json", {"loadAfter": os.getloadavg(), "records": records})


if __name__ == "__main__":
    main()
