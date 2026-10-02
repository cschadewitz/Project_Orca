/** Real CLI fixture and filesystem identity checks for native-intent acceptance. */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { realpathSync, statSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROTOCOL_VERSION, ResponseMessageSchema } from "@orca/protocol";

export const ADMISSION_WORKFLOW = "native-intent-smoke";
const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const cli = join(repoRoot, "packages/cli/dist/main.js");

export interface AdmissionDaemon {
  url: string;
  dir: string;
  /** Fixture credentials remain in this private file and never enter the renderer/report. */
  tokenFile: string;
  rpc(method: string, params?: unknown): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

export type OwnershipProbeEvidence =
  { stage: "ownership.flush"; outcome: "passed" } | { stage: "ownership.flush"; code: string };

/** Probe real native persistence separately from live daemon ownership or request seeding. */
async function probeOwnershipFlush(file: string, report: (evidence: OwnershipProbeEvidence) => void): Promise<void> {
  // Load this checkout's compiled class explicitly; do not let source aliases or a
  // sibling worktree's dependency links substitute a different implementation.
  const moduleUrl = pathToFileURL(join(repoRoot, "packages/daemon/dist/auth/ownership.js")).href;
  let ownership: import("@orca/daemon").OwnershipStore | undefined;
  try {
    const { OwnershipStore } = (await import(moduleUrl)) as typeof import("@orca/daemon");
    ownership = new OwnershipStore(file);
    ownership.record("probe", "probe");
    await ownership.flush("probe");
    if (new OwnershipStore(file).owner("probe") !== "probe") throw new Error("Probe attribution was not durable");
  } catch {
    const error = ownership?.lastError;
    const candidate = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const code = typeof candidate === "string" && /^E[A-Z0-9_]{1,31}$/.test(candidate) ? candidate : "UNKNOWN";
    const evidence = { stage: "ownership.flush", code } as const;
    report(evidence);
    // Never retain a cause: it can contain a path, raw platform message or protected data.
    throw new Error(JSON.stringify(evidence));
  }
  report({ stage: "ownership.flush", outcome: "passed" });
}

/** The runner and Electron share a filesystem; keep both absolute paths out of reports. */
export function profileDirectoryEvidence(expectedProfile: string, actualProfile: string) {
  try {
    const expected = statSync(expectedProfile, { bigint: true });
    const actual = statSync(actualProfile, { bigint: true });
    const directoryIdentityAvailable = expected.ino > 0n && actual.ino > 0n;
    return {
      rawProfileSpellingMatches: actualProfile === expectedProfile,
      canonicalProfileMatches: realpathSync.native(actualProfile) === realpathSync.native(expectedProfile),
      directoryIdentityAvailable,
      sameDirectoryIdentity:
        directoryIdentityAvailable &&
        expected.isDirectory() &&
        actual.isDirectory() &&
        expected.dev === actual.dev &&
        expected.ino === actual.ino,
    };
  } catch {
    throw new Error("The native-intent profile directories could not be inspected; profile identity is unverified");
  }
}

async function deadline<T>(action: Promise<T>, milliseconds: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Native-intent daemon timed out during ${phase}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  try {
    await deadline(exited, 5_000, "shutdown");
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await deadline(exited, 10_000, "forced child exit");
  }
}

/**
 * `orca demo` exercises program submission, agents, retries and a dependency graph. None
 * of those are prerequisites of the native storage contract. This fixture writes only a
 * workflow/config, then lets the built CLI create all authentication/store state itself.
 * Every admission and receipt still goes through production HTTP and runtime wiring.
 */
export async function startAdmissionDaemon(
  reportProbe: (evidence: OwnershipProbeEvidence) => void = () => {},
): Promise<AdmissionDaemon> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "orca-admission-daemon-")));
  let child: ChildProcess | undefined;
  try {
    await probeOwnershipFlush(join(dir, "ownership-probe.json"), reportProbe);
    await writeFile(
      join(dir, "intent.yaml"),
      JSON.stringify({
        id: ADMISSION_WORKFLOW,
        name: "Native intent acceptance",
        version: "1",
        start: "start",
        nodes: { start: { type: "start" }, done: { type: "end", outcome: "success" } },
        edges: [{ from: "start", to: "done" }],
      }),
    );
    const configPath = join(dir, "orca.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        storeDir: ".orca",
        workflows: ["intent.yaml"],
        templates: [],
        agents: [],
        program: { workflow: ADMISSION_WORKFLOW, itemWorkflow: ADMISSION_WORKFLOW },
        workspace: { provider: "local", root: dir, hostId: "local" },
      }),
    );
    const tokenFile = join(dir, "auth", "local-client.token");
    const serve = spawn(process.execPath, [cli, "--config", configPath, "serve", "--port", "0"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = serve;
    // Retain only the startup URL and an allowlisted error code, never raw daemon output.
    let errorCode: string | undefined;
    serve.stderr?.on("data", (bytes: Buffer) => {
      errorCode = /error \[([A-Z_]+)\]/.exec(bytes.toString())?.[1] ?? errorCode;
    });
    const listening = new Promise<string>((resolveReady, reject) => {
      let pending = "";
      serve.stdout?.on("data", (bytes: Buffer) => {
        pending += bytes.toString();
        let end: number;
        while ((end = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          const url = /^orca daemon \S+ listening on (http:\/\/127\.0\.0\.1:\d+)\s/.exec(line)?.[1];
          if (url) resolveReady(url);
        }
        if (pending.length > 4096) pending = "";
      });
      serve.once("error", () => reject(new Error("The native-intent CLI process could not be started")));
      serve.once("exit", (code, signal) =>
        reject(
          new Error(
            `Native-intent daemon exited before readiness (code ${String(code)}, signal ${String(signal)}, error ${errorCode ?? "unreported"})`,
          ),
        ),
      );
    });
    const url = await deadline(listening, 30_000, "startup");
    let nextId = 1;
    const rpc: AdmissionDaemon["rpc"] = async (method, params = {}) => {
      const token = (await readFile(tokenFile, "utf8")).trim();
      const response = await fetch(`${url}/rpc`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind: "request", id: nextId++, method, params }),
      });
      if (!response.ok) throw new Error(`${method} answered HTTP ${response.status}`);
      const envelope = ResponseMessageSchema.parse(await response.json());
      if (!envelope.ok) throw new Error(`${method} refused with ${envelope.error.code}`);
      if (!envelope.result || typeof envelope.result !== "object" || Array.isArray(envelope.result))
        throw new Error(`${method} returned an invalid fixture response`);
      return envelope.result as Record<string, unknown>;
    };
    await rpc("hello", { client: "orca-native-intent-smoke/0", protocol: PROTOCOL_VERSION });
    return {
      url,
      dir,
      tokenFile,
      rpc,
      stop: async () => {
        try {
          await terminate(serve);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      if (child) await terminate(child);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    throw error;
  }
}
