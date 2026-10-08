/** Main-only observation of the explicitly configured prepared checkout; never creates or repairs workspaces. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ConfigGetResult } from "@orca/protocol";
import type { CheckoutEvidence, EditorTarget } from "../configuration-launch-contract.js";
import type { DaemonTargetSnapshot } from "../daemon-connection.js";
import type { WorkspaceSnapshot } from "../bridge.js";

const execute = promisify(execFile);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export async function observePreparedCheckout(
  config: ConfigGetResult,
  target: DaemonTargetSnapshot,
  workspace: WorkspaceSnapshot,
  generation: string,
  authorization: { endpointId: string; principalId: string },
): Promise<CheckoutEvidence> {
  const unavailable = (reason: string): CheckoutEvidence => ({ state: "unavailable", reason });
  if (!target.identity || workspace.readOnly || !["bundled", "development"].includes(target.source))
    return unavailable("Prepared checkout inspection requires this app's local writable workspace.");
  if (
    !config.generation ||
    config.generation.state !== "active" ||
    config.generation.activeGeneration !== generation ||
    config.generation.activeRevision !== config.config.revision
  )
    return unavailable("Save and apply configuration, or complete its required restart, before checkout review.");
  const parsed = config.config.parsed;
  const setting = object(parsed) && object(parsed.workspace) ? parsed.workspace : undefined;
  if (
    !setting ||
    setting.provider !== "local" ||
    typeof setting.root !== "string" ||
    !setting.root.trim() ||
    (setting.hostId !== undefined && setting.hostId !== "local")
  )
    return unavailable(
      "Configure an explicit local prepared project checkout in Config. Other workspace profiles require their verified adapter.",
    );
  try {
    const cwd = await realpath(
      isAbsolute(setting.root) ? setting.root : resolve(dirname(config.config.path), setting.root),
    );
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const git = async (...args: string[]) =>
      (
        await execute("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          env: { ...environment, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
        })
      ).stdout;
    const repository = await realpath((await git("rev-parse", "--show-toplevel")).trim());
    const branch = (await git("symbolic-ref", "--short", "HEAD")).trim();
    const baseCommit = (await git("rev-parse", "--verify", "HEAD")).trim();
    // Observe checkout identity/base and tracked changes, without reading untracked file contents.
    // This is evidence for the prepared root, not an immutable filesystem snapshot.
    const status = await git("status", "--porcelain", "-z", "--untracked-files=normal");
    const tracked = await git("diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--");
    const editorTarget: EditorTarget = { ...target.identity, epoch: target.epoch };
    const evidenceId = createHash("sha256")
      .update(
        JSON.stringify({
          editorTarget,
          authorization,
          generation,
          repository,
          cwd,
          branch,
          baseCommit,
          status,
          tracked: createHash("sha256").update(tracked).digest("hex"),
        }),
      )
      .digest("hex");
    return {
      state: "verified",
      target: editorTarget,
      configGeneration: generation,
      evidenceId,
      profile: "prepared-local",
      repository,
      cwd,
      branch,
      baseCommit,
      asOf: new Date().toISOString(),
    };
  } catch {
    return unavailable(
      "The prepared checkout could not be verified. Check its path, Git availability and attached branch; then retry.",
    );
  }
}
