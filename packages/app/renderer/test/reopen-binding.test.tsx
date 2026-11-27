// @vitest-environment happy-dom
/** #1192: a Config save keeps the first-run workspace reopenable, and a refused reopen says why on the first screen. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FirstRunBridge, FirstRunStatus } from "../../src/first-run-contract.js";
import { FIRST_RUN_SAMPLE } from "../../src/first-run-sample.js";
import { bindSavedConfigurationForReopening, isWorkspaceConfig } from "../src/first-run/reopen-binding.js";
import { NoDaemonView, noDaemonReason } from "../src/first-run/no-daemon-view.js";
import { fakeBridge } from "./fake-bridge.js";

const UNBOUND = "The workspace's configuration was saved without being bound for reopening.";
const changed: FirstRunStatus = {
  state: "selection-required",
  reason: UNBOUND,
  changedConfiguration: { workspace: "/work/app" },
};
const saved = { revision: "sha256:saved", path: "/work/app/orca.config.yaml" };

function bridge(status: FirstRunStatus, revision = saved.revision, overrides: Partial<FirstRunBridge> = {}) {
  const firstRun = {
    status: vi.fn<FirstRunBridge["status"]>(async () => ({ ok: true, result: status })),
    choose: vi.fn<FirstRunBridge["choose"]>(),
    prepare: vi.fn<FirstRunBridge["prepare"]>(),
    connect: vi.fn<FirstRunBridge["connect"]>(),
    reviewConfiguration: vi.fn<NonNullable<FirstRunBridge["reviewConfiguration"]>>(async () => ({
      ok: true,
      result: { state: "configuration-review", review: { id: "review-1", revision, agentCount: 1, checks: [] } },
    })),
    cancelConfigurationReview: vi.fn<NonNullable<FirstRunBridge["cancelConfigurationReview"]>>(async () => ({
      ok: true,
      result: status,
    })),
    bindConfiguration: vi.fn<NonNullable<FirstRunBridge["bindConfiguration"]>>(async () => ({
      ok: true,
      result: { state: "prepared", project: "/work/project", workspace: "/work/app", sample: FIRST_RUN_SAMPLE },
    })),
  } satisfies FirstRunBridge;
  return Object.assign(firstRun, overrides);
}

describe("binding a saved configuration for reopening", () => {
  it("reviews and binds exactly the revision Config saved", async () => {
    const firstRun = bridge(changed);
    expect(await bindSavedConfigurationForReopening(firstRun, saved)).toEqual({ state: "bound" });
    expect(firstRun.bindConfiguration).toHaveBeenCalledWith("review-1");
  });

  it("binds nothing for another workspace's configuration, a bound workspace or no setup bridge", async () => {
    const other = bridge(changed);
    expect(
      await bindSavedConfigurationForReopening(other, { ...saved, path: "/elsewhere/orca.config.yaml" }),
    ).toBeUndefined();
    const prepared = bridge({ state: "prepared", project: "/p", workspace: "/work/app", sample: FIRST_RUN_SAMPLE });
    expect(await bindSavedConfigurationForReopening(prepared, saved)).toBeUndefined();
    const fresh = bridge({ state: "selection-required", reason: "Choose directories." });
    expect(await bindSavedConfigurationForReopening(fresh, saved)).toBeUndefined();
    expect(await bindSavedConfigurationForReopening(undefined, saved)).toBeUndefined();
    for (const b of [other, prepared, fresh]) {
      expect(b.reviewConfiguration).not.toHaveBeenCalled();
      expect(b.bindConfiguration).not.toHaveBeenCalled();
    }
  });

  it("refuses, and cancels the review, when the file changed again after the save", async () => {
    const firstRun = bridge(changed, "sha256:someone-else");
    expect(await bindSavedConfigurationForReopening(firstRun, saved)).toMatchObject({ state: "refused" });
    expect(firstRun.bindConfiguration).not.toHaveBeenCalled();
    expect(firstRun.cancelConfigurationReview).toHaveBeenCalledOnce();
  });

  it("reports an unanswered setup status as unknown rather than nothing to do", async () => {
    const firstRun = bridge(changed, saved.revision, {
      status: vi.fn(async () => ({ ok: false as const, error: { code: "UNAVAILABLE", message: "Setup is busy." } })),
    });
    expect(await bindSavedConfigurationForReopening(firstRun, saved)).toMatchObject({
      state: "refused",
      reason: expect.stringContaining("Setup is busy."),
    });
    expect(firstRun.bindConfiguration).not.toHaveBeenCalled();
  });

  it("passes main's refusal through", async () => {
    const firstRun = bridge(changed, saved.revision, {
      reviewConfiguration: vi.fn(async () => ({
        ok: false as const,
        error: { code: "FIRST_RUN_REFUSED", message: "The saved configuration is not the local first-run shape." },
      })),
    });
    expect(await bindSavedConfigurationForReopening(firstRun, saved)).toEqual({
      state: "refused",
      reason: "The saved configuration is not the local first-run shape.",
    });
  });

  it("matches the workspace's own file on either separator", () => {
    expect(isWorkspaceConfig("/work/app/orca.config.yaml", "/work/app")).toBe(true);
    expect(isWorkspaceConfig("C:\\work\\app\\orca.config.yaml", "C:\\work\\app")).toBe(true);
    expect(isWorkspaceConfig("/work/app/sub/orca.config.yaml", "/work/app")).toBe(false);
  });
});

describe("the first screen without a daemon", () => {
  afterEach(cleanup);

  it("says why the workspace did not reopen and opens Config instead of advising orca serve", async () => {
    const fake = fakeBridge();
    Object.assign(fake.bridge, { firstRun: bridge(changed) });
    const restore = fake.install();
    const onOpenConfig = vi.fn();
    try {
      render(<NoDaemonView title="No daemon to ask" onRetry={() => undefined} onOpenConfig={onOpenConfig} />);
      expect(await screen.findByText("Workspace did not reopen")).toBeTruthy();
      expect(screen.getByText(UNBOUND)).toBeTruthy();
      expect(screen.queryByText(/orca serve/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Open Config" }));
      expect(onOpenConfig).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it("keeps the command-line advice for a daemon named outside the app", () => {
    const fake = fakeBridge({ workspace: { path: "/srv/orca", readOnly: false, source: "env" } });
    Object.assign(fake.bridge, { firstRun: bridge(changed) });
    const restore = fake.install();
    try {
      render(<NoDaemonView title="No daemon to ask" onRetry={() => undefined} />);
      expect(screen.getByText("Start one with orca serve, then try again.")).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("names a next step in Config for every setup state", () => {
    expect(noDaemonReason({ state: "selection-required", reason: "x" })).toMatch(/Config/);
    expect(noDaemonReason(changed)).toBe(UNBOUND);
    expect(noDaemonReason({ state: "prepared", project: "/p", workspace: "/w", sample: FIRST_RUN_SAMPLE })).toMatch(
      /Connect selected local workspace/,
    );
    expect(noDaemonReason({ state: "recovery", recovery: { state: "ready", requestId: "r" } })).toMatch(/recovery/);
  });

  /* #1109 item 1: every surface's "no daemon" screen, not only Attention's, points a desktop
     user at Project setup. Only `NoDaemonView` keeps the command-line advice, for a daemon
     named outside the app. */
  it("leaves the orca serve advice to NoDaemonView alone", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const sources = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".tsx"));
    const advising = sources.filter((file) =>
      readFileSync(join(root, file), "utf8").includes("orca serve, then try again"),
    );
    expect(advising).toEqual([join("first-run", "no-daemon-view.tsx")]);
  });
});
