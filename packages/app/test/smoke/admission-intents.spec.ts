/** Real native safeStorage, production IPC and authenticated admission across an Electron restart. */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunsListResultSchema } from "@orca/protocol";
import type { OrcaBridge } from "../../src/bridge.js";
import {
  ADMISSION_WORKFLOW,
  profileDirectoryEvidence,
  startAdmissionDaemon,
  type AdmissionDaemon,
} from "./admission-daemon.js";

const appDir = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const clientModule = join(appDir, "dist/client/daemon-client.js");
const workflowId = ADMISSION_WORKFLOW;
const phaseTimeout = 30_000;

interface IntentWindow {
  orca: Pick<OrcaBridge, "admissionIntents" | "daemonConnection" | "connection">;
}
interface Discovery {
  principalId: string;
  authentication: string;
  target: { workspaceId: string; instanceId: string };
  canAdmit: boolean;
}
interface Receipt {
  state: string;
  operationId: string;
  admissionId: string;
  runId: string;
}
interface Observation {
  methods: string[];
  discoveries: Discovery[];
  admissions: Receipt[];
}
interface ObservedMain {
  orcaIntentSmoke: Observation;
}

/** A Keychain prompt can block Electron's main thread, so the watchdog lives in Node. */
async function bounded<T>(action: Promise<T>, phase: string, timeout = phaseTimeout): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Native run-intent acceptance blocked during ${phase}. OS permission or keychain access may require human approval; no security settings were changed.`,
              ),
            ),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Kill only this disposable child if a native permission dialog prevents graceful quit. */
async function closeApp(app: ElectronApplication, requireGraceful = false): Promise<void> {
  const child = app.process();
  const exited = child.exitCode === null && child.signalCode === null ? once(child, "exit") : undefined;
  let forced = false;
  try {
    await bounded(app.close(), "Electron shutdown", 5_000);
  } catch {
    forced = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  if (exited) await bounded(exited, "Electron process exit", 10_000);
  if (requireGraceful && forced)
    throw new Error(
      "Native run-intent acceptance blocked during Electron shutdown; the disposable child was terminated without approving any OS prompt.",
    );
}

async function launch(daemon: AdmissionDaemon, profile: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !["ELECTRON_RUN_AS_NODE", "ORCA_RENDERER_URL", "ORCA_DAEMON_TOKEN"].includes(key))
      env[key] = value;
  }
  env.ORCA_DAEMON_URL = daemon.url;
  env.ORCA_DAEMON_TOKEN_FILE = daemon.tokenFile;
  // No sandbox opt-out, alternate password store, synthetic encryption or development renderer.
  const app = await electron.launch({ args: [`--user-data-dir=${profile}`, appDir], env, timeout: phaseTimeout });
  try {
    const page = await app.firstWindow({ timeout: phaseTimeout });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => {
      const bridge = (window as unknown as IntentWindow).orca;
      return bridge?.connection.read().state === "live" && bridge.daemonConnection?.read().identity !== undefined;
    });
    await observe(app);
    return { app, page };
  } catch (error) {
    await closeApp(app);
    throw error;
  }
}

/**
 * Observe the real, already-built client. Forward all arguments and results unchanged.
 * Only method names and public discovery/receipt identifiers survive this wrapper.
 * In particular, do not capture params, retry keys, HTTP headers, credentials or errors.
 */
async function observe(app: ElectronApplication): Promise<void> {
  await bounded(
    app.evaluate(({ app }, modulePath) => {
      // Inspector-evaluated functions have no dynamic-import callback. Node's supported
      // synchronous ESM require reaches the same already-loaded, top-level-await-free
      // client module, without changing the production app entry point or transport.
      const requireFromApp = process
        .getBuiltinModule("module")
        .createRequire(process.getBuiltinModule("path").join(app.getAppPath(), "package.json"));
      const { DaemonClient } = requireFromApp(modulePath) as typeof import("../../src/client/daemon-client.js");
      const observation: Observation = { methods: [], discoveries: [], admissions: [] };
      (globalThis as unknown as ObservedMain).orcaIntentSmoke = observation;
      // The wrapper below explicitly restores the caller's `this` with apply.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const original = DaemonClient.prototype.call;
      DaemonClient.prototype.call = async function (
        this: InstanceType<typeof DaemonClient>,
        ...args: Parameters<typeof original>
      ) {
        const method = args[0];
        if (method === "operator.discover" || method === "runs.admit") observation.methods.push(method);
        const result: unknown = await original.apply(this, args);
        if (result && typeof result === "object") {
          const value = result as Record<string, unknown>;
          const field = (source: Record<string, unknown>, key: string): string =>
            typeof source[key] === "string" ? source[key] : "";
          if (method === "operator.discover") {
            const target =
              value.target && typeof value.target === "object" ? (value.target as Record<string, unknown>) : {};
            observation.discoveries.push({
              principalId: field(value, "principalId"),
              authentication: field(value, "authentication"),
              target: { workspaceId: field(target, "workspaceId"), instanceId: field(target, "instanceId") },
              canAdmit: Array.isArray(value.operations) && value.operations.includes("runs.admit"),
            });
          }
          if (method === "runs.admit")
            observation.admissions.push({
              state: field(value, "state"),
              operationId: field(value, "operationId"),
              admissionId: field(value, "admissionId"),
              runId: field(value, "runId"),
            });
        }
        return result;
      } as typeof original;
    }, clientModule),
    "installing the public RPC observer",
  );
}

async function observation(app: ElectronApplication): Promise<Observation> {
  return bounded(
    app.evaluate(() => (globalThis as unknown as ObservedMain).orcaIntentSmoke),
    "reading public RPC evidence",
  );
}

async function storageStatus(app: ElectronApplication, profile: string) {
  const { userDataPath, ...status } = await bounded(
    app.evaluate(({ app, safeStorage }) => ({
      platform: process.platform,
      electronVersion: process.versions.electron,
      ready: app.isReady(),
      userDataPath: app.getPath("userData"),
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      // This API is Linux-only; the provider label below is explicitly platform-derived.
      selectedStorageBackend: process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : null,
      platformProvider:
        process.platform === "darwin"
          ? "macOS Keychain"
          : process.platform === "win32"
            ? "Windows DPAPI"
            : "Linux secret service",
    })),
    "querying native safeStorage",
  );
  // Chromium canonicalizes its profile path. Compare the actual main-process path
  // with the requested physical directory, then discard both path strings from evidence.
  return { ...status, ...profileDirectoryEvidence(profile, userDataPath) };
}

async function journalEvidence(profile: string, knownPublicStrings: string[]) {
  const bytes = await readFile(join(profile, "admission-intents.enc"));
  let isJson = false;
  try {
    JSON.parse(bytes.toString("utf8"));
    isJson = true;
  } catch {
    /* Ciphertext is not a JSON journal. */
  }
  return {
    nonempty: bytes.length > 0,
    isJson,
    containsKnownPlaintext: knownPublicStrings.some((value) => bytes.includes(Buffer.from(value))),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function runIds(daemon: AdmissionDaemon): Promise<string[]> {
  const ids: string[] = [];
  for (;;) {
    const page = RunsListResultSchema.parse(await daemon.rpc("runs.list", { offset: ids.length, limit: 100 }));
    ids.push(...page.runs.map((run) => run.id));
    if (ids.length >= page.total) return ids.sort();
    if (page.runs.length === 0) throw new Error("The disposable daemon returned an incomplete run page");
  }
}

async function assertDiscovery(page: Page, found: Discovery | undefined): Promise<Discovery> {
  expect(found).toBeDefined();
  expect(found!.authentication).toBe("credential");
  expect(found!.principalId.length).toBeGreaterThan(0);
  expect(found!.canAdmit).toBe(true);
  const target = await page.evaluate(() => (window as unknown as IntentWindow).orca.daemonConnection!.read().identity);
  expect(found!.target).toEqual(target);
  return found!;
}

/** Evidence-upload failure must never leave a fixture process or profile behind. */
async function finish(
  name: string,
  evidence: Record<string, unknown>,
  app: ElectronApplication | undefined,
  daemon: AdmissionDaemon | undefined,
  profile: string,
): Promise<void> {
  try {
    await test.info().attach(name, {
      body: Buffer.from(JSON.stringify(evidence, null, 2)),
      contentType: "application/json",
    });
  } finally {
    try {
      if (app) await closeApp(app);
    } finally {
      try {
        await daemon?.stop();
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    }
  }
}

test("native encrypted intent recovers one server admission after a complete Electron restart", async () => {
  const requestedProfile = await mkdtemp(join(tmpdir(), "orca-native-intent-"));
  const profile = await realpath(requestedProfile);
  const evidence: Record<string, unknown> = {
    encryption: "unmodified Electron safeStorage",
    restart: "full process exit and relaunch",
    profileInputWasCanonical: requestedProfile === profile,
    daemonFixture: "real CLI serve; agent-free start-to-end workflow",
  };
  let daemon: AdmissionDaemon | undefined;
  let app: ElectronApplication | undefined;
  try {
    daemon = await startAdmissionDaemon((probe) => {
      evidence.ownershipProbe = probe;
    });
    const before = await runIds(daemon);
    let launched = await launch(daemon, profile);
    app = launched.app;
    const firstPid = app.process().pid;
    const firstStorage = await storageStatus(app, profile);
    evidence.firstStorage = firstStorage;
    expect(firstStorage.ready, "Electron must be ready before native acceptance").toBe(true);
    expect(firstStorage.canonicalProfileMatches, "Electron must use the requested canonical profile").toBe(true);
    expect(firstStorage.directoryIdentityAvailable, "A meaningful filesystem directory identity is required").toBe(
      true,
    );
    expect(firstStorage.sameDirectoryIdentity, "Electron must use the same physical profile directory").toBe(true);
    expect(
      firstStorage.encryptionAvailable,
      "Native secure storage is unavailable; positive acceptance is blocked, never skipped",
    ).toBe(true);
    expect(firstStorage.selectedStorageBackend).not.toBe("basic_text");
    const first = await bounded(
      launched.page.evaluate((id) => (window as unknown as IntentWindow).orca.admissionIntents!.start(id), workflowId),
      "persisting and submitting the first native intent",
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Native secure storage/admission did not accept the first intent");
    const firstObservation = await observation(app);
    evidence.firstObservation = firstObservation;
    expect(firstObservation.methods).toEqual(["operator.discover", "runs.admit"]);
    const discovered = await assertDiscovery(launched.page, firstObservation.discoveries[0]);
    expect(firstObservation.admissions).toHaveLength(1);
    const receipt = firstObservation.admissions[0]!;
    expect(receipt).toMatchObject({ state: "accepted", runId: first.result.runId });
    expect(receipt.operationId).toMatch(/^retry_[a-f0-9-]{36}$/);
    const retained = await bounded(
      launched.page.evaluate(() => (window as unknown as IntentWindow).orca.admissionIntents!.list()),
      "reading the retained native intent",
    );
    expect(retained.ok && retained.result.length).toBe(1);
    const publicStrings = [workflowId, discovered.principalId, discovered.target.workspaceId, daemon.url];
    const encrypted = await journalEvidence(profile, publicStrings);
    evidence.firstJournal = encrypted;
    expect(encrypted).toMatchObject({ nonempty: true, isJson: false, containsKnownPlaintext: false });
    await expect
      .poll(async () => (await runIds(daemon!)).filter((id) => !before.includes(id)))
      .toEqual([first.result.runId]);
    await closeApp(app, true);
    app = undefined;

    launched = await launch(daemon, profile);
    app = launched.app;
    evidence.newProcess = app.process().pid !== firstPid;
    expect(evidence.newProcess).toBe(true);
    const secondStorage = await storageStatus(app, profile);
    evidence.secondStorage = secondStorage;
    expect(secondStorage.ready).toBe(true);
    expect(secondStorage.canonicalProfileMatches).toBe(true);
    expect(secondStorage.directoryIdentityAvailable).toBe(true);
    expect(secondStorage.sameDirectoryIdentity).toBe(true);
    expect(secondStorage.encryptionAvailable).toBe(true);
    expect(secondStorage.selectedStorageBackend).not.toBe("basic_text");
    const reopened = await bounded(
      launched.page.evaluate(() => (window as unknown as IntentWindow).orca.admissionIntents!.list()),
      "decrypting the retained intent after restart",
    );
    expect(reopened).toEqual(retained);
    const second = await bounded(
      launched.page.evaluate((id) => (window as unknown as IntentWindow).orca.admissionIntents!.start(id), workflowId),
      "recovering the original admission after restart",
    );
    expect(second).toEqual(first);
    const secondObservation = await observation(app);
    evidence.secondObservation = secondObservation;
    expect(secondObservation.methods).toEqual(["operator.discover", "operator.discover", "runs.admit"]);
    for (const found of secondObservation.discoveries)
      expect(await assertDiscovery(launched.page, found)).toEqual(discovered);
    expect(secondObservation.admissions).toEqual([receipt]);
    expect(await daemon.rpc("admissions.get", { operationId: receipt.operationId })).toMatchObject({
      state: "resolved",
      operationId: receipt.operationId,
      result: { state: "accepted", admissionId: receipt.admissionId, runId: receipt.runId },
    });
    expect((await runIds(daemon)).filter((id) => !before.includes(id))).toEqual([first.result.runId]);
    expect(await journalEvidence(profile, publicStrings)).toEqual(encrypted);
    evidence.accepted = true;
  } finally {
    await finish("native-intent-evidence.json", evidence, app, daemon, profile);
  }
});

test("actual app refuses admission when the availability check is false", async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "orca-unavailable-intent-")));
  const evidence: Record<string, unknown> = {
    negativeFault: "process-local availability-only injection; no OS settings changed",
    daemonFixture: "real CLI serve; agent-free start-to-end workflow",
  };
  let daemon: AdmissionDaemon | undefined;
  let app: ElectronApplication | undefined;
  try {
    daemon = await startAdmissionDaemon((probe) => {
      evidence.ownershipProbe = probe;
    });
    const before = await runIds(daemon);
    const launched = await launch(daemon, profile);
    app = launched.app;
    // Do not query the real Keychain here: this independent negative case must still run
    // when the positive test is blocked by native availability or an OS permission prompt.
    await bounded(
      app.evaluate(({ safeStorage }) => {
        safeStorage.isEncryptionAvailable = () => false;
        if (safeStorage.isEncryptionAvailable()) throw new Error("The availability-only fault was not installed");
      }),
      "injecting unavailable storage in the disposable process",
    );
    const negativeStorage = await storageStatus(app, profile);
    evidence.storageAfterFault = negativeStorage;
    expect(negativeStorage.ready).toBe(true);
    expect(negativeStorage.canonicalProfileMatches).toBe(true);
    expect(negativeStorage.directoryIdentityAvailable).toBe(true);
    expect(negativeStorage.sameDirectoryIdentity).toBe(true);
    expect(negativeStorage.encryptionAvailable).toBe(false);
    const result = await bounded(
      launched.page.evaluate((id) => (window as unknown as IntentWindow).orca.admissionIntents!.start(id), workflowId),
      "checking unavailable-storage refusal",
    );
    // The guidance names the cause (#857): the OS keychain, a locked or cancelled Linux keyring,
    // or Linux basic_text. Every variant is the same fail-closed refusal with nothing submitted.
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PROTECTED_STORAGE",
        message: expect.stringMatching(/^Secure run-intent storage is unavailable\. No run was submitted[.;] /),
        details: { reason: expect.stringMatching(/^(keyring-locked|no-keyring|unavailable)$/) },
      },
    });
    const observed = await observation(app);
    evidence.observation = observed;
    expect(observed.methods).toEqual(["operator.discover"]);
    expect(observed.admissions).toEqual([]);
    await assertDiscovery(launched.page, observed.discoveries[0]);
    expect(await runIds(daemon)).toEqual(before);
    await expect(readFile(join(profile, "admission-intents.enc"))).rejects.toMatchObject({ code: "ENOENT" });
    evidence.refusedBeforeAdmission = true;
  } finally {
    await finish("unavailable-intent-evidence.json", evidence, app, daemon, profile);
  }
});
