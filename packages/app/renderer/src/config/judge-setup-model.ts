/**
 * The judge setup checklist (#701): `judge.status` turned into the steps an owner takes before
 * plain-language rules can be judged, each done, to do, or not possible here, with the exact
 * command for an owner step. The app takes none of these steps itself: the key is the owner's,
 * a disclosure grant is issued only by an owner, and the budget is created only on purpose.
 *
 * A plain module with a plain test, like `config-model.ts`.
 */
import type { JudgeKind, JudgeStatusResult } from "@orca/protocol";

export type JudgeStepState = "done" | "todo" | "blocked";

export interface JudgeStep {
  readonly id: string;
  readonly title: string;
  readonly state: JudgeStepState;
  /** One sentence on what is true now, or what to do. */
  readonly detail: string;
  /** The command an owner runs for this step, when there is one. */
  readonly command?: string;
}

/** The CLI's names for the kinds (`--judge-disclosure-kind`), and how the app says them. */
const KIND_FLAGS: Record<Exclude<JudgeKind, "reads">, string> = {
  edits: "edits",
  mcpCalls: "mcp-calls",
  commands: "commands",
};
const KIND_WORDS: Record<JudgeKind, string> = {
  reads: "reads and searches",
  edits: "edits (advice only)",
  mcpCalls: "MCP tool calls",
  commands: "commands (advice only)",
};

const BUDGET_UNSUPPORTED: Record<string, string> = {
  platform: "This platform cannot keep the judge's daily budget durably. Linux and macOS are supported.",
  workspace: "This store has no valid workspace identity, so the budget has nowhere to keep its anchor.",
  store: "The store directory is missing, a link, or not a directory.",
  anchor: "The per-user folder that holds the budget's anchor cannot be created or trusted.",
  "not-separate": "The budget's anchor folder and the store overlap, so a restore could roll the budget back.",
};

/** Shell-quote one argument only when it needs it. */
const arg = (value: string) => (/^[A-Za-z0-9_.@:/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

export function judgeSetupSteps(status: JudgeStatusResult): readonly JudgeStep[] {
  const steps: JudgeStep[] = [];
  const config = status.config;
  if (config.state === "none")
    steps.push({
      id: "config",
      title: "Judge settings",
      state: "todo",
      detail:
        "Name a judge under review.plainRules.judge in orca.config.yaml: its provider, its https destination, and the secret reference that holds its key.",
    });
  else if (config.state === "invalid")
    steps.push({
      id: "config",
      title: "Judge settings",
      state: "todo",
      detail:
        "review.plainRules.judge is incomplete or invalid. It needs a provider, an https destination the judge may send to, and a secret reference for the key.",
    });
  else {
    steps.push({
      id: "config",
      title: "Judge settings",
      state: "done",
      detail: `${config.provider} at ${config.destination}`,
    });
    steps.push(
      config.key === "present"
        ? { id: "key", title: "Key", state: "done", detail: `The key in ${config.credential} is set on this machine.` }
        : config.key === "missing"
          ? {
              id: "key",
              title: "Key",
              state: "todo",
              detail: `The key in ${config.credential} is not set on this machine: set the variable or file that reference names, then restart ORCA if it reads the environment.`,
            }
          : config.key === "not-found"
            ? {
                id: "key",
                title: "Key",
                state: "todo",
                detail: `There is no secret reference named ${config.credential}. Add it under secrets in orca.config.yaml.`,
              }
            : {
                id: "key",
                title: "Key",
                state: "blocked",
                detail: `${config.credential} is bound to another host. The judge reads its key on the machine ORCA runs on.`,
              },
    );
  }

  if (status.auth === "loopback")
    steps.push({
      id: "grant",
      title: "Disclosure grant",
      state: "blocked",
      detail:
        "ORCA is running without credentials, which keep no grants, so no judge is used. Run it with token authentication.",
    });
  else if (config.state === "configured") {
    const enabled = status.grants.filter((g) => g.enabled);
    const missing = enabled.filter((g) => !g.granted);
    const principal = status.principal ?? "<you>";
    const flags = missing
      .filter((g): g is typeof g & { kind: Exclude<JudgeKind, "reads"> } => g.kind !== "reads")
      .map((g) => ` --judge-disclosure-kind ${KIND_FLAGS[g.kind]}`)
      .join("");
    steps.push(
      missing.length === 0
        ? {
            id: "grant",
            title: "Disclosure grant",
            state: "done",
            detail: `You allowed the judge to see ${enabled.map((g) => KIND_WORDS[g.kind]).join(", ")}.`,
          }
        : {
            id: "grant",
            title: "Disclosure grant",
            state: "todo",
            detail: `Allow the judge to see ${missing.map((g) => KIND_WORDS[g.kind]).join(", ")} from your runs. An owner issues the grant; it names this judge's destination and provider only.`,
            command: `orca auth issue ${arg(principal)} --preset owner --judge-disclosure${flags}`,
          },
    );
  }

  const budget = status.budget;
  steps.push(
    budget.state === "ready"
      ? {
          id: "budget",
          title: "Daily budget",
          state: "done",
          detail: budget.firstDaySpent
            ? "Created today. Today counts as spent, so the judge is first asked tomorrow (UTC)."
            : "Ready.",
        }
      : budget.state === "uninitialized"
        ? {
            id: "budget",
            title: "Daily budget",
            state: "todo",
            detail: "Create the judge's daily budget. The day you create it counts as spent.",
            command: "orca judge budget init",
          }
        : budget.state === "refused"
          ? {
              id: "budget",
              title: "Daily budget",
              state: "todo",
              detail: "The budget cannot be trusted as it is, for example after the store was restored. Replace it.",
              command: "orca judge budget reset",
            }
          : {
              id: "budget",
              title: "Daily budget",
              state: "blocked",
              detail: BUDGET_UNSUPPORTED[budget.reason] ?? "This machine cannot keep the judge's budget.",
            },
  );
  return steps;
}
