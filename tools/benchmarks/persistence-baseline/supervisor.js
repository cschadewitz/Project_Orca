/** Process-group deadlines and sampled resource bounds for synthetic benchmark children. */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { LIMITS } from "./model.js";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function usage(path, limits = LIMITS) {
  let bytes = 0;
  let files = 0;
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return []; // A demo child may remove its own temporary directory.
      throw error;
    });
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else {
        const info = await lstat(child).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        if (info) {
          files++;
          bytes += Math.max(info.size, info.blocks * 512);
        }
      }
      if (bytes > limits.diskBytes || files > limits.maxFiles) throw new Error("disk-or-file-limit");
    }
  }
  await visit(path);
  return { bytes, files };
}

// The watcher is outside the measured process. Its 1s scans still add host I/O; disclose that.
export async function supervise(args, { cwd, root, started, limits = LIMITS }) {
  const begin = performance.now();
  const remaining = limits.suiteMs - (begin - started);
  if (remaining <= 0) return { status: "unrun", reason: "suite-deadline" };
  const processHandle = spawn(process.execPath, ["--max-old-space-size=384", ...args], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: "C.UTF-8", NODE_ENV: "test" },
  });
  let stdout = "";
  let stderr = "";
  let reason;
  let peakGroupRssBytes = 0;
  let watching = false;
  let watchPromise = Promise.resolve();
  const stop = (why) => {
    reason ??= why;
    try {
      process.kill(-processHandle.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const timer = setTimeout(() => stop("timeout"), Math.min(limits.childMs, remaining));
  const watcher = setInterval(() => {
    if (watching) return;
    watching = true;
    watchPromise = (async () => {
      try {
        await usage(root, limits);
        const rows = execFileSync("ps", ["-eo", "pgid=,rss="], { encoding: "utf8", timeout: 5000 }).split("\n");
        const rss = rows.reduce((sum, line) => {
          const [group, kib] = line.trim().split(/\s+/).map(Number);
          return sum + (group === processHandle.pid ? kib * 1024 : 0);
        }, 0);
        peakGroupRssBytes = Math.max(peakGroupRssBytes, rss);
        if (rss > limits.rssBytes) stop("rss-limit");
      } catch (error) {
        stop(error.message === "disk-or-file-limit" ? error.message : `resource-monitor-${error.code ?? "failed"}`);
      } finally {
        watching = false;
      }
    })();
  }, 1000);
  processHandle.stdout.on("data", (bytes) => {
    if (Buffer.byteLength(stdout) + bytes.length > limits.outputBytes) stop("output-limit");
    else stdout += bytes;
  });
  processHandle.stderr.on("data", (bytes) => {
    if (Buffer.byteLength(stderr) + bytes.length > limits.outputBytes) stop("output-limit");
    else stderr += bytes;
  });
  const exit = await new Promise((done) => {
    processHandle.once("error", () => {
      reason = "spawn-failed";
    });
    processHandle.once("close", (code, signal) => done({ code, signal }));
  });
  clearTimeout(timer);
  clearInterval(watcher);
  await watchPromise;
  // Kill any descendants left after an exited leader, before deleting its scratch state.
  try {
    process.kill(-processHandle.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  return {
    status: exit.code === 0 && !reason ? "passed" : "failed",
    ...exit,
    reason,
    wallMs: performance.now() - begin,
    peakGroupRssBytes,
    stdout,
    stderrSha256: hash(stderr),
    stderrBytes: Buffer.byteLength(stderr),
  };
}
