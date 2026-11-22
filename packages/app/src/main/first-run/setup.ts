/** Dedicated first-run provisioning. Native selections are reviewed, identity-fenced and never overwritten. */
import {
  windowsDirectory,
  windowsPrivateChild,
  windowsRead,
  windowsWrite,
  windowsFile,
} from "@orca/protocol/first-run-fence";

import { constants } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { FirstRunOwnershipRefusal, inspectFirstRunOwnership, absent } from "./ownership.js";
import { parse as parseYaml } from "yaml";
import {
  FirstRunRecovery,
  bindQuiescentConfiguration,
  endPreviousBootSession,
  previousBootAttempt,
} from "./recovery.js";
import { inspectLocalTool } from "./agent-preflight.js";
import { FirstRunRefusal, PRESERVED, failureReason } from "./refusal.js";
import type { DaemonClient } from "../../client/daemon-client.js";
import { appSpeaks } from "../../client/protocol-window.js";
import { dirname, join, isAbsolute } from "node:path";
import { z } from "zod";
import type { FirstRunReview, FirstRunStatus } from "../../first-run-contract.js";
import type { ConnectionCandidate } from "../connection-target.js";
import { OperatorDiscoverySchema, ConfigGetResultSchema, FirstRunConfigSchema } from "@orca/protocol";
import { FIRST_RUN_SAMPLE, FIRST_RUN_SAMPLE_FILES } from "../../first-run-sample.js";
import {
  type DirectoryIdentity,
  type ProjectIdentity,
  ownedDirectory,
  preparedProject,
  projectRepository,
  sameDirectory,
  separateDirectories,
  emptyDirectory,
  selectionFailure,
  verifyRuntimeDirectories,
} from "./directories.js";

const changedSetupFiles = () =>
  selectionFailure("Setup files in the app workspace were changed, moved or removed since setup wrote them.");
const staleReview = () => selectionFailure("This directory review is out of date. Choose the directories again.");
const changedSinceReview = () =>
  selectionFailure(
    "The project or app workspace changed after you reviewed it: a different folder, branch or commit. Choose the directories again to review what is there now.",
  );
const changedConfiguration = () =>
  selectionFailure("The saved configuration changed during review. Review the saved configuration again.");

const savedRecordFailure = () =>
  selectionFailure("The saved setup record is not a private file this account owns, or it changed while being read.");
const unexpectedDaemon = () =>
  selectionFailure(
    "The daemon that answered is not the one started for this workspace, or it lacks the run controls setup needs. No alternate daemon was connected.",
  );

const directory = z.object({ path: z.string(), dev: z.string(), ino: z.string(), uid: z.string() }).strict();
const receiptSchema = z
  .object({
    version: z.literal(1),
    project: directory.extend({ branch: z.string(), baseCommit: z.string() }),
    workspace: directory,
    files: z.record(z.string(), z.string()),
  })
  .strict();
type Receipt = z.infer<typeof receiptSchema>;
interface Selection {
  review: FirstRunReview;
  project: ProjectIdentity;
  workspace: DirectoryIdentity;
  parent?: DirectoryIdentity;
}
export interface FirstRunDeps {
  home: string;
  receiptPath: string;
  choose(kind: "project" | "workspace"): Promise<string | undefined>;
  /** Must return a bundled, token-file authenticated candidate and its owned child PID. */
  prepareConnection(path: string): Promise<ConnectionCandidate & { expectedProcessId: number }>;
  current(path: string): boolean;
  /** Main enrolls the reviewed existing workspace before any configuration producer. */
  enroll?(path: string): Promise<void>;
  /** Exact surviving owned daemon, captured in main. Does not start or adopt a daemon. */
  configuration?(path: string): {
    client: DaemonClient;
    check(): void;
    rebind(expectedHash: string, savedHash: string): void | Promise<void>;
  };
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export class FirstRunSetup {
  private selection: Selection | undefined;
  private busy = false;
  private configReview:
    | {
        id: string;
        receipt: Receipt;
        revision: string;
        expires: number;
        boundary: Pick<ReturnType<NonNullable<FirstRunDeps["configuration"]>>, "check" | "rebind">;
      }
    | undefined;
  constructor(private readonly deps: FirstRunDeps) {}
  get isBusy(): boolean {
    return this.busy;
  }
  private prepared(receipt: Receipt): FirstRunStatus {
    return {
      state: "prepared",
      project: receipt.project.path,
      workspace: receipt.workspace.path,
      sample: FIRST_RUN_SAMPLE,
    };
  }
  async status(): Promise<FirstRunStatus> {
    if (this.selection) return { state: "review", review: this.selection.review };
    const receipt = await this.readReceipt();
    if (receipt && !absent(join(receipt.workspace.path, ".orca-first-run-ownership"))) {
      try {
        // Before a pending same-boot request: after a restart that request can no longer be reconciled.
        const previous = previousBootAttempt(receipt.workspace.path);
        if (previous)
          return { state: "recovery", recovery: { state: "previous-boot", attemptId: previous.latest.reservationId } };
        const latest = inspectFirstRunOwnership(receipt.workspace.path, true).latest;
        if (latest?.texts["recovery-request.json"] && !latest.settled) {
          const request: unknown = JSON.parse(latest.texts["recovery-request.json"]);
          if (typeof request === "object" && request && "requestId" in request && typeof request.requestId === "string")
            return { state: "recovery", recovery: { state: "ready", requestId: request.requestId } };
        }
      } catch {
        /* Connect/recovery retains the concrete refusal; status never repairs evidence. */
      }
    }
    return receipt
      ? this.prepared(receipt)
      : {
          state: "selection-required",
          reason:
            "Choose a dedicated prepared Git project and a separate empty app workspace. Open a store is read-only and does not set up a project.",
        };
  }
  /** Saved paths do not authorize startup until both physical directories and exact files verify. */
  private async readReceipt(allowChangedConfig = false): Promise<Receipt | undefined> {
    this.receiptFailure = undefined;
    try {
      if (process.platform === "win32") {
        const receipt = receiptSchema.parse(JSON.parse(windowsRead(this.deps.receiptPath, 64 * 1024)));
        await this.verify(receipt, allowChangedConfig);
        return receipt;
      }
      const info = await lstat(this.deps.receiptPath);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size > 64 * 1024 ||
        typeof process.getuid !== "function" ||
        info.uid !== process.getuid()
      )
        throw savedRecordFailure();
      const file = await open(this.deps.receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let text: string;
      try {
        const current = await file.stat();
        if (current.ino !== info.ino || current.dev !== info.dev || current.size > 64 * 1024 || current.nlink !== 1)
          throw savedRecordFailure();
        text = await file.readFile("utf8");
      } finally {
        await file.close();
      }
      const receipt = receiptSchema.parse(JSON.parse(text));
      await this.verify(receipt, allowChangedConfig);
      return receipt;
    } catch (error) {
      this.receiptFailure = error instanceof FirstRunRefusal ? error.message : failureReason(error);
      return undefined;
    }
  }
  /** Why the saved selection did not verify, from the last read of it, for a refusal the person can act on. */
  private receiptFailure: string | undefined;
  private unverifiedReceipt(): FirstRunRefusal {
    return new FirstRunRefusal(
      `Saved project identity or sample assets could not be verified.${this.receiptFailure ? ` ${this.receiptFailure}` : ""} Choose a fresh empty app workspace; existing files were preserved.`,
    );
  }
  private async verify(receipt: Receipt, allowChangedConfig = false): Promise<void> {
    // The receipt's branch and base record what was reviewed at selection. Reopening checks the repository, not HEAD.
    const project = await projectRepository(receipt.project.path, this.deps.home);
    const workspace = await ownedDirectory(receipt.workspace.path, this.deps.home);
    if (!sameDirectory(receipt.project, project) || !sameDirectory(receipt.workspace, workspace))
      throw selectionFailure("The project or app workspace folder was replaced or moved since setup.");
    separateDirectories(project.path, workspace.path);
    await verifyRuntimeDirectories(workspace);
    const expected = this.files(project.path);
    if (JSON.stringify(Object.keys(receipt.files).sort()) !== JSON.stringify(Object.keys(expected).sort()))
      throw changedSetupFiles();
    // Each parent directory was exclusively created by this slice; symlink redirection is refused.
    const assets = await lstat(join(workspace.path, "first-run"));
    if (!assets.isDirectory() || assets.isSymbolicLink()) throw changedSetupFiles();
    for (const [name, text] of Object.entries(expected)) {
      const path = join(workspace.path, name);
      if (process.platform === "win32") {
        const info = windowsFile(path);
        if (info.dev !== workspace.dev || info.uid !== workspace.uid) throw changedSetupFiles();
        const actual = digest(windowsRead(path, 1024 * 1024));
        if (
          name === "orca.config.yaml"
            ? !allowChangedConfig && actual !== receipt.files[name]
            : actual !== digest(text) || receipt.files[name] !== digest(text)
        )
          throw changedSetupFiles();
        continue;
      }
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        String(info.dev) !== workspace.dev ||
        String(info.uid) !== workspace.uid ||
        info.size > 1024 * 1024
      )
        throw changedSetupFiles();
      const actual = digest(await readFile(path, "utf8"));
      if (name === "orca.config.yaml") {
        if (!allowChangedConfig && actual !== receipt.files[name]) throw changedSetupFiles();
      } else if (
        info.size !== Buffer.byteLength(text) ||
        receipt.files[name] !== digest(text) ||
        actual !== digest(text)
      )
        throw changedSetupFiles();
    }
  }

  private files(project: string): Record<string, string> {
    return {
      ...FIRST_RUN_SAMPLE_FILES,
      "orca.config.yaml":
        JSON.stringify(
          {
            version: 1,
            storeDir: ".orca",
            agents: [],
            roles: {},
            plugins: [],
            hosts: [{ id: "local", type: "local" }],
            workspace: { provider: "local", root: project, hostId: "local" },
            workflows: ["first-run/workflow.yaml"],
            templates: [],
            humanInput: { mode: "pause" },
          },
          null,
          2,
        ) + "\n",
    };
  }
  async choose(assertCurrent: () => void): Promise<FirstRunStatus> {
    return this.exclusive(async () => {
      this.configReview = undefined;
      assertCurrent();
      const projectPath = await this.deps.choose("project");
      assertCurrent();
      if (!projectPath) return this.status();
      const project = await preparedProject(projectPath, this.deps.home);
      const workspacePath = await this.deps.choose("workspace");
      assertCurrent();
      if (!workspacePath) return this.status();
      const parent = process.platform === "win32" ? windowsDirectory(workspacePath, "parent") : undefined;
      const workspace = parent
        ? { ...parent, path: join(parent.path, `orca-workspace-${randomUUID()}`) }
        : await ownedDirectory(workspacePath, this.deps.home);
      separateDirectories(project.path, workspace.path);
      if (!parent) await emptyDirectory(workspace.path);
      assertCurrent();
      this.selection = {
        project,
        workspace,
        ...(parent ? { parent } : {}),
        review: {
          id: randomUUID(),
          project: project.path,
          workspace: workspace.path,
          branch: project.branch,
          baseCommit: project.baseCommit,
          sample: FIRST_RUN_SAMPLE,
          ...(parent ? { creation: { parent: parent.path, kind: "private-child" as const } } : {}),
        },
      };
      return this.status();
    });
  }
  async prepare(id: string, assertCurrent: () => void): Promise<FirstRunStatus> {
    return this.exclusive(async () => {
      const selection = this.selection;
      if (!selection || selection.review.id !== id) throw staleReview();
      assertCurrent();
      const project = await preparedProject(selection.project.path, this.deps.home);
      const parent = selection.parent ? windowsDirectory(selection.parent.path, "parent") : undefined;
      const workspaceBefore = parent
        ? selection.workspace
        : await ownedDirectory(selection.workspace.path, this.deps.home);
      if (parent && !sameDirectory(parent, selection.parent!)) throw changedSinceReview();
      let workspace = workspaceBefore;
      if (
        !sameDirectory(selection.project, project) ||
        !sameDirectory(selection.workspace, workspace) ||
        project.branch !== selection.project.branch ||
        project.baseCommit !== selection.project.baseCommit
      )
        throw changedSinceReview();
      separateDirectories(project.path, workspace.path);
      if (!parent) await emptyDirectory(workspace.path);
      assertCurrent();
      await this.deps.enroll?.(workspace.path);
      assertCurrent();
      // Consume before the first write. Any incomplete preparation requires choosing a fresh empty directory.
      this.selection = undefined;
      if (parent) workspace = windowsPrivateChild(workspace.path, parent);
      const files = this.files(project.path);
      if (process.platform === "win32") windowsPrivateChild(join(workspace.path, "first-run"));
      else await mkdir(join(workspace.path, "first-run"), { mode: 0o700 });
      const assetDirectory = await ownedDirectory(join(workspace.path, "first-run"), this.deps.home);
      for (const [name, text] of Object.entries(files)) {
        const current = await ownedDirectory(workspace.path, this.deps.home);
        const assetCurrent = await ownedDirectory(join(workspace.path, "first-run"), this.deps.home);
        if (!sameDirectory(workspace, current) || !sameDirectory(assetDirectory, assetCurrent))
          throw selectionFailure(
            "The app workspace folder changed while setup was writing to it. Choose a fresh empty app workspace.",
          );
        assertCurrent();
        await this.writeExclusive(join(workspace.path, name), text);
      }
      const receipt: Receipt = {
        version: 1,
        project,
        workspace,
        files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, digest(text)])),
      };
      await this.verify(receipt);
      assertCurrent();
      if (process.platform === "win32") {
        if (absent(dirname(this.deps.receiptPath))) windowsPrivateChild(dirname(this.deps.receiptPath));
        else windowsDirectory(dirname(this.deps.receiptPath));
        assertCurrent();
        windowsWrite(this.deps.receiptPath, JSON.stringify(receipt) + "\n", true);
        return this.prepared(receipt);
      }
      await mkdir(dirname(this.deps.receiptPath), { recursive: true, mode: 0o700 });
      const temporary = `${this.deps.receiptPath}.${randomUUID()}`;
      await this.writeExclusive(temporary, JSON.stringify(receipt) + "\n");
      assertCurrent();
      // This is our own selection receipt; replacing it follows the explicit reviewed new selection.
      await rename(temporary, this.deps.receiptPath);
      return this.prepared(receipt);
    });
  }
  async prepareRecovery(assertCurrent: () => void): Promise<FirstRunStatus> {
    return this.exclusive(async () => {
      const receipt = await this.readReceipt();
      if (!receipt) throw this.unverifiedReceipt();
      await this.verify(receipt);
      assertCurrent();
      return {
        state: "recovery",
        recovery: new FirstRunRecovery(receipt.workspace.path).prepare(assertCurrent),
      };
    });
  }
  async reconcileRecovery(id: string, assertCurrent: () => void): Promise<FirstRunStatus> {
    return this.exclusive(async () => {
      const receipt = await this.readReceipt();
      if (!receipt) throw this.unverifiedReceipt();
      await this.verify(receipt);
      assertCurrent();
      const recovery = await new FirstRunRecovery(receipt.workspace.path).reconcile(id, assertCurrent);
      return recovery.state === "reconciled" ? this.prepared(receipt) : { state: "recovery", recovery };
    });
  }
  /** Only on the person's explicit confirmation of the attempt status() showed them; startup never calls this. */
  async endPreviousSession(id: string, assertCurrent: () => void): Promise<FirstRunStatus> {
    return this.exclusive(async () => {
      const receipt = await this.readReceipt();
      if (!receipt) throw this.unverifiedReceipt();
      assertCurrent();
      await endPreviousBootSession(receipt.workspace.path, id, assertCurrent);
      return this.prepared(receipt);
    });
  }
  async reviewConfiguration(assertCurrent: () => void): Promise<FirstRunStatus> {
    return this.exclusive(async () => {
      this.configReview = undefined;
      const receipt = await this.readReceipt(true);
      if (!receipt) throw this.unverifiedReceipt();
      assertCurrent();
      let boundary:
        | (Pick<ReturnType<NonNullable<FirstRunDeps["configuration"]>>, "check" | "rebind"> & { client?: DaemonClient })
        | undefined;
      try {
        boundary = this.deps.configuration?.(receipt.workspace.path);
      } catch (error) {
        if (!(error instanceof FirstRunOwnershipRefusal)) throw error;
      }
      let snapshot;
      if (boundary?.client) {
        boundary.check();
        snapshot = await boundary.client
          .withCapturedAuthentication()
          .call("config.get", {}, ConfigGetResultSchema, false);
      } else {
        const path = join(receipt.workspace.path, "orca.config.yaml");
        const text = await readFile(path, "utf8");
        const revision = digest(text);
        // Review is read-only. The binding action acquires the fence and rechecks this exact revision.
        snapshot = {
          config: { exists: true, path, text, revision, parsed: parseYaml(text) },
          generation: { savedRevision: revision, state: "active" },
        };
        boundary = {
          check: assertCurrent,
          rebind: (expected, saved) =>
            bindQuiescentConfiguration(receipt.workspace.path, expected, saved, assertCurrent),
        };
      }
      boundary.check();
      assertCurrent();
      const doc = snapshot.config;
      const config = FirstRunConfigSchema.parse(doc.parsed);
      const diskHash = digest(await readFile(join(receipt.workspace.path, "orca.config.yaml"), "utf8"));
      if (
        !doc.exists ||
        doc.path !== join(receipt.workspace.path, "orca.config.yaml") ||
        doc.revision !== digest(doc.text) ||
        diskHash !== doc.revision ||
        !snapshot.generation ||
        snapshot.generation.savedRevision !== doc.revision ||
        config.storeDir !== ".orca" ||
        config.workspace.provider !== "local" ||
        config.workspace.root !== receipt.project.path ||
        config.workspace.hostId !== "local" ||
        config.hosts.length !== 1 ||
        config.hosts[0]?.id !== "local" ||
        config.hosts[0]?.type !== "local" ||
        config.plugins.length !== 0 ||
        snapshot.generation.state === "invalid" ||
        [...config.workflows, ...config.templates].some(
          (path) => isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.includes(":"),
        ) ||
        config.humanInput.mode !== "pause" ||
        !config.workflows.includes("first-run/workflow.yaml") ||
        config.agents.some((agent) => agent.hostId !== "local")
      )
        throw selectionFailure(
          "The saved configuration is not the local first-run shape this review can bind: one local host, no plugins, the project as its workspace root and the first-run workflow. Save it in Config, then review again.",
        );
      const checks = [];
      if (config.agents.length > 32)
        throw selectionFailure("The saved configuration lists more than 32 agents, more than this review can check.");
      for (const agent of config.agents) {
        boundary.check();
        assertCurrent();
        checks.push(await inspectLocalTool(agent));
      }
      await this.verify(receipt, true);
      boundary.check();
      assertCurrent();
      if (digest(await readFile(doc.path, "utf8")) !== doc.revision) throw changedConfiguration();
      const id = randomUUID();
      this.configReview = { id, receipt, revision: doc.revision, expires: Date.now() + 5 * 60_000, boundary };
      return {
        state: "configuration-review",
        review: { id, revision: doc.revision, agentCount: config.agents.length, checks },
      };
    });
  }
  /** Withdraw the ephemeral review handle; this never binds configuration or changes the selected directories. */
  async cancelConfigurationReview(assertCurrent: () => void): Promise<FirstRunStatus> {
    return this.exclusive(async () => {
      assertCurrent();
      const hadReview = this.configReview !== undefined;
      this.configReview = undefined;
      const status = await this.status();
      return hadReview && status.state === "selection-required"
        ? {
            state: "selection-required",
            reason:
              "Saved configuration is still unbound. Review it again before binding and reopening this workspace.",
          }
        : status;
    });
  }
  async bindConfiguration(id: string, assertCurrent: () => void): Promise<FirstRunStatus> {
    return this.exclusive(async () => {
      const review = this.configReview;
      if (!review || review.id !== id || Date.now() > review.expires)
        throw selectionFailure(
          "This configuration review has expired or was replaced. Review the saved configuration again.",
        );
      review.boundary.check();
      assertCurrent();
      await this.verify(review.receipt, true);
      const current = await this.readReceipt(true);
      if (
        !current ||
        JSON.stringify(current) !== JSON.stringify(review.receipt) ||
        digest(await readFile(join(current.workspace.path, "orca.config.yaml"), "utf8")) !== review.revision
      )
        throw changedConfiguration();
      review.boundary.check();
      assertCurrent();
      // Consume before the journal append. If receipt publication fails, uncertainty remains visible.
      this.configReview = undefined;
      await review.boundary.rebind(current.files["orca.config.yaml"]!, review.revision);
      const receipt = { ...current, files: { ...current.files, "orca.config.yaml": review.revision } };
      await this.verify(receipt);
      review.boundary.check();
      assertCurrent();
      if (process.platform === "win32") {
        windowsWrite(this.deps.receiptPath, JSON.stringify(receipt) + "\n", true);
        return this.prepared(receipt);
      }
      const temporary = `${this.deps.receiptPath}.${randomUUID()}`;
      await this.writeExclusive(temporary, JSON.stringify(receipt) + "\n");
      review.boundary.check();
      assertCurrent();
      await rename(temporary, this.deps.receiptPath);
      return this.prepared(receipt);
    });
  }
  async connect(
    assertCurrent: () => void,
    recovery?: { workspace: string; prepareConnection: FirstRunDeps["prepareConnection"] },
  ): Promise<FirstRunStatus> {
    return this.exclusive(async () => {
      const receipt = await this.readReceipt();
      if (!receipt) throw this.unverifiedReceipt();
      assertCurrent();
      if (recovery && receipt.workspace.path !== recovery.workspace)
        throw selectionFailure("Recovery was prepared for a different app workspace than the saved one.");
      if (this.deps.current(receipt.workspace.path)) return this.prepared(receipt);
      const candidate = await (recovery?.prepareConnection ?? this.deps.prepareConnection)(receipt.workspace.path);
      let activated = false;
      try {
        candidate.check?.();
        // Bundled clients use their explicit token file, with environment credentials excluded.
        const authenticated = candidate.client.withCapturedAuthentication();
        const hello = await authenticated.hello("orca-app/first-run", false);
        if (
          !hello.identity ||
          !appSpeaks(hello.protocol) ||
          !Number.isSafeInteger(candidate.expectedProcessId) ||
          candidate.expectedProcessId < 1 ||
          hello.processId !== candidate.expectedProcessId ||
          hello.storeDir !== join(receipt.workspace.path, ".orca") ||
          !hello.capabilities.includes("runs.control") ||
          !hello.capabilities.includes("runs.read") ||
          !hello.capabilities.includes("runs.subscribe")
        )
          throw unexpectedDaemon();
        const found = await authenticated.call("operator.discover", {}, OperatorDiscoverySchema, false);
        if (
          found.authentication !== "credential" ||
          found.target.workspaceId !== hello.identity.workspaceId ||
          found.target.instanceId !== hello.identity.instanceId ||
          !found.operations.includes("operator.admitRun")
        )
          throw unexpectedDaemon();
        await this.verify(receipt);
        assertCurrent();
        candidate.check?.();
        candidate.activate(hello);
        activated = true;
        return this.prepared(receipt);
      } catch (error) {
        if (error instanceof FirstRunOwnershipRefusal || error instanceof FirstRunRefusal) throw error;
        throw new FirstRunRefusal(
          `The selected local daemon could not verify its writable workspace. Check the bundled runtime and access, then retry. No alternate daemon was connected.`,
          { cause: error },
        );
      } finally {
        if (!activated) await candidate.dispose();
      }
    });
  }
  private async writeExclusive(path: string, text: string): Promise<void> {
    if (process.platform === "win32") {
      windowsWrite(path, text);
      return;
    }
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy)
      throw new FirstRunRefusal("Project setup is already in progress. Wait for it to finish, then retry.");
    this.busy = true;
    try {
      return await operation();
    } catch (error) {
      if (error instanceof FirstRunOwnershipRefusal || error instanceof FirstRunRefusal) throw error;
      const reason = failureReason(error);
      throw new FirstRunRefusal(
        reason
          ? `${reason} ${PRESERVED}`
          : `Project setup could not verify the selected directories or write its new files. Check ownership, access and Git, then choose a fresh empty workspace. ${PRESERVED}`,
        { cause: error },
      );
    } finally {
      this.busy = false;
    }
  }
}
