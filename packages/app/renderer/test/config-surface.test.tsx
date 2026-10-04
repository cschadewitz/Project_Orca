// @vitest-environment happy-dom
/**
 * The Config surface against the fake preload bridge: the form the schema draws, the patch
 * round trip, the stale refusal, the two views of one document, the sidecar beside it, and
 * the preferences that are not ORCA's at all.
 *
 * Everything goes through `window.orca`, which is the whole of "the daemon" as far as the
 * renderer is concerned — so a screen that sent the wrong write fails here rather than
 * against somebody's `orca.config.yaml`.
 *
 * One deviation from the issue's own worked example is worth naming: it describes an error
 * placed at `hosts[1].type`, and the config fixture has no `hosts:` block. The same claim
 * is made against `agents.0.command` — reported by the daemon in *dotted* notation, placed
 * on a field the form drew from `agents[].command`, which is the whole of what that case is
 * about.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { THEMES, type ConnectionState } from "@orca/design";
import type { ConfigSetParams, NotificationMessage } from "@orca/protocol";
import { ConfigProvider } from "../src/config/config-context.js";
import { ConfigSurface } from "../src/config/config-surface.js";
import { CONFIG_GET, CONFIG_REVISION, CONFIG_TEXT } from "./fixtures-config.js";
import { AS_OF, HELLO, HELLO_READ_ONLY } from "./fixtures.js";
import { harness, installBridge, renderChrome, stubMatchMedia, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";
import { expectedToken, installDesignSystem, resolved, setTheme } from "./themes.js";

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

function renderConfig(connection: ConnectionState = "live"): void {
  /* The word the surface is given and the snapshot the chrome reads are the same daemon:
     `useWritability()` and `useMethodPresent()` read the snapshot, so a test that said
     "disconnected" to the surface alone would be testing a screen the app never shows.
     A test that has already pushed its own connection keeps it. */
  if (connection !== "live" && fake.connection.state === "live") {
    fake.connect({ ...fake.connection, state: connection });
  }
  /* Appearance over the *bridge's* preference store rather than over a memory one: the
     preferences section's whole claim is that it writes through `window.orca.preferences`. */
  h = harness("darwin", window.orca.preferences);
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
      {/* `App` mounts this above the surface switch, so a test of the surface mounts it
          too: the draft model is one per app, not one per screen (#175). */}
      <ConfigProvider>
        <ConfigSurface connection={connection} />
      </ConfigProvider>
    </Providers>,
  );
}

beforeEach(() => {
  fake = installBridge();
  teardown.push(fake.install());
});

afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

const setsOf = (): ConfigSetParams[] =>
  fake.calls.filter((call) => call.method === "config.set").map((call) => call.params as ConfigSetParams);
const reads = (): number => fake.calls.filter((call) => call.method === "config.get").length;

/** The input a field draws, found by the field's label. */
const field = (label: string): HTMLInputElement => screen.getByLabelText<HTMLInputElement>(new RegExp(`^${label}`));

/** A `config.changed` frame: a document, its new revision, and no cursor — it is not a run. */
const configChanged = (revision: string, document = "config"): NotificationMessage => ({
  kind: "notification",
  method: "config.changed",
  params: { subscriptionId: "sub-1", document, revision, path: "/workspace/orca.config.yaml", at: AS_OF },
});

describe("the form the schema draws", () => {
  it("is a section per top-level key, with each field showing the path it writes", async () => {
    renderConfig();
    await screen.findByRole("region", { name: "Agents" });

    expect(screen.getByRole("region", { name: "General" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Human input" })).toBeTruthy();

    // The dotted path is on the field and is not a tooltip: it is how the form reconciles
    // with a file a person also hand-edits.
    const command = field("Command");
    expect(command.value).toBe("claude-code");
    expect(screen.getByText("agents[0].command")).toBeTruthy();
    // Every field offers the raw view, naming the document it would open.
    expect(screen.getByRole("button", { name: "show agents[0].command in the raw YAML" })).toBeTruthy();
  });

  it("shows what the schema cannot describe as read-only JSON, labelled", async () => {
    renderConfig();
    await screen.findByRole("region", { name: "Agents" });
    const well = screen.getByRole("region", { name: "agents[0].roles as JSON" });
    expect(well.textContent).toContain("developer");
    expect(screen.getByText(/Read-only here/)).toBeTruthy();
  });
});

describe("the patch round trip", () => {
  it("validates, places the daemon's error on the field, and saves the fixed value as a patch", async () => {
    fake.script({
      "config.set": (params) => {
        if (params.validateOnly === true) {
          const patched = params.patch?.[0]?.value;
          return patched === "claude-code"
            ? {
                ok: true,
                result: { document: CONFIG_GET.config, written: false, validation: { errors: [] }, asOf: AS_OF },
              }
            : {
                ok: true,
                result: {
                  document: CONFIG_GET.config,
                  written: false,
                  // Dotted, the way a daemon that walked the parsed document reports it.
                  validation: { errors: [{ path: "agents.0.command", message: "no such executable" }] },
                  asOf: AS_OF,
                },
              };
        }
        return { ok: true, result: { document: CONFIG_GET.config, written: true, asOf: AS_OF } };
      },
    });

    renderConfig();
    await screen.findByRole("region", { name: "Agents" });

    fireEvent.change(field("Command"), { target: { value: "claude-code-next" } });
    const bar = await screen.findByRole("group", { name: "Unsaved configuration changes" });
    expect(within(bar).getByText("1 change")).toBeTruthy();

    fireEvent.click(within(bar).getByRole("button", { name: "Validate" }));
    // The error arrives keyed `agents.0.command` and lands on the field drawn from
    // `agents[].command`: one notation, whichever one the daemon used.
    await screen.findByText("no such executable");
    expect(field("Command").getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(field("Command"), { target: { value: "claude-code" } });
    // Typed back to what the file says: nothing to write, so the bar is gone.
    await waitFor(() => expect(screen.queryByRole("group", { name: "Unsaved configuration changes" })).toBeNull());

    fireEvent.change(field("Command"), { target: { value: "claude-code-next" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => expect(setsOf().filter((params) => params.validateOnly !== true)).toHaveLength(1));
    const write = setsOf().find((params) => params.validateOnly !== true)!;
    expect(write.document).toBe("config");
    // The revision the draft was made against, and a patch rather than the whole file: the
    // comments in that file survive only because this is a patch.
    expect(write.expectedRevision).toBe(CONFIG_REVISION);
    expect(write.patch).toEqual([{ path: "agents[0].command", value: "claude-code-next" }]);
    expect(write.text).toBeUndefined();
  });

  it("announces the save in the app's one live region", async () => {
    const said: string[] = [];
    renderConfig();
    teardown.push(h.announcements.subscribe((sentence) => said.push(sentence)));
    await screen.findByRole("region", { name: "Agents" });

    fireEvent.change(field("Command"), { target: { value: "claude-code-next" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(said).toEqual(["Config saved"]));
  });

  it("keeps the draft when the file moved underneath it, and offers the reload", async () => {
    renderConfig();
    await screen.findByRole("region", { name: "Agents" });
    fireEvent.change(field("Command"), { target: { value: "claude-code-next" } });

    // The fake refuses any revision but the fixture's, which is the one refusal a form has
    // to handle: somebody else wrote the file between the read and the save.
    fake.script({
      "config.set": () => ({
        ok: false,
        error: { code: "CONFIG_STALE", message: "/workspace/orca.config.yaml has changed since you read it" },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    const bar = await screen.findByRole("group", { name: "Unsaved configuration changes" });
    await within(bar).findByText(/The file changed since you read it/);
    expect(within(bar).getByRole("button", { name: "Reload" })).toBeTruthy();
    // The draft is still here. Losing it would be the worst thing this screen could do.
    expect(field("Command").value).toBe("claude-code-next");
    expect(within(bar).getByText("1 change")).toBeTruthy();
  });

  it("discards on request, and only then", async () => {
    renderConfig();
    await screen.findByRole("region", { name: "Agents" });
    fireEvent.change(field("Command"), { target: { value: "claude-code-next" } });
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(field("Command").value).toBe("claude-code"));
    expect(setsOf()).toEqual([]);
  });
});

describe("the pushes", () => {
  it("re-reads on a revision it is not holding, and ignores its own write coming back", async () => {
    renderConfig();
    await screen.findByRole("region", { name: "Agents" });
    expect(reads()).toBe(1);

    // The revision this screen already holds: the file it is looking at is the file the
    // daemon is telling it about. Re-reading would throw away the scroll for nothing.
    act(() => fake.notify(configChanged(CONFIG_REVISION)));
    await waitFor(() => expect(reads()).toBe(1));

    act(() => fake.notify(configChanged("somebody-elses-revision")));
    await waitFor(() => expect(reads()).toBe(2));
  });

  it("never polls", async () => {
    renderConfig();
    await screen.findByRole("region", { name: "Agents" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads()).toBe(1);
  });
});

describe("the raw view", () => {
  it("sends the bytes, not a patch, and says which write replaced which", async () => {
    renderConfig();
    await screen.findByRole("region", { name: "Agents" });

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "orca.config.yaml" });
    expect(editor.value).toBe(CONFIG_TEXT);

    fireEvent.change(editor, { target: { value: `${CONFIG_TEXT}# and a new comment\n` } });
    const bar = await screen.findByRole("group", { name: "Unsaved configuration changes" });
    expect(within(bar).getByText(/last edited wins/)).toBeTruthy();

    fireEvent.click(within(bar).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setsOf()).toHaveLength(1));
    expect(setsOf()[0]!.text).toBe(`${CONFIG_TEXT}# and a new comment\n`);
    expect(setsOf()[0]!.patch).toBeUndefined();
  });

  it("opens on the line a field's path is written on", async () => {
    renderConfig();
    await screen.findByRole("region", { name: "Agents" });
    fireEvent.click(screen.getByRole("button", { name: "show agents[0].command in the raw YAML" }));

    await screen.findByText("agents[0].command is on line 7.");
    // The highlight is the design system's own class, on the line itself.
    const line = screen.getByLabelText("Line 7");
    expect(line.querySelector(".orca-yaml__hl")?.textContent).toContain("command: claude-code");
  });

  it("says the file is shown as it is, because nothing in it is redacted", async () => {
    renderConfig();
    await screen.findByRole("region", { name: "Agents" });
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(
      (await screen.findAllByText(/This is the file as it is on disk. Nothing in it is hidden or redacted./)).length,
    ).toBeGreaterThan(0);
  });
});

describe("the permission sidecar", () => {
  it("lists the effective rules in evaluation order, each chipped with the document it came from", async () => {
    renderConfig();
    const permissions = await screen.findByRole("region", { name: "Permissions" });
    const rules = within(permissions).getAllByRole("listitem");

    // One configured, two written, one of ORCA's own: the whole effective policy, in order.
    expect(rules).toHaveLength(4);
    // Configured first, sidecar second — the order ORCA evaluates in, not one this screen chose.
    expect(rules[0]!.textContent).toContain("config");
    expect(rules[0]!.textContent).toContain("allow execute matching ^npm test$");
    expect(rules[1]!.textContent).toContain("sidecar");
    expect(rules[1]!.textContent).toContain("allow edit under src");
    // A sidecar rule carries why it exists; a configured one has nothing to carry.
    expect(rules[1]!.textContent).toContain("granted for Edit src/index.ts");
    expect(within(permissions).getByText(/Anything no rule matches: allow/).textContent).toContain("from the config");
  });

  it("shows ORCA's defaults as their own group, with no file and nothing to edit", async () => {
    renderConfig();
    const permissions = await screen.findByRole("region", { name: "Permissions" });

    /* The floor is drawn as a floor. Before the daemon tagged it (#140) it arrived as
       `config` and this screen said a rule nobody wrote was one a person wrote. */
    expect(within(permissions).getByText("ORCA's defaults")).toBeTruthy();
    expect(within(permissions).getByText(/No file holds them/)).toBeTruthy();

    const rules = within(permissions).getAllByRole("listitem");
    expect(rules[3]!.textContent).toContain("default");
    expect(rules[3]!.textContent).toContain("allow read in the workspace");
    // Last, because the defaults are appended after the sidecar and the order is the policy.
    expect(rules[3]!.textContent).toContain("4");
    // Each layer under its own heading, and the two that are documents keep their words.
    expect(within(permissions).getByText("From the config")).toBeTruthy();
    expect(within(permissions).getByText('Written by "allow always"')).toBeTruthy();
  });

  it("shows the sidecar's own JSON, and offers no way to write it here", async () => {
    renderConfig();
    const sidecar = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "orca.permissions.json" });
    expect(sidecar.readOnly).toBe(true);
    expect(sidecar.value).toContain("grantedFor");
  });
});

describe("what the connection changes", () => {
  it("has no save bar on a daemon that does not offer the control methods", async () => {
    fake.script({ hello: () => Promise.resolve({ ok: true, result: HELLO_READ_ONLY }) });
    fake.connect({
      state: "live",
      since: AS_OF,
      capabilities: HELLO_READ_ONLY.capabilities,
      // It answers `config.get` and not `config.set`: the screen is readable, not writable.
      methods: HELLO_READ_ONLY.methods ?? [],
    });
    renderConfig();
    await screen.findByRole("region", { name: "Agents" });

    // Absent, not disabled: a read-only daemon answers "unknown method" to `config.set`,
    // and a greyed Save on a viewer reads as broken (40-connection-states.md).
    const command = field("Command");
    expect(command.readOnly).toBe(true);
    fireEvent.change(command, { target: { value: "claude-code-next" } });
    expect(screen.queryByRole("group", { name: "Unsaved configuration changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(setsOf()).toEqual([]);
  });

  it("keeps the last read and says so when no daemon is answering", async () => {
    renderConfig("disconnected");
    await screen.findByRole("region", { name: "Agents" });
    expect(screen.getByText(/Not connected — this is the last the daemon said/)).toBeTruthy();
    // The values dim; the labels around them do not.
    expect(document.querySelector(".orca-config__form")?.classList.contains("orca-stale-value")).toBe(true);
    expect(screen.getByRole("region", { name: "Local diagnostics" }).closest(".orca-stale-value")).toBeNull();
  });

  /**
   * The gate is `hello.methods`, not the `runs.control` capability (#175's review). The
   * capability is one word over several dispatch tables: a daemon serving a store outside a
   * workspace drives runs and has no `config.set` at all, and a client that read the
   * capability would draw a bar over a method nobody answers.
   */
  it("has no save bar when the daemon's methods do not include config.set", async () => {
    fake.connect({
      state: "live",
      since: AS_OF,
      // The control capability *is* here: this daemon drives runs. It has no configuration.
      capabilities: HELLO.capabilities,
      methods: (HELLO.methods ?? []).filter((method) => method !== "config.set"),
    });
    renderConfig();
    await screen.findByRole("region", { name: "Agents" });

    const command = field("Command");
    expect(command.readOnly).toBe(true);
    fireEvent.change(command, { target: { value: "claude-code-next" } });
    expect(screen.queryByRole("group", { name: "Unsaved configuration changes" })).toBeNull();
    expect(setsOf()).toEqual([]);
  });

  it("has the save bar when they do", async () => {
    fake.connect({
      state: "live",
      since: AS_OF,
      capabilities: HELLO.capabilities,
      methods: HELLO.methods ?? [],
    });
    renderConfig();
    await screen.findByRole("region", { name: "Agents" });

    fireEvent.change(field("Command"), { target: { value: "claude-code-next" } });
    const bar = await screen.findByRole("group", { name: "Unsaved configuration changes" });
    expect(within(bar).getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBeNull();
  });

  /**
   * Disconnected is not file mode: the daemon would take this write if it were answering,
   * so the bar stays, the two buttons say why they will not fire, and the count of what is
   * unsaved is still on screen (docs/design/40-connection-states.md).
   */
  it("keeps the bar and disables its buttons with the reason while disconnected", async () => {
    renderConfig("disconnected");
    await screen.findByRole("region", { name: "Agents" });

    fireEvent.change(field("Command"), { target: { value: "claude-code-next" } });
    const bar = await screen.findByRole("group", { name: "Unsaved configuration changes" });
    expect(within(bar).getByText("1 change")).toBeTruthy();

    for (const name of ["Save", "Validate"]) {
      const button = within(bar).getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      // The reason is *on the control*, which is what `disabledReason` is for.
      expect(button.getAttribute("title")).toContain("no daemon is answering");
    }
    fireEvent.click(within(bar).getByRole("button", { name: "Save" }));
    expect(setsOf()).toEqual([]);
  });

  it("keeps the bar while reconnecting, for the same reason", async () => {
    renderConfig("reconnecting");
    await screen.findByRole("region", { name: "Agents" });

    fireEvent.change(field("Command"), { target: { value: "claude-code-next" } });
    const bar = await screen.findByRole("group", { name: "Unsaved configuration changes" });
    expect(within(bar).getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe("true");
  });
});

describe("app preferences", () => {
  it("are labelled as the app's, and are written the moment they are chosen", async () => {
    renderConfig();
    const section = await screen.findByRole("region", { name: "App preferences" });
    expect(within(section).getByText("App preferences — stored by the app, not in orca.config.yaml")).toBeTruthy();

    fireEvent.click(within(section).getByRole("button", { name: "Theme" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "dark" }));

    // Straight to the app's own preference store, never to `config.set`: they are the
    // person's, not the workspace's.
    await waitFor(() => expect(window.orca.preferences.read().theme).toBe("dark"));
    expect(setsOf()).toEqual([]);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  /**
   * The section draws what is remembered *now* rather than what was remembered when it
   * mounted: `⌘⇧L` cycles the theme from the keyboard map, and a copy taken at mount would
   * leave this screen claiming a theme the window is not in (#175's review).
   */
  it("follows ⌘⇧L rather than the snapshot it mounted with", async () => {
    renderConfig();
    const section = await screen.findByRole("region", { name: "App preferences" });
    const theme = (): string | null => within(section).getByRole("button", { name: "Theme" }).textContent;
    expect(theme()).toBe("system");

    /* `findByRole` resolves on the DOM, which React commits before it runs the passive
       effects — and the section subscribes to the preference store in one of those. A
       press dispatched in that window writes the preference and is never heard, which
       leaves the row showing the snapshot it mounted with: the very thing this test says
       does not happen, failing about once in a dozen runs for a reason a person could
       never produce. The flush closes the window. */
    await act(async () => {});

    act(() => {
      fireEvent.keyDown(window, { key: "L", code: "KeyL", metaKey: true, shiftKey: true });
    });

    await waitFor(() => expect(theme()).toBe(window.orca.preferences.read().theme));
    expect(theme()).not.toBe("system");
  });

  /**
   * The third remembered appearance, and the one a person can set by *accident* (#280). A
   * theme and a density are chosen from a menu; a pane width is a drag, and the only other
   * way back to the design's default is `Enter` or a double-click on the boundary itself.
   */
  it("lists a boundary once it has been dragged, and nothing while every one is at its default", async () => {
    renderConfig();
    const said: string[] = [];
    teardown.push(h.announcements.subscribe((sentence) => said.push(sentence)));
    const section = await screen.findByRole("region", { name: "App preferences" });
    await act(async () => {});

    /* Nothing dragged, so nothing listed: five rows all reading "default" would be five rows
       saying nothing, and would bury the theme and the densities that are worth reading. */
    expect(within(section).queryByText("Sidebar size")).toBeNull();
    expect(within(section).queryByRole("button", { name: /^Restore/ })).toBeNull();

    act(() => h.appearance.set({ panes: { sidebar: 400 } }));

    expect(within(section).getByText("Sidebar size")).toBeTruthy();
    expect(within(section).getByText("400px")).toBeTruthy();

    fireEvent.click(within(section).getByRole("button", { name: "Restore the sidebar" }));

    /* A deletion rather than a write of the token's value: `panes` holds only what somebody
       chose, so absent is what "default" means and the next change to the token reaches here. */
    await waitFor(() => expect(window.orca.preferences.read().panes.sidebar).toBeUndefined());
    expect(within(section).queryByText("Sidebar size")).toBeNull();
    expect(said).toContain("Sidebar back to its default size.");
  });

  it("says a stacked boundary as the share of its column it is, because that is what is kept", async () => {
    renderConfig();
    const section = await screen.findByRole("region", { name: "App preferences" });
    await act(async () => {});

    act(() => h.appearance.set({ panes: { "runs-tree": 0.42 } }));

    /* Not a px count (#281): the run tree's size is a ratio, and reporting it in px would be
       inventing a window height — the very thing storing it as a ratio exists to avoid. */
    expect(within(section).getByText("42% of its column")).toBeTruthy();
  });
});

describe("what the form says out loud, and what it does not", () => {
  /**
   * RULES.md rule 11. An error on the field a person is editing is in front of them
   * already; what is news is the *result* of pressing Validate, and that is one sentence in
   * the app's one announcer rather than a region per field.
   */
  it("places an error without a live region, and announces the first one once", async () => {
    const said: string[] = [];
    fake.script({
      "config.set": () => ({
        ok: true,
        result: {
          document: CONFIG_GET.config,
          written: false,
          validation: { errors: [{ path: "agents.0.command", message: "no such executable" }] },
          asOf: AS_OF,
        },
      }),
    });
    renderConfig();
    teardown.push(h.announcements.subscribe((sentence) => said.push(sentence)));
    await screen.findByRole("region", { name: "Agents" });

    fireEvent.change(field("Command"), { target: { value: "nope" } });
    fireEvent.click(await screen.findByRole("button", { name: "Validate" }));

    const error = await screen.findByText("no such executable");
    expect(error.getAttribute("role")).toBeNull();
    expect(error.closest("[aria-live]")).toBeNull();
    // Described, so it reaches the person whose focus is on the control.
    expect(field("Command").getAttribute("aria-describedby")).toContain(error.id);

    await waitFor(() => expect(said).toEqual(["Config not valid: no such executable"]));
    expect(document.querySelectorAll(".orca-config [role=alert], .orca-config [aria-live]")).toHaveLength(0);
  });

  it("says the code's message rather than the code", async () => {
    fake.script({
      "config.set": () => ({
        ok: false,
        error: { code: "CONFIG_INVALID", message: "humanInput.mode must be one of pause, cli, auto" },
      }),
    });
    renderConfig();
    await screen.findByRole("region", { name: "Agents" });

    fireEvent.change(field("Command"), { target: { value: "claude-code-next" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    const bar = await screen.findByRole("group", { name: "Unsaved configuration changes" });
    await waitFor(() => expect(bar.textContent).toContain("humanInput.mode must be one of pause, cli, auto"));
    // The code belongs in a log and a bug report, not in a sentence (RULES.md rule 13).
    expect(bar.textContent).not.toContain("CONFIG_INVALID");
  });

  /** An enum field is a `Menu`, and the `Menu` is the control the field labels. */
  it("reaches an enum field by its label, not by its position", async () => {
    renderConfig();
    await screen.findByRole("region", { name: "Human input" });

    const mode = screen.getByLabelText(/^Mode/);
    expect(mode.tagName).toBe("BUTTON");
    fireEvent.click(mode);
    fireEvent.click(await screen.findByRole("menuitem", { name: "auto" }));

    await screen.findByRole("group", { name: "Unsaved configuration changes" });
  });

  it("reaches the preferences' theme control by its label too", async () => {
    renderConfig();
    await screen.findByRole("region", { name: "App preferences" });
    expect(screen.getByLabelText(/^Theme/).tagName).toBe("BUTTON");
  });

  it("says that a saved configuration is read by the next orca serve", async () => {
    renderConfig();
    await screen.findByRole("region", { name: "Agents" });
    expect(screen.getByText(/takes effect on the next orca serve/)).toBeTruthy();
  });
});

/**
 * The draft model is mounted above the surface switch (`ConfigProvider`), which is the only
 * way "I typed something, looked at a run and came back" can keep what was typed: `App`
 * unmounts the Config surface like every other screen.
 */
describe("a draft and the rest of the app", () => {
  const goTo = async (surface: string): Promise<void> => {
    fireEvent.click(await screen.findByRole("button", { name: surface }));
  };

  it("survives a trip to another surface, change count and all", async () => {
    stubMatchMedia(1440);
    h = harness("darwin", window.orca.preferences);
    teardown.push(h.dispose);
    renderChrome(h);

    await goTo("Config");
    await screen.findByRole("region", { name: "Agents" });
    fireEvent.change(field("Command"), { target: { value: "claude-code-next" } });
    expect(
      within(await screen.findByRole("group", { name: "Unsaved configuration changes" })).getByText("1 change"),
    ).toBeTruthy();

    await goTo("Runs");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Agents" })).toBeNull());

    await goTo("Config");
    const bar = await screen.findByRole("group", { name: "Unsaved configuration changes" });
    expect(within(bar).getByText("1 change")).toBeTruthy();
    expect(field("Command").value).toBe("claude-code-next");
    // And it is still one read: coming back re-reads nothing, because nothing was dropped.
    expect(reads()).toBe(1);
  });
});

describe("both themes", () => {
  it("binds the field border and the raw highlight to their tokens", async () => {
    installDesignSystem();
    document.body.classList.add("orca");
    renderConfig();
    await screen.findByRole("region", { name: "Agents" });

    for (const theme of THEMES) {
      setTheme(theme);
      // The control's edge is `border-control`, which is what makes an input look like
      // something you can type in on either ground.
      expect(resolved(field("Command"), "border-top-color")).toBe(expectedToken(theme, "border-control"));
    }

    // And the highlight, which is on the other view of the same document.
    fireEvent.click(screen.getByRole("button", { name: "show agents[0].command in the raw YAML" }));
    await screen.findByLabelText("Line 7");
    for (const theme of THEMES) {
      setTheme(theme);
      // `accent-subtle`: accent means interactive, and "this is the line you asked for" is
      // the one thing on the raw view that is.
      const highlight = document.querySelector(".orca-yaml__hl") as HTMLElement;
      expect(resolved(highlight, "background-color")).toBe(expectedToken(theme, "accent-subtle"));
    }
    setTheme(undefined);
  });
});
