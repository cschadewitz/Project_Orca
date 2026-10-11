/**
 * One agent's permission policy, as a thing you can change (#176).
 *
 * **Where it lives, and why here.** It is in `renderer/src/config/` rather than in
 * `renderer/src/agents/` because the draft model is: `use-config.ts` holds both documents,
 * both drafts, `expectedRevision` and the `CONFIG_STALE` conflict, and #175 set the rule
 * that a refused write keeps what a person typed. A second copy of that machinery under the
 * Agents surface would be a second answer to "what is unsaved", and the two would disagree
 * the first time a run answered "always" while somebody was editing. So the editor is a
 * component of the Config surface's module, and the Agents surface *mounts* it — which is
 * also what `component-api.d.ts` asks for when it says a permission policy surface is its
 * own screen and not a line on the agent card.
 *
 * **It is an inspector, not the chrome's docked panel.** The dock has one tenant already
 * (the artifact panel), and a second one would be two components deciding what is in one
 * slot. This is a panel inside the Agents surface, drawn beside the cards, which is what
 * keeps the agent it is about on screen next to it.
 *
 * What it shows, in the order ORCA evaluates it:
 *
 * - **the configured rules, read-only.** They are the YAML's, a person wrote them, and
 *   nothing machine-written may rewrite the hand-curated `agents:` array (ADR 0009). The way
 *   to edit one is the Config form, which is one link away.
 * - **the sidecar's rules, editable.** Remove a grant, narrow or widen one, add one by hand.
 *   Every edit is a draft on the `permissions` document and Save writes the file whole,
 *   because the sidecar is JSON and `config.set`'s `patch` edits a YAML document in place —
 *   `text` is the write this document takes.
 * - **the fallthrough**, which is configuration's alone. The sidecar cannot carry one, and a
 *   list of rules without it is half a policy.
 *
 * And one thing it deliberately does not show: **how often a rule fired.** Nothing in ORCA
 * counts auto-approvals — `decidePermission` is evaluated per tool call and no running total
 * is kept anywhere, on the wire or off it — so the "auto-approval count explained" the issue
 * asks for cannot be rendered. Rule 12: it is absent rather than approximated.
 */
import { useCallback, useMemo, type JSX } from "react";
import { CONFIG_SET_METHOD, PERMISSION_DECISIONS, TOOL_KINDS, type ConfigDocument } from "@orca/protocol";
import { useMethodPresent, useWritability } from "../chrome/use-connection.js";
import { Button, Chip, ConfigField, Menu, Text, Time, textClass } from "../ui/index.js";
import { configUrl } from "../route-table.js";
import { POLICY_LAYERS, agentPolicies, describeRule, rowsFrom } from "./config-model.js";
import { DraftBar } from "./draft-bar.js";
import {
  handRule,
  parseSidecar,
  ruleChanges,
  rulesOf,
  serializeSidecar,
  withMatch,
  withRules,
  type RuleMatch,
  type SidecarRule,
} from "./policy-model.js";
import { useConfig } from "./config-context.js";
import type { ConfigFeed } from "./use-config.js";
import "./config.css";
import "./policy.css";

/**
 * The editor with the draft model behind it — what the Agents surface mounts.
 *
 * `useConfig()` reads the app's one draft model (`config-context.tsx`, #175's review): the
 * Config surface and this panel are two views of the same drafts, so a grant edited here
 * and a field edited there cannot become two answers to "what is unsaved". The panel is
 * mounted across agent switches rather than keyed by agent, so moving from one card to the
 * next keeps the draft — and closing it now keeps the draft too, because the state is above
 * the panel rather than inside it.
 */
export function PolicyPanel(props: Omit<PolicyEditorProps, "feed">): JSX.Element {
  const feed = useConfig();
  return <PolicyEditor {...props} feed={feed} />;
}

/** The one document this panel writes. Named once so nothing can write the YAML by accident. */
const DOCUMENT: ConfigDocument = "permissions";

/**
 * The menus' "not narrowed at all" entry, and it is an object rather than a word.
 *
 * `undefined` is a value the match may hold, so "any" needs an identity of its own. A string
 * sentinel had to be one no vocabulary could ever contain — the one here was a word with a
 * NUL byte in front of it, which is a trick rather than a type — and it was still compared
 * by equality against real choices. `Menu` hands the chosen item back by reference, so one
 * object compared with `===` asks the question actually being asked: was it *this* entry.
 */
const ANY_ITEM = { id: "any", label: "Any" } as const;

export interface PolicyEditorProps {
  /** The agent whose policy this is. */
  agentId: string;
  /** The shared draft model — one per mounting, never one per row. */
  feed: ConfigFeed;
  /** Open an `orca://` URL: the link to the Config form, where a configured rule is edited. */
  onOpen?: (url: string) => void;
  onClose: () => void;
  /** Whether the daemon is answering, so the provenance timestamps stop reading as relative. */
  live: boolean;
  /** The clock, injectable so a test can assert the `addedAt` a hand-added rule gets. */
  now?: () => string;
}

export function PolicyEditor({ agentId, feed, onOpen, onClose, live, now }: PolicyEditorProps): JSX.Element {
  const writability = useWritability();
  /* The method this panel calls, asked for by name: `runs.control` is one word covering
     several dispatch tables, and only `hello.methods` says whether this daemon was given a
     configuration to write (`methodPresent`). */
  const canSet = useMethodPresent(CONFIG_SET_METHOD);

  const data = feed.state.phase === "ready" ? feed.state.data : undefined;
  const draft = feed.draftOf(DOCUMENT);
  const save = feed.saveStateOf(DOCUMENT);

  /* The file as it is, and the document as the draft has it. Both parsed rather than
     compared as text: the daemon canonicalises key order, so bytes are not the question and
     the revision is (`policy-model.ts`). */
  const onDisk = useMemo(() => (data ? parseSidecar(data.permissions.text) : undefined), [data]);
  const held = useMemo(() => (draft?.kind === "raw" ? parseSidecar(draft.text) : onDisk), [draft, onDisk]);

  const policy = useMemo(
    () => (data ? agentPolicies(data.effective).find((entry) => entry.agentId === agentId) : undefined),
    [agentId, data],
  );

  const rules = held ? rulesOf(held, agentId) : [];
  const changes = onDisk && held ? ruleChanges(onDisk, held) : 0;

  /** Replace this agent's rules, as a draft on the whole document. */
  const write = useCallback(
    (next: readonly SidecarRule[]) => {
      if (!held) return;
      feed.setText(DOCUMENT, serializeSidecar(withRules(held, agentId, next)));
    },
    [agentId, feed, held],
  );

  const editRule = useCallback(
    (index: number, patch: Partial<SidecarRule>) =>
      write(rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule))),
    [rules, write],
  );
  const editMatch = useCallback(
    <K extends keyof RuleMatch>(index: number, key: K, value: RuleMatch[K]) => {
      const rule = rules[index];
      if (rule) editRule(index, { match: withMatch(rule.match, key, value) });
    },
    [editRule, rules],
  );

  const configured = policy ? rowsFrom(policy, "config") : [];
  /* ORCA's own floor, appended after the sidecar (#140). Read-only like the configured
     rules and for a stronger reason: those at least have a file to be edited in. */
  const defaults = policy ? rowsFrom(policy, "default") : [];
  const editable = canSet && held !== undefined;

  return (
    <aside className="orca-policy" aria-label={`Permissions for ${agentId}`}>
      <div className="orca-policy__head">
        <Text style="heading" as="h2">
          Permissions
        </Text>
        {/* The same id the card is named by, and kept whole the same way: one line, cut at
            its end only when the panel cannot hold it, with the id in its title. */}
        <span className={`orca-id ${textClass("mono-strong")} orca-policy__agent`} title={agentId}>
          {agentId}
        </span>
        <span className="orca-spacer" />
        {/* No warning on Close any more: the draft is held above this panel (#175's
            review), so closing it puts the edits down rather than throwing them away. */}
        <Button size="sm" tone="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {changes > 0 && (
        <Text style="caption" className="orca-policy__none">
          Unsaved grant edits are kept while you look elsewhere. They are written only by Save.
        </Text>
      )}

      {feed.state.phase === "loading" && <Text style="caption">Reading the policy…</Text>}
      {feed.state.phase === "error" && (
        <Text style="caption" className="orca-policy__none">
          {`Could not read the configuration: ${feed.state.error.code}: ${feed.state.error.message}`}
        </Text>
      )}

      {data && (
        <>
          <Text style="caption">
            In the order ORCA evaluates it: the rules in the config first, then the ones written to the sidecar, then
            ORCA&apos;s own defaults. The first rule that matches decides, and anything no rule matches takes the
            fallthrough below.
          </Text>

          {/* The configured half. Hand-written, and edited where it was written. */}
          <section className="orca-policy__section" aria-label="Configured rules">
            <div className="orca-policy__section-head">
              <Text style="label-strong">From the config</Text>
              <Chip>config</Chip>
              <span className="orca-spacer" />
              {onOpen !== undefined && (
                <Button size="sm" tone="ghost" onClick={() => onOpen(configUrl("config"))}>
                  Edit in the configuration
                </Button>
              )}
            </div>
            <Text style="caption" className="orca-policy__none">
              {/* Why they are read-only here, said out loud rather than left as a dead row. */}
              These are the config&apos;s own rules. Nothing machine-written rewrites the agents array a person curated,
              so they are edited on the Config surface.
            </Text>
            {configured.length === 0 ? (
              <Text style="caption" className="orca-policy__none">
                No configured rules; every tool call falls through to the sidecar and then to the fallthrough.
              </Text>
            ) : (
              <ol className="orca-config__rules">
                {configured.map((row) => (
                  <li key={row.order} className="orca-config__rule">
                    <span className={`orca-config__order ${textClass("mono-id")}`}>{row.order}</span>
                    <span className={`orca-config__rule-text ${textClass("mono-body")}`} title={row.text}>
                      {row.text}
                    </span>
                    <Chip>{row.source}</Chip>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* The written half. */}
          <section className="orca-policy__section" aria-label="Written grants">
            <div className="orca-policy__section-head">
              <Text style="label-strong">Written by &quot;allow always&quot;</Text>
              <Chip>sidecar</Chip>
              <span className="orca-spacer" />
              {editable && (
                <Button size="sm" onClick={() => write([...rules, handRule((now ?? isoNow)())])}>
                  Add a grant
                </Button>
              )}
            </div>
            <span className={`orca-config__path ${textClass("mono-id")}`}>{data.permissions.path}</span>

            {held === undefined ? (
              <Text style="caption" className="orca-policy__none">
                The sidecar is not valid JSON, so it cannot be edited here. Open it in the configuration&apos;s raw view
                and fix it there.
              </Text>
            ) : rules.length === 0 ? (
              <Text style="caption" className="orca-policy__none">
                Nothing has been granted with &quot;always&quot; for this agent.
              </Text>
            ) : (
              <ol className="orca-policy__grants">
                {rules.map((rule, index) => (
                  <Grant
                    key={`${index}:${rule.addedAt ?? ""}`}
                    rule={rule}
                    agentId={agentId}
                    index={index}
                    /* The number a configured rule list ends at, continued: these rules are
                       evaluated after those, and numbering them from 1 again would draw a
                       precedence that is not the one `decidePermission` uses. */
                    order={configured.length + index + 1}
                    live={live}
                    editable={editable}
                    onDecision={(decision) => editRule(index, { decision })}
                    onMatch={(key, value) => editMatch(index, key, value)}
                    onRemove={() => write(rules.filter((_, at) => at !== index))}
                  />
                ))}
              </ol>
            )}
          </section>

          {/* ORCA's floor, last. Its own group because it is neither of the documents: no
              path under it, no link out of it, and nothing here or on the Config surface
              that can edit it — the way to change it is to write a `default:` in the
              config, which opts out of these rules entirely (#140). */}
          {defaults.length > 0 && (
            <section className="orca-policy__section" aria-label={POLICY_LAYERS[2].title}>
              <div className="orca-policy__section-head">
                <Text style="label-strong">{POLICY_LAYERS[2].title}</Text>
                <Chip>default</Chip>
              </div>
              <Text style="caption" className="orca-policy__none">
                ORCA&apos;s own floor, applied because the config left the fallthrough unset. No file holds them, so
                there is nothing to open and nothing to edit; writing a fallthrough in the config opts out of them.
              </Text>
              <ol className="orca-config__rules">
                {defaults.map((row) => (
                  <li key={row.order} className="orca-config__rule">
                    <span className={`orca-config__order ${textClass("mono-id")}`}>{row.order}</span>
                    <span className={`orca-config__rule-text ${textClass("mono-body")}`} title={row.text}>
                      {row.text}
                    </span>
                    <Chip>{row.source}</Chip>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* Only when there is one. An agent the effective policy does not name has no
              fallthrough to report, and "ask" would be this panel inventing the answer to
              the one question the file deliberately leaves to configuration (rule 12). */}
          {policy !== undefined && (
            <Text style="caption">
              {`Anything no rule matches: ${policy.default} — from the config. The sidecar carries no fallthrough, because answering one prompt must not change the answer to every other one.`}
            </Text>
          )}
          {policy === undefined && (
            <Text style="caption" className="orca-policy__none">
              The effective policy does not name this agent, so ORCA has not said what happens when no rule matches.
            </Text>
          )}
          {/* Said once, here, because the issue asks for it and the runtime cannot supply it. */}
          <Text style="caption" className="orca-policy__none">
            ORCA does not count how often a rule fired: permission decisions are evaluated per tool call and no running
            total is kept, so there is no auto-approval count to show.
          </Text>
        </>
      )}

      {/* Absent where there is nothing to send to — file mode and a read-only daemon have no
          `config.set` at all, and a greyed Save on a viewer reads as broken. */}
      {canSet && changes > 0 && (
        <DraftBar
          changes={changes}
          busy={save.busy}
          {...(save.conflict === undefined ? {} : { conflict: save.conflict })}
          {...(save.message === undefined ? {} : { message: save.message })}
          {...(writability.can ? {} : { disabledReason: writability.reason })}
          note="Saving replaces the whole sidecar. Rules you did not touch keep when they were added and what for."
          onValidate={() => feed.validate(DOCUMENT)}
          onSave={() => feed.save(DOCUMENT)}
          onDiscard={() => feed.discard(DOCUMENT)}
          onReload={feed.reload}
        />
      )}
    </aside>
  );
}

const isoNow = (): string => new Date().toISOString();

interface GrantProps {
  rule: SidecarRule;
  /** Whose policy this is, and where in the file the rule sits: together they are its path. */
  agentId: string;
  index: number;
  order: number;
  live: boolean;
  editable: boolean;
  onDecision: (decision: SidecarRule["decision"]) => void;
  onMatch: <K extends keyof RuleMatch>(key: K, value: RuleMatch[K]) => void;
  onRemove: () => void;
}

/**
 * One written grant: the sentence it amounts to, its provenance, and the four narrowings a
 * `PermissionRule` allows a person to set.
 *
 * `path` and `pathPrefix` are both here and both text, because they are different promises —
 * one file, or a tree — and a control that offered "locations" as one box would have to
 * guess which. `scope` is the third, and it is the one that needs no path written down.
 */
function Grant({
  rule,
  agentId,
  index,
  order,
  live,
  editable,
  onDecision,
  onMatch,
  onRemove,
}: GrantProps): JSX.Element {
  /* The path into the sidecar this row writes, which is what `ConfigField` says it is for:
     a form over a file a person also hand-edits has to name the key each row changes. */
  const base = `agents.${agentId}.rules[${index}]`;
  const text = describeRule({ ...rule, source: "permissions" });
  return (
    <li className="orca-policy__grant">
      <div className="orca-policy__grant-head">
        <span className={`orca-config__order ${textClass("mono-id")}`}>{order}</span>
        {/* The same sentence the Config surface's read-only list draws, tagged with the
            document it is in — which for a rule in this section is always the sidecar. It
            truncates at its end in a narrow panel, so the whole of it is in its title. */}
        <span className={`orca-config__rule-text ${textClass("mono-body")}`} title={text}>
          {text}
        </span>
        <span className="orca-spacer" />
        {/* The default tone, and no armed second state — unlike Release on the claims list.
            Remove edits the draft and nothing else: the grant leaves this list, the save bar
            counts one change, and the file is untouched until Save, with Discard as the way
            back until then. A destructive control confirms only an act with no way back
            (docs/design/60-implementation.md), and here that act is Save, so a confirmation
            on the row would be a second commit in front of it. It was red on every grant at
            rest, which is saturation no status put on a resting screen (the brand book's
            Colour): the danger tone is for the control that commits a destructive act, like
            Release's ✕ Confirm, not for one that drafts it. */}
        {editable && (
          <Button size="sm" onClick={onRemove} aria-label={`Remove grant ${order}`}>
            Remove
          </Button>
        )}
      </div>

      <div className="orca-policy__provenance">
        {rule.addedAt !== undefined && <Time at={new Date(rule.addedAt)} show={live ? "both" : "absolute"} />}
        {rule.grantedFor !== undefined && (
          <Text style="caption" className="orca-config__granted">
            {`granted for ${rule.grantedFor}`}
          </Text>
        )}
      </div>

      <Choice
        label="Decision"
        path={`${base}.decision`}
        value={rule.decision}
        choices={PERMISSION_DECISIONS}
        editable={editable}
        required
        onChoose={(value) => onDecision(value as SidecarRule["decision"])}
      />
      <Choice
        label="Tool kind"
        path={`${base}.match.kind`}
        value={rule.match.kind}
        choices={TOOL_KINDS}
        editable={editable}
        help="Which kind of tool call this matches. Any kind when it is not set."
        onChoose={(value) => onMatch("kind", value as RuleMatch["kind"])}
      />
      <Entry
        label="Path"
        path={`${base}.match.path`}
        value={rule.match.path}
        editable={editable}
        help="One exact location, relative to the run's workspace — so a grant survives a fresh worktree."
        onChange={(value) => onMatch("path", value)}
      />
      <Entry
        label="Path prefix"
        path={`${base}.match.pathPrefix`}
        value={rule.match.pathPrefix}
        editable={editable}
        help="A tree rather than a file: any location under this prefix."
        onChange={(value) => onMatch("pathPrefix", value)}
      />
      <Choice
        label="Scope"
        path={`${base}.match.scope`}
        value={rule.match.scope}
        choices={["workspace", "outside-workspace"]}
        editable={editable}
        help="Where the call's locations are. A call with no locations at all matches neither."
        onChoose={(value) => onMatch("scope", value as RuleMatch["scope"])}
      />
      <Entry
        label="Title pattern"
        path={`${base}.match.titlePattern`}
        value={rule.match.titlePattern}
        editable={editable}
        help="A regular expression tested against the tool call's title, used exactly as written. The rules a run writes are anchored with ^ and $; one typed here is not anchored for you, so it matches anywhere in the title unless you anchor it."
        onChange={(value) => onMatch("titlePattern", value)}
      />
    </li>
  );
}

interface ChoiceProps {
  label: string;
  path: string;
  value: string | undefined;
  choices: readonly string[];
  editable: boolean;
  required?: boolean;
  help?: string;
  onChoose: (value: string | undefined) => void;
}

/**
 * An enum, as a `Menu` — every popover in this app is one (AGENTS.md). An optional one
 * offers **Any**, which clears the key rather than writing a word the schema would reject.
 *
 * The `Menu` is its own accessible name (its `label` names the trigger and the list), so the
 * field's ids go on the read-only rendering and not onto the trigger — the same division
 * `config-form.tsx` makes, and for the same reason: the trigger belongs to the primitive.
 */
function Choice({ label, path, value, choices, editable, required, help, onChoose }: ChoiceProps): JSX.Element {
  const items = [...(required ? [] : [ANY_ITEM]), ...choices.map((choice) => ({ id: choice, label: choice }))];
  return (
    <ConfigField label={label} path={path} document="permissions" {...(help === undefined ? {} : { help })}>
      {(control) =>
        editable ? (
          <Menu
            label={`${label}, currently ${value ?? "any"}`}
            items={items}
            onChoose={(item) => onChoose(item === ANY_ITEM ? undefined : item.id)}
            triggerClassName={`orca-input ${textClass("mono-body")}`}
          >
            {value ?? "Any"}
          </Menu>
        ) : (
          <span {...control} className={`orca-config__value ${textClass("mono-body")}`}>
            {value ?? "Any"}
          </span>
        )
      }
    </ConfigField>
  );
}

interface EntryProps {
  label: string;
  path: string;
  value: string | undefined;
  editable: boolean;
  help?: string;
  onChange: (value: string | undefined) => void;
}

/**
 * A string narrowing. An empty box deletes the key rather than writing `""`.
 *
 * Where there is nothing to write to it degrades to text, the way `Choice` does: a
 * `--read-only` daemon has no `config.set`, and a panel of boxes that quietly refuse typing
 * is a screen promising an edit it cannot make. Read-only is a different rendering, not a
 * disabled one — the same rule the rest of this panel follows when it leaves **Save** and
 * **Remove** out rather than greying them.
 */
function Entry({ label, path, value, editable, help, onChange }: EntryProps): JSX.Element {
  return (
    <ConfigField label={label} path={path} document="permissions" {...(help === undefined ? {} : { help })}>
      {(control) =>
        editable ? (
          <input
            {...control}
            className={`orca-input ${textClass("mono-body")}`}
            type="text"
            value={value ?? ""}
            onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
          />
        ) : (
          /* "Any" and not an empty box: an unset narrowing means the rule does not narrow
             on this key, which is the same sentence `Choice` reads out. */
          <span {...control} className={`orca-config__value ${textClass("mono-body")}`}>
            {value ?? "Any"}
          </span>
        )
      }
    </ConfigField>
  );
}
