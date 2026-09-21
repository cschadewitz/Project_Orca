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
import { THEMES } from "@orca/design";
import type { ConfigSetParams, NotificationMessage } from "@orca/protocol";
import { ConfigSurface } from "../src/config/config-surface.js";
import { CONFIG_GET, CONFIG_REVISION, CONFIG_TEXT } from "./fixtures-config.js";
import { AS_OF, HELLO_READ_ONLY } from "./fixtures.js";
import { harness, installBridge, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";
import { expectedToken, installDesignSystem, resolved, setTheme } from "./themes.js";

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

function renderConfig(connection: "live" | "disconnected" | "file" = "live"): void {
  /* Appearance over the *bridge's* preference store rather than over a memory one: the
     preferences section's whole claim is that it writes through `window.orca.preferences`. */
  h = harness("darwin", window.orca.preferences);
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
      <ConfigSurface connection={connection} />
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
const field = (label: string): HTMLInputElement =>
  screen.getByLabelText<HTMLInputElement>(new RegExp(`^${label}`));

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
            ? { ok: true, result: { document: CONFIG_GET.config, written: false, validation: { errors: [] }, asOf: AS_OF } }
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
      "config.set": () => ({ ok: false, error: { code: "CONFIG_STALE", message: "/workspace/orca.config.yaml has changed since you read it" } }),
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

    expect(rules).toHaveLength(2);
    // Configured first, sidecar second — the order ORCA evaluates in, not one this screen chose.
    expect(rules[0]!.textContent).toContain("config");
    expect(rules[0]!.textContent).toContain("allow execute matching ^npm test$");
    expect(rules[1]!.textContent).toContain("sidecar");
    expect(rules[1]!.textContent).toContain("allow edit under src");
    // A sidecar rule carries why it exists; a configured one has nothing to carry.
    expect(rules[1]!.textContent).toContain("granted for Edit src/index.ts");
    expect(within(permissions).getByText(/Anything no rule matches: allow/).textContent).toContain("from the config");
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
    fake.connect({ state: "live", since: AS_OF, capabilities: HELLO_READ_ONLY.capabilities });
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
    expect(document.querySelector(".orca-config__body")?.classList.contains("orca-stale-value")).toBe(true);
  });
});

describe("app preferences", () => {
  it("are labelled as the app's, and are written the moment they are chosen", async () => {
    renderConfig();
    const section = await screen.findByRole("region", { name: "App preferences" });
    expect(
      within(section).getByText("App preferences — stored by the app, not in orca.config.yaml"),
    ).toBeTruthy();

    fireEvent.click(within(section).getByRole("button", { name: "Theme" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "dark" }));

    // Straight to the app's own preference store, never to `config.set`: they are the
    // person's, not the workspace's.
    await waitFor(() => expect(window.orca.preferences.read().theme).toBe("dark"));
    expect(setsOf()).toEqual([]);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
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
