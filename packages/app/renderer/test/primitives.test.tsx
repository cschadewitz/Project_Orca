import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CONNECTION_PRESENTATION,
  RUN_STATUSES,
  SCHEDULE_PRESENTATION,
  STATE_VIEW_PRESENTATION,
  STATUS_PRESENTATION,
  type ConnectionState,
  type ScheduleClass,
} from "@orca/design";
import {
  Button,
  Chip,
  ConfigField,
  ConnectionIndicator,
  ObjectHeader,
  ScheduleBadge,
  StateView,
  StatusChip,
  StatusDot,
  Text,
  Well,
  counterpartsFor,
} from "../src/ui/index.js";

/* No DOM here on purpose: static markup is enough to assert what a primitive renders, and
   the jsdom + both-themes harness (and the interaction tests that need it) is #154. */
const html = renderToStaticMarkup;

describe("StatusChip", () => {
  it("renders the glyph and the word for every status", () => {
    for (const status of RUN_STATUSES) {
      const { glyph, word } = STATUS_PRESENTATION[status];
      const markup = html(<StatusChip status={status} />);
      expect(markup, status).toContain(glyph);
      expect(markup, status).toContain(word);
      expect(markup, status).toContain(`orca-chip--${status}`);
    }
  });

  it("covers every status the design system declares, not a local list", () => {
    expect([...RUN_STATUSES].sort()).toEqual(Object.keys(STATUS_PRESENTATION).sort());
    expect(RUN_STATUSES).toHaveLength(8);
  });

  it("keeps the word in the accessible name when only the glyph is drawn", () => {
    for (const status of RUN_STATUSES) {
      const { glyph, word } = STATUS_PRESENTATION[status];
      const markup = html(<StatusChip status={status} glyphOnly />);
      expect(markup, status).toContain(glyph);
      expect(markup, status).toContain(`aria-label="${word}"`);
      /* The word is the name, not text: it must not be drawn twice. */
      expect(markup.replace(`aria-label="${word}"`, ""), status).not.toContain(`>${word}<`);
    }
  });

  it("takes a label override without losing the glyph", () => {
    const markup = html(<StatusChip status="failed" label="failed ×3" />);
    expect(markup).toContain(STATUS_PRESENTATION.failed.glyph);
    expect(markup).toContain("failed ×3");
  });

  it("is sized only by its own variants: content by default, the status column when aligned", () => {
    /* The column is the component's variant, not a surface's class: the run tree and the
       claims list each sized the chip themselves once, and only one of them was fixed. */
    expect(html(<StatusChip status="succeeded" />)).not.toContain("orca-chip--aligned");
    const aligned = html(<StatusChip status="succeeded" aligned />);
    expect(aligned).toContain("orca-chip--aligned");
    expect(aligned).toContain(`>${STATUS_PRESENTATION.succeeded.word}<`);
    // A glyph-only chip is already one fixed square; a column width would undo that.
    const square = html(<StatusChip status="succeeded" glyphOnly aligned />);
    expect(square).toContain("orca-chip--glyph-only");
    expect(square).not.toContain("orca-chip--aligned");
  });
});

describe("StatusDot", () => {
  it("is decorative unless it is given a name", () => {
    expect(html(<StatusDot status="running" />)).toContain("aria-hidden");
    expect(html(<StatusDot status="running" label="running" />)).toContain('aria-label="running"');
  });
});

describe("ScheduleBadge", () => {
  it("renders every schedule class with its word and an explanation control", () => {
    for (const classification of Object.keys(SCHEDULE_PRESENTATION) as ScheduleClass[]) {
      const markup = html(<ScheduleBadge classification={classification} onExplain={() => {}} />);
      expect(markup, classification).toContain(SCHEDULE_PRESENTATION[classification].word);
      expect(markup, classification).toContain("orca-badge__why");
    }
  });

  it("draws the why beside the badge's ground, never on it (rule 5)", () => {
    const markup = html(<ScheduleBadge classification="waiting" onExplain={() => {}} aligned />);
    // The badge's ground closes before the button opens: two siblings, not one nested in the other.
    expect(markup).toMatch(
      /^<span class="orca-badge [^"]*orca-badge--aligned"[^>]*>.*?<\/span><\/span><button[^>]*orca-badge__why/,
    );
    // Without a callback there is no button at all: the badge is a label.
    expect(html(<ScheduleBadge classification="waiting" />)).not.toContain("<button");
  });
});

describe("StatusChip in the schedule column", () => {
  it("takes the aligned badge's width rather than the status column's", () => {
    const markup = html(<StatusChip status="succeeded" aligned="schedule" />);
    expect(markup).toContain("orca-chip--aligned-schedule");
    expect(markup).not.toMatch(/orca-chip--aligned(?!-)/);
  });
});

describe("ConnectionIndicator", () => {
  it("renders the glyph and the word for every connection state", () => {
    for (const state of Object.keys(CONNECTION_PRESENTATION) as ConnectionState[]) {
      const markup = html(<ConnectionIndicator state={state} since={new Date()} />);
      expect(markup, state).toContain(CONNECTION_PRESENTATION[state].glyph);
      expect(markup, state).toContain(CONNECTION_PRESENTATION[state].word);
      expect(markup, state).toContain(`orca-conn--${state}`);
    }
  });

  it("shows the two versions on a mismatch", () => {
    const markup = html(
      <ConnectionIndicator state="mismatch" since={new Date()} versions={{ app: "0.2.0", daemon: "0.3.0" }} />,
    );
    expect(markup).toContain("daemon 0.3.0");
    expect(markup).toContain("app 0.2.0");
  });
});

describe("Button", () => {
  it("maps tone and size onto the class layer", () => {
    expect(html(<Button>Go</Button>)).toContain('class="orca-btn orca-text-label"');
    expect(html(<Button tone="primary">Go</Button>)).toContain("orca-btn--primary");
    expect(html(<Button tone="danger">Go</Button>)).toContain("orca-btn--danger");
    expect(html(<Button size="sm">Go</Button>)).toContain("orca-btn--sm");
  });

  it("takes the size its class layer expects, which the small button overrides (#211)", () => {
    /* `.orca-btn` is noted `type: label`; `.orca-btn--sm` is noted `type: caption`. The
       class-layer sweep in type-classes.test.tsx is what holds every button to this — the
       assertion here is that the size prop is what picks, and that `lg` is a bigger box
       rather than bigger type. */
    expect(html(<Button size="sm">Go</Button>)).toContain("orca-text-caption");
    expect(html(<Button size="lg">Go</Button>)).toContain("orca-text-label");
  });

  it("disables with aria-disabled and carries the reason, so it stays focusable", () => {
    const markup = html(
      <Button disabled disabledReason="Disconnected from the daemon">
        Cancel
      </Button>,
    );
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("Disconnected from the daemon");
    expect(markup).not.toContain('disabled=""');
  });
});

describe("Chip and Well", () => {
  it("a non-status chip is always plain", () => {
    expect(html(<Chip>plan</Chip>)).toContain("orca-chip--plain");
  });

  it("a well is sunken mono by default and keeps its whitespace", () => {
    const markup = html(<Well>{"a\n  b"}</Well>);
    expect(markup).toContain("orca-well");
    expect(markup).toContain("orca-text-mono-log");
    expect(markup).toContain("a\n  b");
  });
});

describe("Text", () => {
  it("renders the generated type-style class and the element asked for", () => {
    expect(html(<Text style="caption">6m ago</Text>)).toBe('<span class="orca-text-caption">6m ago</span>');
    expect(
      html(
        <Text style="title" as="h1">
          ORCA
        </Text>,
      ),
    ).toBe('<h1 class="orca-text-title">ORCA</h1>');
  });
});

describe("StateView", () => {
  it("draws the declared glyph and the caller's body for every kind but loading", () => {
    for (const kind of ["empty", "error", "disconnected", "no-results"] as const) {
      const markup = html(<StateView kind={kind} title="A title" body="A body" />);
      expect(markup, kind).toContain(STATE_VIEW_PRESENTATION[kind].glyph);
      expect(markup, kind).toContain("A body");
      expect(markup, kind).toContain(`orca-state--${kind}`);
    }
  });

  it("draws skeletons rather than a glyph while loading", () => {
    const markup = html(<StateView kind="loading" title="Loading runs" />);
    expect(markup).toContain("orca-skeleton");
    expect(markup).not.toContain("orca-state__glyph");
  });

  it("offers the action as a primary button", () => {
    const markup = html(
      <StateView
        kind="empty"
        title="No runs yet"
        body="Start one."
        action={{ label: "Start a run", onClick: () => {} }}
      />,
    );
    expect(markup).toContain("orca-btn--primary");
    expect(markup).toContain("Start a run");
  });
});

describe("ObjectHeader", () => {
  const crumbs = [
    { type: "item", id: "wi_01M4M899VKJZRZSBHNDY5M579G", label: "auth-sso-epic" },
    { type: "run", id: "run_01M4M8A1WDAQMMX98Q6KJH7X8P", label: "7f3a2c", current: true },
  ] as const;

  it("labels every crumb with its type and leaves the current one unlinked", () => {
    const markup = html(<ObjectHeader crumbs={crumbs} onOpen={() => {}} />);
    expect(markup).toContain('class="orca-crumb__type orca-text-eyebrow">item<');
    expect(markup).toContain('class="orca-crumb__type orca-text-eyebrow">run<');
    expect(markup).toContain("orca-crumb--current");
    expect(markup).toContain('aria-current="page"');
    /* Exactly one crumb is a button: the one that is not current. */
    expect(markup.match(/class="orca-crumb orca-text-label"/g)).toHaveLength(1);
  });

  it("follows each crumb's name and type with its id token, faint, the whole id in its title", () => {
    const markup = html(<ObjectHeader crumbs={crumbs} onOpen={() => {}} />);
    // Name, type, token: the token after the type word, never the raw id.
    expect(markup).toMatch(
      /auth-sso-epic<\/span><span class="orca-crumb__type orca-text-eyebrow">item<\/span><span class="orca-objid orca-objid--faint orca-text-mono-id" title="wi_01M4M899VKJZRZSBHNDY5M579G">/,
    );
    expect(markup).toContain('<span class="orca-objid__tail">5M579G</span>');
    expect(markup).toContain('<span class="orca-objid__tail">JH7X8P</span>');
    expect(markup).not.toContain(">wi_01M4M899VKJZRZSBHNDY5M579G<");
    // The type word beside it already says the kind, so the token does not say it again.
    expect(markup).not.toContain("orca-visually-hidden");
  });

  it("draws a crumb with no name as its token, in the label's place", () => {
    /* A request: `runs.list` carries `requestId` and no title, so the surface passes the id as
       the label — and the crumb draws its token rather than 30 raw characters in sans. */
    const id = "req_01M4M896DER1YQSTMV3G5BNH42";
    const markup = html(<ObjectHeader crumbs={[{ type: "request", id, label: id }, crumbs[0]]} onOpen={() => {}} />);
    expect(markup).not.toContain(`>${id}<`);
    expect(markup).toContain('<span class="orca-objid__tail">5BNH42</span>');
    // Said as "request 5BNH42" once: the type word is hidden from the name, which has it.
    expect(markup).toContain('<span class="orca-visually-hidden">request </span>');
    expect(markup).toContain('class="orca-crumb__type orca-text-eyebrow" aria-hidden="true">request<');
  });

  it("offers a menu on every crumb that has somewhere to go, and none on one that has not", () => {
    /* Copy link alone is enough for a disclosure: every crumb with a canonical `orca://`
       URL is an address another tool can be handed (#165), handler or no handler. */
    expect(html(<ObjectHeader crumbs={crumbs} />).match(/orca-crumb__more/g)).toHaveLength(2);
    const withMenus = html(<ObjectHeader crumbs={crumbs} onOpenCounterpart={() => {}} />);
    expect(withMenus.match(/orca-crumb__more/g)).toHaveLength(2);

    // A plan crumb: no URL to copy, no id a person is shown and no counterparts. (A step crumb
    // with no run above it has no URL either, but it has an id to copy, so it has a menu now.)
    const plan = [{ type: "plan", id: "plan-auth", label: "Auth rollout", current: true }] as const;
    expect(html(<ObjectHeader crumbs={plan} onOpenCounterpart={() => {}} />)).not.toContain("orca-crumb__more");
    const steps = [{ type: "step", id: "build.2", label: "build", current: true }] as const;
    expect(html(<ObjectHeader crumbs={steps} onOpenCounterpart={() => {}} />)).toContain("orca-crumb__more");
  });

  it("knows the four counterparts the information architecture names", () => {
    expect(counterpartsFor("item").map((c) => c.id)).toEqual(["runs", "dependencies"]);
    expect(counterpartsFor("run").map((c) => c.id)).toEqual(["claimed-item", "workflow"]);
    expect(counterpartsFor("workflow")).toEqual([]);
  });
});

describe("ConfigField", () => {
  it("always shows the dotted path and wires the control to its help and error", () => {
    const markup = html(
      <ConfigField
        label="Daemon URL"
        path="daemon.url"
        help="Where the app attaches."
        error="Not a URL."
        onShowRaw={() => {}}
      >
        {(control) => <input className="orca-input" {...control} />}
      </ConfigField>,
    );
    expect(markup).toContain("daemon.url");
    expect(markup).toContain("aria-describedby=");
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain("Where the app attaches.");
    expect(markup).toContain("Not a URL.");
  });
});
