// @vitest-environment happy-dom
/**
 * The artifact panel in the docked panel, against the fake preload bridge.
 *
 * The store behind it is `fixtures-artifacts.ts`, which is the daemon fixture's own
 * artifact story: three versions of one `spec` produced by three attempts at one node, and
 * a screenshot that is not text. So the diff below is a real `v2 → v3`, and the omitted
 * body is the one `artifacts.get` actually declines.
 */
import { Profiler, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DockedPanel } from "../src/chrome/docked-panel.js";
import { ArtifactPanelProvider, useArtifactPanel, type ArtifactTarget } from "../src/artifacts/panel-context.js";
import { RUN_ART } from "./fixtures-artifacts.js";
import { artifactRecorded } from "./artifact-events.js";
import { harness, installBridge, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

/** Opens the panel on a target as soon as it is mounted — what a chip's click does. */
function Opener({ target }: { target: ArtifactTarget }): null {
  const panel = useArtifactPanel();
  useEffect(() => panel.open(target), []);
  return null;
}

function renderPanel(target: ArtifactTarget, onRender: () => void = () => {}): void {
  h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Profiler id="panel" onRender={onRender}>
      <Providers>
        <ArtifactPanelProvider>
          <Opener target={target} />
          <DockedPanel onClose={() => {}} />
        </ArtifactPanelProvider>
      </Providers>
    </Profiler>,
  );
}

const SPEC: ArtifactTarget = { runId: "run-art", name: "spec", version: 3 };

const panel = (): HTMLElement => document.querySelector<HTMLElement>(".orca-panel")!;
const versionButtons = (): HTMLElement[] =>
  within(screen.getByRole("group", { name: "Artifact versions" })).getAllByRole("button");
const diffLines = (): { gutter: string; text: string; kind: string }[] =>
  [...document.querySelectorAll<HTMLElement>(".orca-diff__line")].map((line) => ({
    gutter: line.querySelector(".orca-diff__gutter")?.textContent ?? "",
    text: (line.textContent ?? "").slice(line.querySelector(".orca-diff__gutter")?.textContent?.length ?? 0),
    kind: line.className.includes("--add") ? "add" : line.className.includes("--del") ? "del" : "same",
  }));

/** `[` and `]` as the keyboard map reads them: `key`, since neither is a letter. */
const press = (key: string): void => {
  fireEvent.keyDown(panel(), { key, code: key === "[" ? "BracketLeft" : "BracketRight" });
};

describe("the artifact panel", () => {
  beforeEach(() => {
    fake = installBridge();
    fake.script({
      "runs.get": ({ runId }) =>
        runId === "run-art"
          ? { ok: true, result: RUN_ART }
          : { ok: false, error: { code: "RUN_NOT_FOUND", message: runId } },
    });
  });

  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("shows nothing pinned until something opens it, and the panel still closes", () => {
    h = harness();
    teardown.push(h.dispose);
    const { Providers } = h;
    render(
      <Providers>
        <ArtifactPanelProvider>
          <DockedPanel onClose={() => {}} />
        </ArtifactPanelProvider>
      </Providers>,
    );
    expect(screen.getByText("Nothing pinned")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Close panel/ })).toBeTruthy();
  });

  it("lists every version of the name, oldest first, from artifacts.list", async () => {
    renderPanel(SPEC);
    await waitFor(() => expect(versionButtons()).toHaveLength(3));

    expect(versionButtons().map((b) => b.textContent)).toEqual(["v1", "v2", "v3"]);
    expect(versionButtons().map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    // Metadata only: the version list must not cost three bodies.
    expect(fake.calls.filter((c) => c.method === "artifacts.list")).toEqual([
      { method: "artifacts.list", params: { runId: "run-art", name: "spec" } },
    ]);
  });

  it("shows the body raw, and offers no rendered toggle at all", async () => {
    renderPanel(SPEC);
    await screen.findByText(/Rotate the refresh token/);

    expect(document.querySelector(".orca-artifact__body")?.tagName).toBe("PRE");
    // The toggle is absent, not disabled: a markdown renderer is a dependency decision
    // this package has not taken, and a disabled control would promise one.
    expect(screen.queryByRole("button", { name: /render|preview|markdown/i })).toBeNull();
  });

  it("refreshes mounted versions without moving the chosen historical version or comparison", async () => {
    let artifacts = RUN_ART.artifacts.filter((a) => a.name === "spec");
    fake.script({
      "artifacts.list": () => ({ ok: true, result: { artifacts, total: artifacts.length, asOf: RUN_ART.asOf } }),
    });
    renderPanel({ ...SPEC, version: 2, compareWith: 1 });
    await waitFor(() => expect(diffLines().length).toBeGreaterThan(0));
    const before = diffLines();
    const bodies = fake.calls.filter((c) => c.method === "artifacts.get");
    const next = { ...artifacts[2]!, id: "art-spec-v4", version: 4 };
    artifacts = [...artifacts, next];

    const release = fake.hold("artifacts.list");
    await act(async () => fake.notify(artifactRecorded("run-art", next)));
    expect(diffLines()).toEqual(before);
    expect(versionButtons()).toHaveLength(3);
    await act(async () => release());

    expect(versionButtons().map((b) => b.textContent)).toEqual(["v1", "v2", "v3", "v4"]);
    expect(versionButtons().map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false", "false"]);
    expect(screen.getByRole("button", { name: /Comparing with v1/ })).toBeTruthy();
    expect(diffLines()).toEqual(before);
    expect(fake.calls.filter((c) => c.method === "artifacts.get")).toEqual(bodies);
    expect(fake.calls.filter((c) => c.method === "artifacts.list")).toHaveLength(2);
  });

  it("steps versions with [ and ], registered in the panel scope", async () => {
    await act(async () => {
      renderPanel(SPEC);
    });
    await waitFor(() => expect(versionButtons()).toHaveLength(3));

    expect(
      h.keyboard
        .list()
        .filter((s) => s.scope === "panel")
        .map((s) => s.key),
    ).toEqual(["[", "]"]);

    await act(async () => {
      press("[");
    });
    await waitFor(() => expect(versionButtons()[1]!.getAttribute("aria-pressed")).toBe("true"));
    await act(async () => {
      press("[");
    });
    await waitFor(() => expect(versionButtons()[0]!.getAttribute("aria-pressed")).toBe("true"));
    // At the first version there is nowhere further back: the key does nothing rather
    // than wrapping to the newest.
    await act(async () => {
      press("[");
    });
    expect(versionButtons()[0]!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      press("]");
    });
    await waitFor(() => expect(versionButtons()[1]!.getAttribute("aria-pressed")).toBe("true"));
  });

  it("diffs v2 into v3 with gutters, never with colour alone", async () => {
    renderPanel(SPEC);
    await screen.findByText(/Rotate the refresh token/);

    fireEvent.click(screen.getByRole("button", { name: /Compare with another version/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Compare with v2" }));

    await waitFor(() => expect(diffLines().length).toBeGreaterThan(0));
    expect(screen.getByText(/v2 → v3: 2 added, 1 removed/)).toBeTruthy();

    const changed = diffLines().filter((l) => l.kind !== "same");
    expect(changed).toEqual([
      { gutter: "−", text: "# Spec v2", kind: "del" },
      { gutter: "+", text: "# Spec v3", kind: "add" },
      { gutter: "+", text: "- Rotate the refresh token", kind: "add" },
    ]);
    // Every unchanged line still carries a gutter cell, so the columns line up.
    expect(diffLines().every((l) => l.gutter.length === 1)).toBe(true);

    // And the comparison can be put down again, back to the body.
    fireEvent.click(screen.getByRole("button", { name: /Comparing with v2/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "No comparison" }));
    await waitFor(() => expect(diffLines()).toHaveLength(0));
  });

  it("drops the comparison when the version is stepped, rather than accumulating one", async () => {
    renderPanel({ runId: "run-art", name: "spec", version: 3, compareWith: 2 });
    await waitFor(() => expect(diffLines().length).toBeGreaterThan(0));

    press("[");
    await waitFor(() => expect(diffLines()).toHaveLength(0));
    expect(versionButtons()[1]!.getAttribute("aria-pressed")).toBe("true");
  });

  it.each([
    { version: 3, compareWith: 2, key: "[", expected: 2 },
    { version: 2, compareWith: 1, key: "]", expected: 3 },
  ])("handles $key as soon as the v$version diff is committed", async ({ version, compareWith, key, expected }) => {
    let pressed = false;
    renderPanel({ runId: "run-art", name: "spec", version, compareWith }, () => {
      if (!pressed && diffLines().length > 0) {
        pressed = true;
        // The public commit callback runs after layout and before passive effects.
        // Dispatch natively, as KeyboardMap listens on window outside React.
        panel().dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            code: key === "[" ? "BracketLeft" : "BracketRight",
            bubbles: true,
          }),
        );
      }
    });
    await waitFor(() => expect(pressed).toBe(true));
    await waitFor(() => expect(versionButtons()[expected - 1]!.getAttribute("aria-pressed")).toBe("true"));
    expect(diffLines()).toHaveLength(0);
  });

  it("says so, with the code, when the daemon answers the version list badly", async () => {
    fake.fail("artifacts.list", { code: "AGENT_TRANSPORT", message: "no daemon" });
    renderPanel(SPEC);
    expect(await screen.findByText("AGENT_TRANSPORT: no daemon")).toBeTruthy();
  });

  it("says so when the body itself cannot be read", async () => {
    fake.fail("artifacts.get", { code: "ARTIFACT_NOT_FOUND", message: "no such artifact" });
    renderPanel(SPEC);
    expect(await screen.findByText("ARTIFACT_NOT_FOUND: no such artifact")).toBeTruthy();
  });

  it("shows the reason where the body would be when the daemon omits one", async () => {
    renderPanel({ runId: "run-art", name: "screenshot", version: 1 });

    expect(await screen.findByText("This body is not shown (binary).")).toBeTruthy();
    expect(screen.getByText("image/png is not text; 4.0 kB on disk")).toBeTruthy();
    // Not an error state: nothing failed and there is nothing to retry.
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("says which steps of the run read this version, from StepView.inputArtifactIds", async () => {
    renderPanel({ runId: "run-art", name: "spec", version: 2 });
    // `art-spec-v2` is in `s-spec-3`'s `inputArtifactIds`: the third attempt read the
    // second version.
    expect(await screen.findByText("spec (attempt 3)")).toBeTruthy();
    expect(screen.getByText(/read by/)).toBeTruthy();
  });

  it("shows no consumed-by section when the run cannot be read, and renders anyway", async () => {
    fake.fail("runs.get", { code: "RUN_NOT_FOUND", message: "gone" });
    renderPanel(SPEC);
    await screen.findByText(/Rotate the refresh token/);
    expect(screen.queryByText(/read by/)).toBeNull();
  });

  it("names the artifact in the panel header, so the dock says what is in it", async () => {
    renderPanel(SPEC);
    await screen.findByText(/Rotate the refresh token/);
    const head = document.querySelector<HTMLElement>(".orca-pane__head")!;
    expect(within(head).getByText("spec@v3")).toBeTruthy();
  });
});
