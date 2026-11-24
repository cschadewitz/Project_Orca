/**
 * `judge.status` (#701): where the plain-language rule judge's setup stands, for the app's
 * setup checklist. Read-only, and it never returns a value or a key: the judge settings the
 * active configuration names, whether the caller holds the disclosure grant for each kind the
 * judge may be shown, and whether this machine keeps the judge's daily budget and in what state.
 *
 * Each missing step is an owner step the app does not take for the owner: it names the command
 * (`orca auth issue --judge-disclosure ...`, `orca judge budget init`). Needs `config.read`.
 */
import { z } from "zod";

export const JUDGE_STATUS_METHOD = "judge.status";

export const JudgeStatusParamsSchema = z.object({}).strict();
export type JudgeStatusParams = z.infer<typeof JudgeStatusParamsSchema>;

/** The kinds of call a judge may be shown, each its own disclosure grant. `reads` is reads and searches. */
export const JUDGE_KINDS = ["reads", "edits", "mcpCalls", "commands"] as const;
export type JudgeKind = (typeof JUDGE_KINDS)[number];

export const JUDGE_KEY_STATES = [
  "present",
  "missing",
  "not-found",
  "destination-mismatch",
  "unusable",
  "withheld",
] as const;
export type JudgeKeyState = (typeof JUDGE_KEY_STATES)[number];

export const JudgeConfigStatusSchema = z.discriminatedUnion("state", [
  /** No `review.plainRules.judge` in the active configuration. */
  z.object({ state: z.literal("none") }).strict(),
  /** One is there, but incomplete or invalid: no grant can be derived from it. */
  z.object({ state: z.literal("invalid") }).strict(),
  z
    .object({
      state: z.literal("configured"),
      /** The provider kind, such as `anthropic` or `openai-compatible`. */
      provider: z.string().min(1),
      /** The exact https destination the judge sends to. */
      destination: z.string().min(1),
      /** The secret reference that holds the judge's key. */
      credential: z.string().min(1),
      /**
       * The judge's key, checked on the daemon's own machine from metadata, never read or shown:
       * - `present`: usable by the judge and set now;
       * - `missing`: usable, but unset or empty;
       * - `not-found`: no such reference;
       * - `destination-mismatch`: the reference is not pinned to this judge's destination;
       * - `unusable`: the judge cannot use it (a file, another host, or a source another pinned
       *   reference shares);
       * - `withheld`: the caller may not see this reference (`secrets.read` and a grant naming it).
       */
      key: z.enum(JUDGE_KEY_STATES),
    })
    .strict(),
]);
export type JudgeConfigStatus = z.infer<typeof JudgeConfigStatusSchema>;

export const JudgeGrantStatusSchema = z
  .object({
    kind: z.enum(JUDGE_KINDS),
    /** Whether the configuration turns this kind on (`reads` always is, once a judge is configured). */
    enabled: z.boolean(),
    /** Whether one of the caller's current credentials holds the grant for this kind, as configured now. */
    granted: z.boolean(),
  })
  .strict();
export type JudgeGrantStatus = z.infer<typeof JudgeGrantStatusSchema>;

export const JudgeBudgetStatusSchema = z.discriminatedUnion("state", [
  /** This machine cannot keep the budget durably; the judge is not available here. */
  z
    .object({
      state: z.literal("unsupported"),
      reason: z.enum(["platform", "workspace", "store", "anchor", "not-separate"]),
    })
    .strict(),
  /** Not created yet: `orca judge budget init`. */
  z.object({ state: z.literal("uninitialized") }).strict(),
  /** Ready. On the day it was created it counts as spent, so the judge is first asked the next UTC day. */
  z.object({ state: z.literal("ready"), firstDaySpent: z.boolean() }).strict(),
  /** It cannot be trusted as it is (for example after a restore): `orca judge budget reset`. */
  z.object({ state: z.literal("refused") }).strict(),
]);
export type JudgeBudgetStatus = z.infer<typeof JudgeBudgetStatusSchema>;

export const JudgeStatusResultSchema = z
  .object({
    /** Whether this build hands sessions a judge at all. While false, nothing below is used. */
    active: z.boolean(),
    /**
     * The owner's opt-in, `review.plainRules.enabled: true` in the active configuration. Absent or false, no
     * session gets a judge whatever else is set up: nothing is sent, and every call goes to a person.
     */
    enabled: z.boolean(),
    config: JudgeConfigStatusSchema,
    /**
     * `token` when the caller's grants were read; `loopback` keeps no grants, so the judge is
     * unavailable there whatever the rest says.
     */
    auth: z.enum(["token", "loopback"]),
    /**
     * Token mode: the caller's own principal, the one a run it starts is owned by. A grant is
     * issued to it (`orca auth issue <principal> --judge-disclosure ...`).
     */
    principal: z.string().min(1).optional(),
    /** One row per kind, `reads` first; empty unless `config.state` is `configured`. */
    grants: z.array(JudgeGrantStatusSchema),
    budget: JudgeBudgetStatusSchema,
  })
  .strict();
export type JudgeStatusResult = z.infer<typeof JudgeStatusResultSchema>;

/**
 * What the judge said about a call before a person was asked (#701), on a permission ask's
 * `context.judge` (`inputs.list`, `inputs.open`). It answers nothing: it is shown with the ask.
 * The verdicts are `PlainRuleVerdict` in `@orca/agents` plus the lanes' own `changed-since`, the
 * reason codes its fixed `PLAIN_RULE_REASONS`, kept only within their verdict's family
 * (`askJudgeNote`): never model prose. A note this build does not know is not shown.
 */
export const JUDGE_ASK_VERDICTS = [
  "covered",
  "not-covered",
  "unsure",
  "unavailable",
  "malformed",
  "timeout",
  "over-budget",
  "injection-suspected",
  "hard-boundary",
  "outside-envelope",
  /** The judge said yes, but the rules or what the call touches changed before ORCA's check afterwards. */
  "changed-since",
] as const;
export type JudgeAskVerdict = (typeof JUDGE_ASK_VERDICTS)[number];

export const JUDGE_ASK_REASONS = [
  "matches-criterion",
  "outside-criterion",
  "excluded-by-criterion",
  "action-ambiguous",
  "criterion-ambiguous",
] as const;
export type JudgeAskReason = (typeof JUDGE_ASK_REASONS)[number];

export const JudgeAskNoteSchema = z
  .object({
    verdict: z.enum(JUDGE_ASK_VERDICTS),
    /** The experimental class asked about; absent for a read or search. */
    kind: z.enum(["edit", "mcp", "command"]).optional(),
    /** A recommendation (edits, commands): the person decides either way. */
    advisory: z.literal(true).optional(),
    reasonCode: z.enum(JUDGE_ASK_REASONS).optional(),
    /** The rule the verdict is about, by its id (`config:N`, `sidecar:N`). */
    ruleId: z.string().min(1).max(64).optional(),
  })
  .strict();
export type JudgeAskNote = z.infer<typeof JudgeAskNoteSchema>;
