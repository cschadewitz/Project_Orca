// @vitest-environment happy-dom
/**
 * Search in the Runs console (#340 over #255): visibly unavailable on a daemon that does not
 * answer `search`, one daemon call per settled query with stale answers dropped, every hit a
 * canonical `orca://` URL opened through the route table, and a cut-short scan said out loud.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SEARCH_METHOD, type SearchResult } from "@orca/protocol";
import { RunsSurface } from "../src/runs/runs-surface.js";
import { hitUrl, SEARCH_DELAY_MS } from "../src/runs/search/run-search.js";
import { HELLO } from "./fixtures.js";
import { installBridge, harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

let fake: FakeBridge;
const teardown: (() => void)[] = [];
let opened: string[] = [];

const RESULT: SearchResult = {
  hits: [
    {
      kind: "event",
      runId: "run-parent",
      seq: 7,
      type: "step.failed",
      step: { nodeId: "build", attempt: 2 },
      excerpt: "Upstream refused the connection",
    },
    { kind: "event", runId: "run-gate", seq: 3, type: "run.failed", excerpt: "connection reset" },
    {
      kind: "artifact",
      runId: "run-parent",
      artifactId: "art-1",
      name: "notes",
      version: 2,
      excerpt: "pooled connection",
    },
  ],
  scannedRuns: 2,
  asOf: "2026-03-01T09:00:00.000Z",
};

function renderRuns(): void {
  const h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
      <RunsSurface connection="live" onOpen={(url) => opened.push(url)} />
    </Providers>,
  );
}

const searches = () => fake.calls.filter((c) => c.method === SEARCH_METHOD);
const field = () => screen.getByRole("searchbox", { name: "Search run contents" });
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 20));
  });

describe("search in the Runs console", () => {
  beforeEach(() => {
    fake = installBridge();
    opened = [];
    fake.script({ search: () => ({ ok: true, result: RESULT }) });
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("asks once per settled query, and opens each hit by its canonical URL", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.change(field(), { target: { value: "co" } });
    fireEvent.change(field(), { target: { value: "conn" } });
    fireEvent.change(field(), { target: { value: "connection" } });
    await settle();
    expect(searches().map((c) => c.params)).toEqual([{ query: "connection", limit: 100 }]);

    const hits = within(await screen.findByRole("list", { name: "Search results" })).getAllByRole("button");
    expect(hits).toHaveLength(3);
    for (const hit of hits) fireEvent.click(hit);
    expect(opened).toEqual([
      "orca://run/run-parent/step/build.2",
      "orca://run/run-gate",
      "orca://artifact/notes%40v2?run=run-parent",
    ]);
    expect(opened[2]).toBe(hitUrl(RESULT.hits[2]!));
  });

  it("drops an answer for a query that has moved on", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const release = fake.hold("search");
    fireEvent.change(field(), { target: { value: "first" } });
    await settle();
    fake.script({
      search: (p) => ({ ok: true, result: { ...RESULT, hits: p.query === "second" ? [] : RESULT.hits } }),
    });
    fireEvent.change(field(), { target: { value: "second" } });
    await settle();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await screen.findByText("No matches");
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
  });

  it("says when the daemon cut the scan short", async () => {
    fake.script({ search: () => ({ ok: true, result: { ...RESULT, truncated: "deadline" } }) });
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.change(field(), { target: { value: "connection" } });
    await settle();
    expect(await screen.findByText(/More matches may exist/)).toBeTruthy();
  });

  it("is visibly unavailable on a daemon that does not answer search", async () => {
    fake.connect({ ...fake.connection, methods: (HELLO.methods ?? []).filter((m) => m !== SEARCH_METHOD) });
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    const button = screen.getByRole("button", { name: "Search" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toContain("search");
    fireEvent.click(button);
    expect(screen.queryByRole("searchbox", { name: "Search run contents" })).toBeNull();
    await waitFor(() => expect(searches()).toHaveLength(0));
  });
});
