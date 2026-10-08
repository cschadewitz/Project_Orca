/** Dedicated first-run provisioning. Native selections are reviewed, identity-fenced and never overwritten. */
import { randomUUID, createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { FirstRunOwnershipRefusal } from "./ownership.js";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { FirstRunReview, FirstRunStatus } from "../../first-run-contract.js";
import type { ConnectionCandidate } from "../connection-target.js";
import { isCompatible, PROTOCOL_VERSION, OperatorDiscoverySchema } from "@orca/protocol";
import { FIRST_RUN_SAMPLE, FIRST_RUN_SAMPLE_FILES } from "../../first-run-sample.js";
import {
  type DirectoryIdentity,
  type ProjectIdentity,
  ownedDirectory,
  preparedProject,
  sameDirectory,
  separateDirectories,
  emptyDirectory,
  selectionFailure,
  verifyRuntimeDirectories,
} from "./directories.js";

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
}
export interface FirstRunDeps {
  home: string;
  receiptPath: string;
  choose(kind: "project" | "workspace"): Promise<string | undefined>;
  /** Must return a bundled, token-file authenticated candidate and its owned child PID. */
  prepareConnection(path: string): Promise<ConnectionCandidate & { expectedProcessId: number }>;
  current(path: string): boolean;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export class FirstRunSetup {
  private selection: Selection | undefined;
  private busy = false;
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
    return receipt
      ? this.prepared(receipt)
      : {
          state: "selection-required",
          reason:
            "Choose a dedicated prepared Git project and a separate empty app workspace. Open a store is read-only and does not set up a project.",
        };
  }
  /** Saved paths do not authorize startup until both physical directories and exact files verify. */
  private async readReceipt(): Promise<Receipt | undefined> {
    try {
      const info = await lstat(this.deps.receiptPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw selectionFailure();
      const receipt = receiptSchema.parse(JSON.parse(await readFile(this.deps.receiptPath, "utf8")));
      await this.verify(receipt);
      return receipt;
    } catch {
      return undefined;
    }
  }
  private async verify(receipt: Receipt): Promise<void> {
    const project = await preparedProject(receipt.project.path, this.deps.home);
    const workspace = await ownedDirectory(receipt.workspace.path, this.deps.home);
    if (
      !sameDirectory(receipt.project, project) ||
      !sameDirectory(receipt.workspace, workspace) ||
      project.branch !== receipt.project.branch ||
      project.baseCommit !== receipt.project.baseCommit
    )
      throw selectionFailure();
    separateDirectories(project.path, workspace.path);
    await verifyRuntimeDirectories(workspace);
    const expected = this.files(project.path);
    if (JSON.stringify(Object.keys(receipt.files).sort()) !== JSON.stringify(Object.keys(expected).sort()))
      throw selectionFailure();
    // Each parent directory was exclusively created by this slice; symlink redirection is refused.
    const assets = await lstat(join(workspace.path, "first-run"));
    if (!assets.isDirectory() || assets.isSymbolicLink()) throw selectionFailure();
    for (const [name, text] of Object.entries(expected)) {
      const path = join(workspace.path, name);
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== Buffer.byteLength(text) ||
        receipt.files[name] !== digest(text) ||
        digest(await readFile(path, "utf8")) !== digest(text)
      )
        throw selectionFailure();
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
      assertCurrent();
      const projectPath = await this.deps.choose("project");
      assertCurrent();
      if (!projectPath) return this.status();
      const project = await preparedProject(projectPath, this.deps.home);
      const workspacePath = await this.deps.choose("workspace");
      assertCurrent();
      if (!workspacePath) return this.status();
      const workspace = await ownedDirectory(workspacePath, this.deps.home);
      separateDirectories(project.path, workspace.path);
      await emptyDirectory(workspace.path);
      assertCurrent();
      this.selection = {
        project,
        workspace,
        review: {
          id: randomUUID(),
          project: project.path,
          workspace: workspace.path,
          branch: project.branch,
          baseCommit: project.baseCommit,
          sample: FIRST_RUN_SAMPLE,
        },
      };
      return this.status();
    });
  }
  async prepare(id: string, assertCurrent: () => void): Promise<FirstRunStatus> {
    return this.exclusive(async () => {
      const selection = this.selection;
      if (!selection || selection.review.id !== id) throw selectionFailure();
      assertCurrent();
      const project = await preparedProject(selection.project.path, this.deps.home);
      const workspace = await ownedDirectory(selection.workspace.path, this.deps.home);
      if (
        !sameDirectory(selection.project, project) ||
        !sameDirectory(selection.workspace, workspace) ||
        project.branch !== selection.project.branch ||
        project.baseCommit !== selection.project.baseCommit
      )
        throw selectionFailure();
      separateDirectories(project.path, workspace.path);
      await emptyDirectory(workspace.path);
      assertCurrent();
      // Consume before the first write. Any incomplete preparation requires choosing a fresh empty directory.
      this.selection = undefined;
      const files = this.files(project.path);
      await mkdir(join(workspace.path, "first-run"), { mode: 0o700 });
      const assetDirectory = await ownedDirectory(join(workspace.path, "first-run"), this.deps.home);
      for (const [name, text] of Object.entries(files)) {
        const current = await ownedDirectory(workspace.path, this.deps.home);
        const assetCurrent = await ownedDirectory(join(workspace.path, "first-run"), this.deps.home);
        if (!sameDirectory(workspace, current) || !sameDirectory(assetDirectory, assetCurrent))
          throw selectionFailure();
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
      await mkdir(dirname(this.deps.receiptPath), { recursive: true, mode: 0o700 });
      const temporary = `${this.deps.receiptPath}.${randomUUID()}`;
      await this.writeExclusive(temporary, JSON.stringify(receipt) + "\n");
      assertCurrent();
      // This is our own selection receipt; replacing it follows the explicit reviewed new selection.
      await rename(temporary, this.deps.receiptPath);
      return this.prepared(receipt);
    });
  }
  async connect(assertCurrent: () => void): Promise<FirstRunStatus> {
    return this.exclusive(async () => {
      const receipt = await this.readReceipt();
      if (!receipt)
        throw new Error(
          "Saved project identity or sample assets could not be verified. Choose a fresh empty app workspace; existing files were preserved.",
        );
      assertCurrent();
      if (this.deps.current(receipt.workspace.path)) return this.prepared(receipt);
      const candidate = await this.deps.prepareConnection(receipt.workspace.path);
      let activated = false;
      try {
        candidate.check?.();
        // Bundled clients use their explicit token file, with environment credentials excluded.
        const authenticated = candidate.client.withCapturedAuthentication();
        const hello = await authenticated.hello("orca-app/first-run", false);
        if (
          !hello.identity ||
          !isCompatible(PROTOCOL_VERSION, hello.protocol) ||
          !Number.isSafeInteger(candidate.expectedProcessId) ||
          candidate.expectedProcessId < 1 ||
          hello.processId !== candidate.expectedProcessId ||
          hello.storeDir !== join(receipt.workspace.path, ".orca") ||
          !hello.capabilities.includes("runs.control") ||
          !hello.capabilities.includes("runs.read") ||
          !hello.capabilities.includes("runs.subscribe")
        )
          throw selectionFailure();
        const found = await authenticated.call("operator.discover", {}, OperatorDiscoverySchema, false);
        if (
          found.authentication !== "credential" ||
          found.target.workspaceId !== hello.identity.workspaceId ||
          found.target.instanceId !== hello.identity.instanceId ||
          !found.operations.includes("operator.admitRun")
        )
          throw selectionFailure();
        await this.verify(receipt);
        assertCurrent();
        candidate.check?.();
        candidate.activate(hello);
        activated = true;
        return this.prepared(receipt);
      } catch (error) {
        if (error instanceof FirstRunOwnershipRefusal) throw error;
        throw new Error(
          "The selected local daemon could not verify its writable workspace. Check the bundled runtime and access, then retry. No alternate daemon was connected.",
          { cause: error },
        );
      } finally {
        if (!activated) await candidate.dispose();
      }
    });
  }
  private async writeExclusive(path: string, text: string): Promise<void> {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Project setup is already in progress.");
    this.busy = true;
    try {
      return await operation();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The selected local daemon")) throw error;
      throw new Error(
        "Project setup could not verify the selected directories or write its new files. Check ownership, access and Git, then choose a fresh empty workspace. Existing files were preserved.",
        { cause: error },
      );
    } finally {
      this.busy = false;
    }
  }
}
