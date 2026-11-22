// @vitest-environment happy-dom
/**
 * The palette's `contents` source (#255): event text and artifact contents come from the
 * daemon's `search`, and every hit is still a canonical `orca://` URL opened through the
 * route table. A daemon that does not serve `search` gets no content rows at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { SearchResult } from "@orca/protocol";
import { PaletteObjectSources } from "../src/palette/object-sources.js";
import { artifactUrl, runUrl, stepUrl } from "../src/route-table.js";
import type { PaletteSource } from "../src/palette/sources.js";
import { harness, type Harness } from "./harness.js";
import { HELLO } from "./fixtures.js";
import { fakeBridge, type FakeBridge } from "./fake-bridge.js";

const AS_OF = "2026-11-22T10:00:00.000Z";
const teardown: (() => void)[] = [];

const RESULT: SearchResult = {
  hits: [
    {
      kind: "event",
      runId: "run-a",
      seq: 7,
      type: "step.failed",
      step: { nodeId: "build", attempt: 2 },
      excerpt: "Upstream refused the connection",
    },
    { kind: "event", runId: "run-b", seq: 3, type: "run.failed", excerpt: "connection reset" },
    {
      kind: "artifact",
      runId: "run-a",
      artifactId: "art-1",
      name: "notes",
      version: 2,
      excerpt: "a pooled connection",
    },
  ],
  scannedRuns: 2,
  asOf: AS_OF,
};

function mount(fake: FakeBridge): { h: Harness; onOpen: ReturnType<typeof vi.fn>; contents: () => PaletteSource } {
  const h = harness();
  teardown.push(h.dispose, fake.install());
  const onOpen = vi.fn();
  const { Providers } = h;
  render(
    <Providers>
      <PaletteObjectSources onOpen={onOpen} />
    </Providers>,
  );
  const contents = () => {
    const source = h.paletteSources.list().find((s) => s.id === "contents");
    if (!source) throw new Error("the contents source is not registered");
    return source;
  };
  return { h, onOpen, contents };
}

describe("the palette's content search", () => {
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("asks the daemon and opens each hit as an orca:// place", async () => {
    const fake = fakeBridge();
    fake.script({ search: () => ({ ok: true, result: RESULT }) });
    const { onOpen, contents } = mount(fake);
    await waitFor(() => contents());
    const source = contents();
    expect(source.section).toBe("search");

    const rows = await source.entries("connection");
    expect(fake.calls.filter((c) => c.method === "search").map((c) => c.params)).toEqual([
      { query: "connection", limit: 20 },
    ]);
    expect(rows.map((r) => [r.label, r.detail])).toEqual([
      ["Upstream refused the connection", "step.failed in build"],
      ["connection reset", "run.failed"],
      ["notes v2", "a pooled connection"],
    ]);
    for (const row of rows) row.run();
    expect(onOpen.mock.calls.map(([url]) => url)).toEqual([
      stepUrl("run-a", "build", 2),
      runUrl("run-b"),
      artifactUrl("run-a", "notes", 2),
    ]);
    for (const [url] of onOpen.mock.calls) expect(url).toMatch(/^orca:\/\//);
  });

  it("says when the daemon stopped short instead of implying it found everything", async () => {
    const fake = fakeBridge();
    fake.script({ search: () => ({ ok: true, result: { ...RESULT, truncated: "deadline" } }) });
    const { contents } = mount(fake);
    await waitFor(() => contents());
    const rows = await contents().entries("connection");
    const last = rows[rows.length - 1]!;
    expect(last.label).toBe("More matches may exist");
    expect(last.unavailable).toMatch(/stopped looking/);
  });

  it("does not ask for a query shorter than the daemon accepts", async () => {
    const fake = fakeBridge();
    const { contents } = mount(fake);
    await waitFor(() => contents());
    expect(await contents().entries("c")).toEqual([]);
    expect(fake.calls.some((c) => c.method === "search")).toBe(false);
  });

  it("drops a query that the next keystroke superseded", async () => {
    const fake = fakeBridge();
    fake.script({ search: () => ({ ok: true, result: RESULT }) });
    const { contents } = mount(fake);
    await waitFor(() => contents());
    const first = contents().entries("conn");
    const second = contents().entries("connection");
    expect(await first).toEqual([]);
    expect((await second).length).toBe(3);
    expect(fake.calls.filter((c) => c.method === "search")).toHaveLength(1);
  });

  it("leaves content search out against a daemon that does not serve it", async () => {
    const methods = (HELLO.methods ?? []).filter((m) => m !== "search");
    const fake = fakeBridge({
      connection: {
        state: "live",
        since: AS_OF,
        orcaVersion: HELLO.orcaVersion,
        capabilities: HELLO.capabilities,
        methods,
      },
    });
    const { contents } = mount(fake);
    await waitFor(() => contents());
    expect(await contents().entries("connection")).toEqual([]);
    expect(fake.calls.some((c) => c.method === "search")).toBe(false);
  });
});
