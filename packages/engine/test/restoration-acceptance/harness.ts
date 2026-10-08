/** Bounded owned subprocesses, with a minimal environment and no raw child output in test failures. */
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertOwned,
  containsCanary,
  type Action,
  type AuthorityMode,
  type Fixture,
  type Report,
  type VerificationMode,
} from "./fixture.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const entry = fileURLToPath(new URL("worker.ts", import.meta.url));
const maxOutput = 16 * 1024;

export class ProcessHarness {
  private readonly children = new Set<ChildProcess>();
  private readonly closures = new Map<ChildProcess, Promise<void>>();
  async invoke(
    fixture: Fixture,
    action: Action,
    authority?: AuthorityMode,
    verification?: VerificationMode,
  ): Promise<Report> {
    const { result } = await this.start(fixture, action, authority, verification);
    return result;
  }
  async start(fixture: Fixture, action: Action, authority?: AuthorityMode, verification?: VerificationMode) {
    await assertOwned(fixture);
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"])
      if (process.env[name] !== undefined) env[name] = process.env[name];
    const child = fork(entry, [], {
      cwd: root,
      execPath: process.execPath,
      execArgv: ["--import", "tsx"],
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.children.add(child);
    let heldResolve!: () => void;
    const heldBarrier = new Promise<void>((resolve) => {
      heldResolve = resolve;
    });
    let report: Report | undefined;
    let failure: Error | undefined;
    let output = 0;
    let outputText = "";
    let sawHeld = false;
    let resolveResult!: (report: Report) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<Report>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // Holding a lease has a separate barrier; failures still reject the result and held wait.
    const timer = setTimeout(() => {
      failure = new Error("Owned restoration fixture timed out");
      child.kill("SIGTERM");
    }, 15_000);
    const closed = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        this.children.delete(child);
        this.closures.delete(child);
        if (failure || code !== 0 || signal || !report)
          rejectResult(failure ?? new Error("Owned restoration fixture exited without valid evidence"));
        else {
          report.logLeak ||= containsCanary(outputText);
          resolveResult(report);
        }
        heldResolve();
        resolve();
      });
    });
    this.closures.set(child, closed);
    child.on("error", () => {
      failure = new Error("Could not start owned restoration fixture");
    });
    for (const stream of [child.stdout!, child.stderr!])
      stream.on("data", (bytes: Buffer) => {
        output += bytes.length;
        if (output <= maxOutput) outputText += bytes.toString("utf8");
        if (output > maxOutput) {
          failure = new Error("Owned restoration fixture exceeded output bound");
          child.kill("SIGTERM");
        }
      });
    child.on("message", (value: unknown) => {
      if (value && typeof value === "object" && "held" in value && value.held === true && action === "hold-lease") {
        sawHeld = true;
        heldResolve();
        return;
      }
      if (
        !isReport(value) ||
        value.pid !== child.pid ||
        report ||
        Buffer.byteLength(JSON.stringify(value)) > maxOutput
      ) {
        failure = new Error("Owned restoration fixture returned malformed evidence");
        child.kill("SIGTERM");
      } else report = value;
    });
    child.send(
      {
        action,
        root: fixture.root,
        owner: fixture.owner,
        ...(authority ? { authority } : {}),
        ...(verification ? { verification } : {}),
      },
      (error) => {
        if (error) {
          failure = new Error("Owned restoration fixture command was lost");
          child.kill("SIGTERM");
        }
      },
    );
    return {
      result,
      held:
        action === "hold-lease"
          ? Promise.race([
              heldBarrier.then(() => {
                if (!sawHeld) throw new Error("Fixture closed before lease ownership barrier");
              }),
              result.then(() => {
                if (!sawHeld) throw new Error("Fixture did not prove lease ownership");
              }),
            ])
          : Promise.resolve(),
      release: () => {
        if (child.connected) child.send({ release: true });
      },
    };
  }
  async dispose(): Promise<void> {
    const pending = [...this.closures.values()];
    for (const child of this.children) child.kill("SIGTERM");
    await Promise.all(pending);
  }
}
function isReport(value: unknown): value is Report {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<Report>;
  return (
    Number.isSafeInteger(r.pid) &&
    typeof r.bootId === "string" &&
    typeof r.nodeVersion === "string" &&
    typeof r.runtimeSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(r.runtimeSha256) &&
    ["ok", "refused", "response-lost"].includes(r.outcome ?? "") &&
    [r.provisioned, r.providerCalls, r.permissionDelivered, r.consentWrites].every(
      (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
    ) &&
    [r.publicLeak, r.logLeak, r.errorLeak].every((flag) => typeof flag === "boolean")
  );
}

/** Read/hash fixture-owned evidence only. Never serialize protected plaintext or keys. */
export async function protectedDigests(fixture: Fixture): Promise<Record<string, string>> {
  await assertOwned(fixture);
  const result: Record<string, string> = {};
  for (const directory of ["private-execution", "private-workflows"]) {
    const path = join(fixture.root, "store", directory);
    const names = await readdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of names.sort()) {
      const file = join(path, name);
      if (!(await lstat(file)).isFile()) throw new Error("Unexpected fixture evidence file type");
      result[`${directory}/${name}`] = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    }
  }
  return result;
}
