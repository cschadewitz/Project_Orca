/**
 * Authenticated standalone-bundle hello evidence, using only an owned synthetic workspace.
 * Run after build and build:daemon: node tools/probe-bundled-daemon.js [bundle.mjs]
 * This is not signed/packaged Mac acceptance. Child output and credentials are never logged.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultBundle = fileURLToPath(new URL("../packages/app/dist/daemon/orca-daemon.mjs", import.meta.url));
const MAX_OUTPUT = 64 * 1024;

class ProbeError extends Error {
  constructor(code) {
    super(`Bundled daemon probe failed [${code}]`);
    this.code = code;
  }
}

async function builtContract() {
  try {
    const { DaemonClient } = await import("../packages/app/dist/client/daemon-client.js");
    const { LocalDaemonToken } = await import("../packages/app/dist/client/auth.js");
    const { PROTOCOL_VERSION, isCompatible } = await import("../packages/protocol/dist/index.js");
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    return { DaemonClient, LocalDaemonToken, PROTOCOL_VERSION, isCompatible, version };
  } catch {
    throw new ProbeError("BUILD_REQUIRED");
  }
}

/** Allowlist OS essentials; do not inherit ORCA, Node injection, proxy or operator settings. */
function childEnvironment(workspace) {
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (["SYSTEMROOT", "WINDIR"].includes(key.toUpperCase())) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: workspace,
    USERPROFILE: workspace,
    XDG_CONFIG_HOME: workspace,
    XDG_DATA_HOME: workspace,
    XDG_CACHE_HOME: workspace,
    TMPDIR: workspace,
    TMP: workspace,
    TEMP: workspace,
  };
}

/**
 * Direct HTTP avoids parent fetch/proxy environment overrides. The client still owns the
 * headers, body and schemas; this adapter only bounds transport and never follows redirects.
 */
function boundedFetch(url, init, signal) {
  const target = new URL(url);
  if (
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    target.pathname !== "/rpc" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new ProbeError("HTTP_TARGET");
  return new Promise((resolveResponse, reject) => {
    const req = request(
      target,
      {
        method: init.method,
        headers: init.headers,
        signal: AbortSignal.any([signal, init.signal]),
        agent: false,
      },
      (response) => {
        const status = response.statusCode;
        if (status !== 200 && status !== 401 && status !== 403) {
          response.destroy();
          reject(new ProbeError("HTTP_RESPONSE"));
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT) {
            reject(new ProbeError("RESPONSE_LIMIT"));
            response.destroy();
            req.destroy();
          } else chunks.push(chunk);
        });
        response.once("error", () => reject(new ProbeError("HTTP_RESPONSE")));
        response.once("end", () => resolveResponse(new Response(Buffer.concat(chunks), { status })));
      },
    );
    req.once("error", reject);
    req.end(init.body);
  });
}

/** Reap only the spawned process; a failed stop preserves its files and refuses a pass. */
async function stopOwnedChild(child, closed, hasClosed, timeoutMs) {
  const waitForClose = async () => {
    let timer;
    try {
      await Promise.race([
        closed,
        new Promise((resolveWait) => {
          timer = setTimeout(resolveWait, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  if (!hasClosed()) {
    child.kill("SIGTERM");
    await waitForClose();
    if (!hasClosed()) {
      child.kill("SIGKILL");
      await waitForClose();
    }
    if (!hasClosed()) throw new ProbeError("STOP_TIMEOUT");
  }
}

/** Test seams supply the same source client/contract, never a production endpoint or token. */
export async function probeBundledDaemon({
  bundlePath = defaultBundle,
  timeoutMs = 15_000,
  stopTimeoutMs = 2_000,
  tempParent = tmpdir(),
  contract,
} = {}) {
  for (const value of [timeoutMs, stopTimeoutMs]) {
    if (!Number.isInteger(value) || value < 1 || value > 60_000) throw new ProbeError("INVALID_TIMEOUT");
  }
  const runtime = contract ?? (await builtContract());
  const entry = resolve(bundlePath);
  const workspace = await realpath(await mkdtemp(join(tempParent, "orca-synthetic-bundle-probe-")));
  const config = join(workspace, "orca.config.yaml");
  const tokenFile = join(workspace, "auth", "local-client.token");
  const controller = new AbortController();
  let child;
  let closed;
  let didClose = false;
  let stopping = false;
  let timer;
  let rejectFailure;
  const failure = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  // Failure may arrive between awaits. Observe it immediately, then race every child operation.
  failure.catch(() => undefined);
  const fail = (code) => {
    controller.abort();
    rejectFailure(new ProbeError(code));
  };
  const interrupted = () => fail("INTERRUPTED");
  try {
    await writeFile(config, "# Explicitly synthetic CI probe; no agents or workflows.\nworkflows: []\ntemplates: []\n");
    await mkdir(join(workspace, "auth"), { mode: 0o700 });
    process.on("SIGINT", interrupted);
    process.on("SIGTERM", interrupted);
    timer = setTimeout(() => fail("TIMEOUT"), timeoutMs);
    child = spawn(
      process.execPath,
      [entry, "serve", "--cwd", workspace, "--config", config, "--host", "127.0.0.1", "--port", "0"],
      {
        cwd: workspace,
        env: childEnvironment(workspace),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    closed = new Promise((resolveClosed) => {
      child.once("close", () => {
        didClose = true;
        resolveClosed();
        if (!stopping) fail("EARLY_EXIT");
      });
    });
    child.once("error", () => fail("SPAWN"));
    let url;
    let authenticated = false;
    let resolveReady;
    const ready = new Promise((resolveReadiness) => {
      resolveReady = resolveReadiness;
    });
    let outputBytes = 0;
    let pending = "";
    const countOutput = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT) {
        fail("OUTPUT_LIMIT");
        return false;
      }
      return true;
    };
    child.stderr.on("data", countOutput);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (!countOutput(Buffer.from(chunk))) return;
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line.startsWith("orca daemon ")) {
          const match = /^orca daemon \S+ listening on (http:\/\/127\.0\.0\.1:(\d+)) \(protocol [^)]+\)$/.exec(line);
          if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) {
            fail("READINESS");
            return;
          }
          url = match[1];
        }
        if (line.startsWith("authentication:")) {
          if (line !== `authentication: token; local token file: ${tokenFile}`) {
            fail("AUTH_METADATA");
            return;
          }
          authenticated = true;
        }
        if (url && authenticated) resolveReady(url);
      }
    });
    const target = await Promise.race([ready, failure]);
    const auth = new runtime.LocalDaemonToken({ url: target, tokenFile, env: {} });
    const client = new runtime.DaemonClient(target, (url, init) => boundedFetch(url, init, controller.signal), {
      auth,
      requireAuthentication: true,
    });
    let hello;
    try {
      hello = await Promise.race([client.hello("bundled-daemon-ci-probe", false), failure]);
    } catch (error) {
      if (error instanceof ProbeError) throw error;
      const code = error?.error?.code;
      throw new ProbeError(
        ["AUTH_REQUIRED", "AUTH_INVALID", "AUTH_FORBIDDEN", "PROTOCOL_MESSAGE", "PROTOCOL_VERSION"].includes(code)
          ? code
          : "HELLO_RESPONSE",
      );
    }
    if (
      !runtime.isCompatible(runtime.PROTOCOL_VERSION, hello.protocol) ||
      hello.protocol.major !== runtime.PROTOCOL_VERSION.major ||
      hello.protocol.minor !== runtime.PROTOCOL_VERSION.minor
    )
      throw new ProbeError("PROTOCOL_VERSION");
    if (hello.orcaVersion !== runtime.version) throw new ProbeError("RELEASE_VERSION");
    if (hello.processId !== child.pid || hello.storeDir !== join(workspace, ".orca"))
      throw new ProbeError("CHILD_IDENTITY");
    if (!hello.methods?.includes("hello") || !hello.capabilities.includes("runs.control"))
      throw new ProbeError("HELLO_CONTRACT");
    if (didClose || controller.signal.aborted) await failure;
    return { authenticated: true, orcaVersion: hello.orcaVersion, protocol: hello.protocol };
  } finally {
    stopping = true;
    clearTimeout(timer);
    controller.abort();
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    if (child) await stopOwnedChild(child, closed, () => didClose, stopTimeoutMs);
    await rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new ProbeError("USAGE");
    console.log(
      JSON.stringify(await probeBundledDaemon({ ...(process.argv[2] ? { bundlePath: process.argv[2] } : {}) })),
    );
  } catch (error) {
    console.error(error instanceof ProbeError ? error.message : "Bundled daemon probe failed [LOCAL_SETUP]");
    process.exitCode = 1;
  }
}
