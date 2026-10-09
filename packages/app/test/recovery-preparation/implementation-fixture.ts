import { previewText } from "./preview-text.js";
/** Actual encrypted-disk/controller fixtures with synthetic key protection and Linux publication. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { FileHandle } from "node:fs/promises";
import { RecoveryController } from "../../src/main/diagnostics/recovery-controller.js";
import { NodeRecoveryDisk } from "../../src/main/diagnostics/recovery-disk.js";
import { LinuxFixtureNativeAdapter } from "../../src/main/diagnostics/native-adapter.js";
import type { DiagnosticsKeyAdapter } from "../../src/main/diagnostics/native-adapter.js";
import type { BootReading, StageIdentity } from "../../src/main/diagnostics/recovery-contract.js";
import { RECOVERY_LIMITS } from "../../src/main/diagnostics/recovery-contract.js";
import type { DiagnosticsResult } from "../../src/diagnostics-contract.js";

const runFile = promisify(execFile);
let helperPromise: Promise<string> | undefined;
let ownedHelperDirectory: string | undefined;

/** One supervised compiler per suite; crash children borrow this immutable test executable. */
export function compiledFixtureHelper(): Promise<string> {
  helperPromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "orca-recovery-helper-"));
    ownedHelperDirectory = directory;
    const helper = join(directory, "linux-native-fixture");
    const source = fileURLToPath(new URL("../../native/diagnostics/linux-fixture.c", import.meta.url));
    await compileHelper(source, helper, directory);
    return helper;
  })();
  return helperPromise;
}

function compileHelper(source: string, helper: string, temporary: string): Promise<void> {
  const child = spawn("/usr/bin/cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", helper], {
    detached: true,
    stdio: "ignore",
    env: { PATH: "/usr/bin:/bin", TMPDIR: temporary },
  });
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    }, 10_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Synthetic helper compiler unavailable"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve();
      else
        reject(
          new Error(timedOut ? "Synthetic helper compiler exceeded deadline" : "Synthetic helper compiler failed"),
        );
    });
  });
}

export function borrowFixtureHelper(path: string): void {
  helperPromise = Promise.resolve(path);
}
export async function cleanupFixtureHelper(): Promise<void> {
  if (ownedHelperDirectory) await rm(ownedHelperDirectory, { recursive: true, force: true });
  ownedHelperDirectory = undefined;
  helperPromise = undefined;
}

/** Linux-only syscall, explicitly outside native Mac/Windows acceptance. No copy/link fallback. */
export async function moveNoReplace(source: string, destination: string): Promise<"saved" | "refused" | "unknown"> {
  const identity = await lstat(source);
  const helper = await compiledFixtureHelper();
  const result = await runFile(
    helper,
    ["move", dirname(source), destination, String(identity.dev), String(identity.ino)],
    { timeout: 5000, maxBuffer: 64, env: {} },
  );
  const outcome = result.stdout.trim();
  if (outcome !== "saved" && outcome !== "refused" && outcome !== "unknown")
    throw new Error("Invalid fixture publication outcome");
  return outcome;
}

/** Persistently reproducible synthetic KEK. It is never an OS-protection claim or execution key. */
export class SyntheticKeys implements DiagnosticsKeyAdapter {
  protected readonly key = createHash("sha256").update("ORCA disposable fixture only").digest();
  usable = true;
  available(): Promise<boolean> {
    return Promise.resolve(this.usable);
  }
  wrap(bytes: Buffer): Promise<Buffer> {
    if (!this.usable) return Promise.reject(new Error("fixture key unavailable"));
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Promise.resolve(Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]));
  }
  unwrap(bytes: Buffer): Promise<Buffer> {
    if (!this.usable) return Promise.reject(new Error("fixture key unavailable"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Promise.resolve(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]));
  }
}

export class ControlledNative extends LinuxFixtureNativeAdapter {
  writerAlive = false;
  publishCalls = 0;
  beforeReplace: ((source: string, destination: string) => Promise<void>) | undefined;
  afterReplace: ((source: string, destination: string) => Promise<void>) | undefined;
  beforeWrite: ((handle: FileHandle, bytes: Buffer) => Promise<void>) | undefined;
  beforeRemove: ((path: string) => Promise<void>) | undefined;
  beforePublish: (() => Promise<void>) | undefined;
  publication: ((stage: string, destination: string) => Promise<"saved" | "refused" | "unknown">) | undefined;

  constructor(helper: string) {
    super({ helper, stopped: () => Promise.resolve(!this.writerAlive) });
  }
  override async replace(source: string, destination: string): Promise<void> {
    await this.beforeReplace?.(source, destination);
    await super.replace(source, destination);
    await this.afterReplace?.(source, destination);
  }
  override async write(handle: FileHandle, bytes: Buffer): Promise<void> {
    await this.beforeWrite?.(handle, bytes);
    await super.write(handle, bytes);
  }
  override async remove(path: string): Promise<void> {
    await this.beforeRemove?.(path);
    await super.remove(path);
  }
  override async publish(
    root: string,
    stage: string,
    destination: string,
    identity: StageIdentity,
    admit: () => boolean,
  ): Promise<"saved" | "refused" | "unknown"> {
    this.publishCalls += 1;
    await this.beforePublish?.();
    if (this.publication) {
      if (!(await this.validateDestination(root, destination)) || !admit()) return "refused";
      return this.publication(stage, destination);
    }
    return super.publish(root, stage, destination, identity, admit);
  }
}

export function value<T>(result: DiagnosticsResult<T>): T {
  if (!result.ok) throw new Error(`Fixture action refused: ${result.code}`);
  return result.value;
}

export async function implementationFixture(
  profile: string,
  options: {
    native?: ControlledNative;
    keys?: SyntheticKeys;
    productionEnabled?: boolean;
    timeoutMs?: number;
    reading?: BootReading;
  } = {},
) {
  const root = join(profile, "private");
  const helper = await compiledFixtureHelper();
  const native = options.native ?? new ControlledNative(helper);
  const keys = options.keys ?? new SyntheticKeys();
  const disk = new NodeRecoveryDisk({ root, native, keys });
  const clock = {
    reading: options.reading ?? { bootId: "synthetic-boot", elapsedMs: 1000 },
    read() {
      return this.reading;
    },
  };
  const picker = { destination: join(profile, "report.json"), calls: 0 };
  const controller = new RecoveryController({
    disk,
    clock,
    productionEnabled: options.productionEnabled ?? true,
    operationTimeoutMs: options.timeoutMs ?? RECOVERY_LIMITS.operationMs,
    chooseDestination: () => {
      picker.calls += 1;
      return Promise.resolve(picker.destination);
    },
  });
  await controller.initialize();
  return { controller, disk, root, clock, native, keys, picker };
}

export async function enableAndPreview(fixture: Awaited<ReturnType<typeof implementationFixture>>) {
  value(await fixture.controller.setEnabled(true, 1));
  fixture.controller.record("connection", "connection_lost");
  fixture.clock.reading.elapsedMs += 100;
  return await previewText(fixture.controller, value(await fixture.controller.preparePreview("current")));
}
