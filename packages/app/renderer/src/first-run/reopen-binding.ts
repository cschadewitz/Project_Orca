/**
 * Keeps a first-run workspace reopenable after a Config save (#1192).
 *
 * Reopening refuses a saved configuration that differs from the one last bound for reopening, and
 * Config used to leave that bind to a separate, unannounced step in Project setup. After a save of
 * the selected first-run workspace's own configuration, this runs the same review and bind that
 * step does, through main, for exactly the revision Config just saved. Main keeps every check: the
 * live owner, the first-run shape, the receipt and the revision. Nothing here starts an agent,
 * grants a permission or binds any other revision.
 */
import type { FirstRunBridge } from "../../../src/first-run-contract.js";

export type ReopenBinding = { state: "binding" } | { state: "bound" } | { state: "refused"; reason: string };

/** Config's own path for a workspace, on either separator; the daemon reports the joined path. */
export function isWorkspaceConfig(configPath: string, workspace: string): boolean {
  return configPath === `${workspace}/orca.config.yaml` || configPath === `${workspace}\\orca.config.yaml`;
}

/**
 * Binds the saved revision when, and only when, it is the selected first-run workspace's unbound
 * configuration. Returns undefined when there is nothing to bind: no first-run bridge, another
 * workspace's configuration, or a save that left the bound bytes unchanged.
 */
export async function bindSavedConfigurationForReopening(
  bridge: FirstRunBridge | undefined,
  saved: { revision: string; path: string },
): Promise<Exclude<ReopenBinding, { state: "binding" }> | undefined> {
  if (!bridge?.reviewConfiguration || !bridge.bindConfiguration) return undefined;
  const status = await bridge.status();
  // Unknown is not "nothing to do": say so, rather than let a restart find out.
  if (!status.ok)
    return {
      state: "refused",
      reason: `Project setup could not say whether this workspace needs it. ${status.error.message}`,
    };
  if (
    status.result.state !== "selection-required" ||
    !status.result.changedConfiguration ||
    !isWorkspaceConfig(saved.path, status.result.changedConfiguration.workspace)
  )
    return undefined;
  const review = await bridge.reviewConfiguration();
  if (!review.ok) return { state: "refused", reason: review.error.message };
  if (review.result.state !== "configuration-review")
    return { state: "refused", reason: "Project setup did not return a review of the saved configuration." };
  if (review.result.review.revision !== saved.revision) {
    // Something else changed the file after this save. Bind nothing that was not the reviewed save.
    await bridge.cancelConfigurationReview?.();
    return {
      state: "refused",
      reason: "The configuration file changed again after this save, so it was not bound.",
    };
  }
  const bound = await bridge.bindConfiguration(review.result.review.id);
  if (!bound.ok) return { state: "refused", reason: bound.error.message };
  return { state: "bound" };
}
