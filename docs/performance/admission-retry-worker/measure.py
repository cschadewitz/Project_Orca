"""Three bounded, alternating-order pairs of the unchanged 25-case retry workload."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import threading
import time

TEST = "packages/engine/test/admission-retry-multiprocess.test.ts"
WORKER = "packages/engine/test/admission-retry-multiprocess/worker.ts"
FIXTURE = "packages/engine/test/admission-retry-multiprocess/fixture.ts"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir()  # Never overwrite a previous experiment or failure.
    roots = {"before": args.baseline.resolve(), "after": args.candidate.resolve()}
    observer = Path(__file__).with_name("observe.mjs").resolve()
    metadata = {
        "platform": platform.platform(), "loadBefore": os.getloadavg(),
        "affinity": len(os.sched_getaffinity(0)),
        "cgroup": {p: Path("/sys/fs/cgroup", p).read_text().strip() for p in ["cpu.max", "memory.max", "pids.max"]},
        "node": subprocess.check_output(["node", "--version"], text=True).strip(),
        "pnpm": subprocess.check_output(["pnpm", "--version"], text=True).strip(),
        "observerSha256": sha(observer),
        "checkouts": {},
    }
    for variant, root in roots.items():
        paths = [TEST, WORKER, FIXTURE, "pnpm-lock.yaml", "tsconfig.json", "tsconfig.base.json", "package.json", "pnpm-workspace.yaml"]
        paths += [str(p.relative_to(root)) for p in sorted(root.glob("packages/*/src/**/*.ts"))]
        paths += [str(p.relative_to(root)) for p in sorted(root.glob("packages/*/package.json"))]
        paths += ["packages/engine/test/admission-retry-multiprocess/harness.ts"]
        if variant == "after": paths += ["packages/engine/test/admission-retry-multiprocess/compiled-worker.ts"]
        metadata["checkouts"][variant] = {
            "headTree": subprocess.check_output(["git", "rev-parse", "HEAD", "HEAD^{tree}"], cwd=root, text=True).splitlines(),
            "status": subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True),
            "sha256": {p: sha(root / p) for p in paths},
        }
    for path in [TEST, WORKER, FIXTURE, "pnpm-lock.yaml", "tsconfig.json", "tsconfig.base.json"]:
        assert metadata["checkouts"]["before"]["sha256"][path] == metadata["checkouts"]["after"]["sha256"][path], path
    save(args.output / "provenance.json", metadata)
    rows, names = [], None
    try:
        for pair in range(1, 4):
            order = ["before", "after"] if pair % 2 else ["after", "before"]
            for variant in order:
                name = f"pair{pair}-{variant}"
                report = args.output / f"{name}.json"
                events = args.output / f"{name}-processes.jsonl"
                env = os.environ.copy()
                env["NODE_OPTIONS"] = f"--import={observer}"
                env["ORCA_RETRY_OBSERVATIONS"] = str(events)
                command = ["node", "node_modules/vitest/vitest.mjs", "run", TEST,
                           "--maxWorkers=1", "--no-file-parallelism", "--reporter=json", f"--outputFile={report}"]
                with (args.output / f"{name}.log").open("wb") as log:
                    begin = time.monotonic_ns()
                    child = subprocess.Popen(command, cwd=roots[variant], env=env, stdout=log, stderr=log, start_new_session=True)
                    timed_out = threading.Event()
                    def terminate():
                        timed_out.set()
                        try: os.killpg(child.pid, signal.SIGTERM)
                        except ProcessLookupError: return
                        killer = threading.Timer(5, lambda: kill_group(child.pid))
                        killer.daemon = True
                        killer.start()
                    timer = threading.Timer(180, terminate)
                    timer.daemon = True
                    timer.start()
                    # Blocking waitpid; independent watchdog supplies the bound. No completion polling.
                    code = child.wait()
                    timer.cancel()
                    elapsed = (time.monotonic_ns() - begin) / 1e9
                row = {"pair": pair, "order": order, "variant": variant, "seconds": elapsed,
                       "exit": code, "timeout": timed_out.is_set(), "command": command}
                rows.append(row)
                save(args.output / "timings.json", rows)
                if code or timed_out.is_set(): raise RuntimeError(f"Retained failed sample {name}")
                result = json.loads(report.read_text())
                assert result["success"] and result["numPassedTests"] == 25
                assert result["numFailedTests"] == result["numPendingTests"] == result["numTodoTests"] == 0
                current = sorted(a["fullName"] for r in result["testResults"] for a in r["assertionResults"] if a["status"] == "passed")
                if names is None: names = current
                assert names == current and len(current) == 25
                observed = [r for line in events.read_text().splitlines() for r in json.loads(line)]
                assert len(observed) == len({r["pid"] for r in observed}) == 75
                assert sum(r["signal"] == "SIGKILL" and r["code"] is None for r in observed) == 21
                assert sum(r["signal"] is None and r["code"] == 0 for r in observed) == 54
                assert all("forkToReadyMs" in r for r in observed)
                row["processes"] = len(observed)
                row["sigkills"] = 21
                row["fileSeconds"] = (result["testResults"][0]["endTime"] - result["testResults"][0]["startTime"]) / 1000
                save(args.output / "timings.json", rows)
                print(name, round(elapsed, 3), "seconds, 25 passed, 75 fresh processes", flush=True)
    finally:
        metadata["loadAfter"] = os.getloadavg()
        save(args.output / "provenance.json", metadata)
        save(args.output / "timings.json", rows)


def kill_group(pid):
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass


if __name__ == "__main__":
    main()
