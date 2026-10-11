/**
 * The primitive preview — `#preview` in a dev build, and the review surface for the rest
 * of the desktop-app milestone.
 *
 * Every primitive, both themes, side by side, driven by the design system's own lists
 * (`RUN_STATUSES`, `SCHEDULE_CLASSES`, `STATE_VIEW_KINDS`, `THEMES`) rather than by a copy
 * of them here. That is the whole point: add a status to semantics.json and it appears on
 * this page without anyone editing it, which is also how a missing glyph or an unreadable
 * pairing gets noticed before it reaches a screen.
 *
 * It is dev-only — `routes.tsx` only imports it under `import.meta.env.DEV`, so the branch
 * and its dynamic import are dead code in a production build and never reach the bundle.
 */
import { useState, type JSX, type ReactNode } from "react";
import {
  CONNECTION_PRESENTATION,
  RUN_STATUSES,
  SCHEDULE_CLASSES,
  STATE_VIEW_KINDS,
  THEMES,
  type ConnectionState,
  type ThemeId,
} from "@orca/design";
import {
  Button,
  Card,
  Chip,
  ConfigField,
  ConnectionIndicator,
  Duration,
  ObjectHeader,
  ScheduleBadge,
  StateView,
  StatusChip,
  StatusDot,
  Text,
  Time,
  Well,
  textClass,
} from "../ui/index.js";
import "./preview.css";

/* Derived, never re-declared: the design system owns the list of states. */
const CONNECTION_STATES = Object.keys(CONNECTION_PRESENTATION) as ConnectionState[];

/* Fixed instants, so two themes render identical text and a screenshot diff is signal. */
const STARTED = new Date(Date.now() - 4 * 60 * 1000 - 12 * 1000);
const LAST_EVENT = new Date(Date.now() - 6 * 60 * 1000);

export function Preview(): JSX.Element {
  return (
    <div className="preview">
      <header className="preview__head">
        <Text style="title" as="h1">
          Primitives
        </Text>
        <Text style="caption">
          Both themes, every component, from the design system&rsquo;s own lists. The type scale and the bundled glyphs
          are at <a href="#type">#type</a>. Daemon resource fixtures are at <a href="#resources">#resources</a>.
        </Text>
      </header>
      <div className="preview__themes">
        {THEMES.map((theme) => (
          <ThemeColumn key={theme} theme={theme} />
        ))}
      </div>
    </div>
  );
}

export default Preview;

function ThemeColumn({ theme }: { theme: ThemeId }): JSX.Element {
  return (
    <section className="preview__theme orca-surface" data-theme={theme} aria-label={`${theme} theme`}>
      <Text style="eyebrow">{theme}</Text>

      <Section title="Type styles">
        <div className="preview__stack">
          <Text style="display">Display — a number that owns a screen</Text>
          <Text style="title">Title — the object you are looking at</Text>
          <Text style="heading">Heading — a group within a pane</Text>
          <Text style="body">Body — prose a person wrote.</Text>
          <Text style="body-strong">Body strong — the one clause that matters.</Text>
          <Text style="label">Label — a control&rsquo;s name</Text>
          <Text style="caption">Caption — recency and asides</Text>
          <Text style="eyebrow">Eyebrow — a kicker</Text>
          <Text style="mono-id">mono-id — 7f3a2c9e</Text>
          <Text style="mono-body">mono-body — steps.build.agent</Text>
          <Text style="mono-log">mono-log — npm run build exited 1</Text>
        </div>
      </Section>

      <Section title="Run statuses">
        <div className="preview__row">
          {RUN_STATUSES.map((status) => (
            <StatusChip key={status} status={status} />
          ))}
        </div>
        <div className="preview__row">
          {RUN_STATUSES.map((status) => (
            <StatusChip key={status} status={status} glyphOnly />
          ))}
        </div>
        <div className="preview__row">
          {RUN_STATUSES.map((status) => (
            <StatusDot key={status} status={status} label={status} />
          ))}
          <StatusChip status="failed" label="failed ×3" />
        </div>
        {/* `aligned`, the column a list of statuses forms: every chip at the longest word's
            width, so the glyphs line up down the list. */}
        <div className="preview__stack">
          {RUN_STATUSES.map((status) => (
            <StatusChip key={status} status={status} aligned />
          ))}
          <StatusChip status="failed" label="failed ×3" aligned />
        </div>
      </Section>

      <Section title="Schedule classes">
        {/* The schedule column: each mark at the aligned badge's width, a settled item's
            outcome chip at the same width, and the why beside each — never inside the tint —
            so every why starts at one edge. */}
        <div className="preview__stack">
          {SCHEDULE_CLASSES.map((classification) => (
            <span key={classification}>
              <ScheduleBadge classification={classification} onExplain={noop} aligned />
            </span>
          ))}
          <span>
            <StatusChip status="succeeded" aligned="schedule" />
            <button type="button" className={`orca-badge__why ${textClass("caption")}`} onClick={noop}>
              why
            </button>
          </span>
        </div>
      </Section>

      <Section title="Connection">
        <div className="preview__stack">
          {CONNECTION_STATES.map((state) => (
            <ConnectionIndicator
              key={state}
              state={state}
              since={state === "reconnecting" ? STARTED : LAST_EVENT}
              eventCursor={4821}
              versions={{ app: "0.2.0", daemon: "0.3.0" }}
            />
          ))}
        </div>
      </Section>

      <Section title="Controls">
        <div className="preview__row">
          <Button>Default</Button>
          <Button tone="primary">Primary</Button>
          <Button tone="danger">Cancel run</Button>
          <Button tone="ghost">Ghost</Button>
          <Button size="sm">Small</Button>
          <Button size="lg">Large</Button>
          <Button disabled disabledReason="Disconnected from the daemon">
            Disabled
          </Button>
        </div>
        <div className="preview__row">
          <Chip>plan</Chip>
          <Chip glyph="⌘">Command palette</Chip>
          <Chip>attempt 2 of 3</Chip>
        </div>
      </Section>

      <Section title="Time">
        <div className="preview__row">
          <Duration ms={412} />
          <Duration ms={4200} />
          <Duration ms={42_000} />
          <Duration ms={4_320_000} />
          <Duration ms={97_200_000} />
          <Duration since={STARTED} />
        </div>
        <div className="preview__stack">
          <Time at={LAST_EVENT} />
          <Time at={LAST_EVENT} show="absolute" />
          <Time at={LAST_EVENT} show="relative" />
        </div>
      </Section>

      <Section title="Surfaces">
        <Card tone="gate" eyebrow="Gate · waiting 4m">
          <p className={`orca-card__q ${textClass("body-strong")}`}>
            Ship the migration behind a flag, or hold for review?
          </p>
          <p className={`orca-card__sub ${textClass("caption")}`}>auth-sso-epic · run 7f3a2c</p>
          <div className="orca-card__options">
            <Button tone="primary">Ship behind a flag</Button>
            <Button>Hold for review</Button>
          </div>
        </Card>
        <Well label="Handshake result">{'{\n  "protocol": "1.0",\n  "daemon": "0.3.0"\n}'}</Well>
      </Section>

      <Section title="Config field">
        <ConfigField
          label="Daemon URL"
          path="daemon.url"
          help="Where the app attaches. ORCA_DAEMON_URL overrides it."
          onShowRaw={noop}
        >
          {(control) => (
            <input className={`orca-input ${textClass("mono-body")}`} defaultValue="127.0.0.1:6722" {...control} />
          )}
        </ConfigField>
        <ConfigField label="Max attempts" path="engine.retries.max" error="Must be a whole number." onShowRaw={noop}>
          {(control) => (
            <input
              className={`orca-input ${textClass("mono-body")} orca-input--invalid`}
              defaultValue="two"
              {...control}
            />
          )}
        </ConfigField>
      </Section>

      <Section title="Object header">
        <div className="preview__pane">
          <ObjectHeaderDemo />
        </div>
      </Section>

      <Section title="State views">
        {STATE_VIEW_KINDS.map((kind) => (
          <div className="preview__pane" key={kind}>
            {kind === "loading" ? (
              <StateView kind="loading" title="Loading runs" />
            ) : (
              <StateView
                kind={kind}
                title={STATE_TITLES[kind].title}
                body={STATE_TITLES[kind].body}
                action={{ label: STATE_TITLES[kind].action, onClick: noop }}
              />
            )}
          </div>
        ))}
      </Section>
    </section>
  );
}

/* Sentence case, subject first, no exclamation marks (rule 13). Each body says what to do. */
const STATE_TITLES: Record<
  Exclude<(typeof STATE_VIEW_KINDS)[number], "loading">,
  { title: string; body: string; action: string }
> = {
  empty: {
    title: "No runs yet",
    body: "A run appears here as soon as a workflow starts. Start one from the command palette.",
    action: "Start a run",
  },
  error: {
    title: "Could not load runs",
    body: "The daemon answered, but the run list failed to parse. The daemon log has the detail.",
    action: "Retry",
  },
  disconnected: {
    title: "Disconnected from the daemon",
    body: "The last known runs are still shown, dimmed. Reconnect to see what has happened since.",
    action: "Reconnect",
  },
  "no-results": {
    title: "No runs match this filter",
    body: "Sixty-one runs are hidden by the current filter. Clearing it shows them again.",
    action: "Clear the filter",
  },
};

function ObjectHeaderDemo(): JSX.Element {
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  return (
    <>
      <ObjectHeader
        crumbs={[
          { type: "request", id: "sso-rollout", label: "sso-rollout" },
          { type: "item", id: "auth-sso-epic", label: "auth-sso-epic" },
          { type: "run", id: "7f3a2c", label: "7f3a2c" },
          { type: "step", id: "build.2", label: "build (attempt 2)", current: true },
        ]}
        actions={<Button size="sm">Cancel run</Button>}
        onOpen={(crumb) => setChosen(`open ${crumb.type} ${crumb.id}`)}
        onOpenCounterpart={(crumb, counterpart) => setChosen(`${crumb.id} → ${counterpart.label}`)}
      />
      <Text style="caption" as="p">
        {chosen ?? "Nothing chosen yet."}
      </Text>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="preview__section">
      <Text style="heading" as="h2">
        {title}
      </Text>
      {children}
    </section>
  );
}

const noop = (): void => {};
