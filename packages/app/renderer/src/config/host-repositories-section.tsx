/**
 * Repositories pushed to this managed server, on its Config surface (#1235). Shown only while the
 * app is connected to a saved SSH profile whose server has a repository `orca-cli remote
 * push-repo` put there. **Use as workspace** puts the `workspace:` settings that make the daemon
 * work in that repository's checkout into the draft (the ones `push-repo` prints): a
 * `git-worktree` workspace on the checkout, from the branch last pushed, fetching delegated refs
 * from what was pushed and allowing its pushed branches. For a workspace already on that checkout
 * it only adds the pushed branches it does not allow yet; any other workspace is left alone with
 * the reason. Nothing is written until the person reviews, saves and applies the draft.
 *
 * The report is bound to the connection it was read on (see `useServerReport`).
 */
import type { JSX } from "react";
import type { HostRepositoryView } from "../../../src/daemon-connection.js";
import { Button, Text } from "../ui/index.js";
import type { EditIntent } from "./structured-form/contracts.js";
import { useServerReport } from "./server-report.js";

/** What using `repository` as the workspace does to the draft. */
export type WorkspacePlan =
  { kind: "use" | "allow"; edits: EditIntent[] } | { kind: "current" } | { kind: "conflict"; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Whether `allowed` (full refs, or prefixes ending in `/*`) lets a delegated run name `ref`. */
function allows(allowed: readonly unknown[], ref: string): boolean {
  return allowed.some(
    (entry) =>
      typeof entry === "string" && (entry === ref || (entry.endsWith("/*") && ref.startsWith(entry.slice(0, -1)))),
  );
}

/**
 * The edits that make the draft's workspace the pushed checkout. With no workspace: the whole
 * `workspace:` block. With a `git-worktree` workspace on this checkout, on this host: only the
 * pushed branches it does not allow yet, added to `allowedRefs`. Anything else is the person's
 * own workspace and is left alone, with the reason.
 */
export function workspacePlan(draft: unknown, repository: HostRepositoryView): WorkspacePlan {
  const workspace = isRecord(draft) ? draft.workspace : undefined;
  if (workspace === undefined || workspace === null) {
    const value = {
      provider: "git-worktree",
      repo: repository.checkout,
      ...(repository.head ? { baseBranch: repository.head.slice("refs/heads/".length) } : {}),
      fetchRemote: "origin",
      ...(repository.branches.length ? { allowedRefs: [...repository.branches] } : {}),
    };
    return { kind: "use", edits: [{ kind: "set", path: ["workspace"], value }] };
  }
  const conflict = (why: string): WorkspacePlan => ({
    kind: "conflict",
    reason: `This configuration already has a workspace ${why}. Change it in the form to work in ${repository.name}.`,
  });
  if (!isRecord(workspace)) return conflict("that is not a map");
  if (workspace.provider !== "git-worktree") return conflict("that is not a git worktree workspace");
  if (workspace.repo !== repository.checkout)
    return conflict(typeof workspace.repo === "string" ? `in ${workspace.repo}` : "in another repository");
  if (workspace.hostId !== undefined && workspace.hostId !== "local") return conflict("on another host");
  const allowed = workspace.allowedRefs;
  if (allowed !== undefined && !Array.isArray(allowed)) return conflict("whose allowedRefs is not a list");
  const missing = repository.branches.filter((ref) => !allows(allowed ?? [], ref));
  if (!missing.length) return { kind: "current" };
  if (!allowed) return { kind: "allow", edits: [{ kind: "set", path: ["workspace", "allowedRefs"], value: missing }] };
  return {
    kind: "allow",
    edits: missing.map((ref, i) => ({
      kind: "insert" as const,
      path: ["workspace", "allowedRefs"],
      index: allowed.length + i,
      value: ref,
    })),
  };
}

export function HostRepositoriesSection(): JSX.Element | null {
  const { studio, profile, report, stillCurrent } = useServerReport((profiles) => profiles.hostRepositories);
  if (!studio || !profile || !report?.length) return null;
  const use = (repository: HostRepositoryView) => {
    // Checked again at the click: the connection, the report and the draft's target are one.
    if (!stillCurrent()) return;
    const plan = workspacePlan(studio.value, repository);
    if (plan.kind === "use" || plan.kind === "allow") studio.edit(plan.edits);
  };
  return (
    <section className="orca-connection-stack" aria-label={`Repositories on ${profile.name}`}>
      <Text style="caption" as="p">
        Repositories pushed to {profile.name}. Using one puts the workspace settings that work in its checkout into this
        configuration&apos;s draft; review, save and apply it as usual.
      </Text>
      {report.map((repository) => {
        const plan = workspacePlan(studio.value, repository);
        const access =
          plan.kind === "conflict"
            ? { allowed: false as const, reason: plan.reason }
            : plan.kind === "current"
              ? { allowed: false as const, reason: "This configuration already works there." }
              : studio.editAccess(plan.edits);
        const count = repository.branches.length;
        return (
          <div key={repository.name} className="orca-dialog__actions">
            <Text style="caption" as="span">
              {repository.name} ({count} {count === 1 ? "branch" : "branches"})
            </Text>
            {plan.kind === "conflict" ? (
              <Text style="caption" as="span">
                {plan.reason}
              </Text>
            ) : null}
            <Button
              size="sm"
              disabled={!access.allowed}
              {...(access.allowed ? {} : { disabledReason: access.reason })}
              onClick={() => use(repository)}
            >
              {plan.kind === "current"
                ? "Workspace"
                : plan.kind === "allow"
                  ? "Allow pushed branches"
                  : "Use as workspace"}
            </Button>
          </div>
        );
      })}
    </section>
  );
}
