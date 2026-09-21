/**
 * The route table: the URLs docs/design/10-information-architecture.md lists, the two
 * corrections this unit makes to that list, and the round trip that keeps **Copy link**
 * honest — every URL the app emits must resolve to the object it was emitted for.
 */
import { describe, expect, it } from "vitest";
import {
  agentUrl,
  artifactUrl,
  configUrl,
  counterpartUrl,
  describeRoute,
  resolveRoute,
  runUrl,
  stepUrl,
  urlForCrumb,
  workflowUrl,
} from "../src/route-table.js";
import type { Crumb } from "../src/ui/index.js";

describe("resolveRoute", () => {
  it("resolves the table the information architecture lists", () => {
    expect(resolveRoute("orca://run/7f3a2c")).toEqual({ kind: "run", surface: "runs", runId: "7f3a2c" });
    expect(resolveRoute("orca://run/7f3a2c/step/build.2")).toEqual({
      kind: "run",
      surface: "runs",
      runId: "7f3a2c",
      step: { nodeId: "build", attempt: 2 },
    });
    expect(resolveRoute("orca://gate/91c4")).toEqual({ kind: "gate", surface: "attention", inputId: "91c4" });
  });

  it("lands an item and a workflow on the surfaces that do not exist yet, rather than dropping them", () => {
    // Plan is v0.5.0 and the workflow viewer v0.6.0; both select their surface and land on
    // its unbuilt state with the id in hand, which is the honest answer.
    expect(resolveRoute("orca://item/auth-sso-epic")).toEqual({
      kind: "item",
      surface: "plan",
      itemId: "auth-sso-epic",
    });
    expect(resolveRoute("orca://workflow/ai-sdlc?run=7f3a2c")).toEqual({
      kind: "workflow",
      surface: "config",
      workflowId: "ai-sdlc",
      runId: "7f3a2c",
    });
  });

  it("carries the run an artifact belongs to, because a version alone names nothing", () => {
    // Versions are monotonic per (run, name): `spec.md@v3` on its own names as many
    // artifacts as there are runs that produced one.
    expect(resolveRoute("orca://artifact/spec.md@v3?run=7f3a2c")).toEqual({
      kind: "artifact",
      surface: "runs",
      name: "spec.md",
      version: 3,
      runId: "7f3a2c",
    });
    // The bare form still resolves — it is what a palette search offers — but names no run.
    expect(resolveRoute("orca://artifact/spec.md")).toEqual({ kind: "artifact", surface: "runs", name: "spec.md" });
  });

  it("keeps a node id that has dots of its own, and only reads a trailing integer as an attempt", () => {
    expect(resolveRoute("orca://run/r1/step/deploy.eu-west")).toMatchObject({ step: { nodeId: "deploy.eu-west" } });
    expect(resolveRoute("orca://run/r1/step/deploy.eu-west.2")).toMatchObject({
      step: { nodeId: "deploy.eu-west", attempt: 2 },
    });
    // No attempt named at all is "whichever is current", not attempt zero.
    expect(resolveRoute("orca://run/r1/step/build")).toMatchObject({ step: { nodeId: "build" } });
  });

  it("resolves an agent, which the surface shipped before the URL table caught up", () => {
    expect(resolveRoute("orca://agent/claude-local")).toEqual({
      kind: "agent",
      surface: "agents",
      agentId: "claude-local",
    });
  });

  it("resolves the Config surface's two documents, the YAML being the bare URL", () => {
    // "The configuration" means the YAML to everybody not thinking about ADR 0009; the
    // sidecar is a different object and names itself (#175, #266).
    expect(resolveRoute("orca://config")).toEqual({ kind: "config", surface: "config", document: "config" });
    expect(resolveRoute("orca://config/permissions")).toEqual({
      kind: "config",
      surface: "config",
      document: "permissions",
    });
    // Not a document: somebody expecting a link into the file, which this app does not have.
    expect(resolveRoute("orca://config/agents")).toBeUndefined();
  });

  it("answers nothing for a URL it does not know, rather than guessing a surface", () => {
    expect(resolveRoute("https://example.test/run/7f3a2c")).toBeUndefined();
    expect(resolveRoute("orca://nonsense/1")).toBeUndefined();
    expect(resolveRoute("orca://run")).toBeUndefined();
    expect(resolveRoute("not a url at all")).toBeUndefined();
  });

  it("round-trips every URL the app emits", () => {
    expect(resolveRoute(runUrl("run_1"))).toMatchObject({ runId: "run_1" });
    expect(resolveRoute(stepUrl("run_1", "build", 2))).toMatchObject({ step: { nodeId: "build", attempt: 2 } });
    expect(resolveRoute(stepUrl("run_1", "build"))).toMatchObject({ step: { nodeId: "build" } });
    expect(resolveRoute(artifactUrl("run_1", "spec.md", 3))).toMatchObject({
      name: "spec.md",
      version: 3,
      runId: "run_1",
    });
    expect(resolveRoute(artifactUrl("run_1", "spec.md"))).toMatchObject({ name: "spec.md", runId: "run_1" });
    expect(resolveRoute(workflowUrl("ai-sdlc"))).toMatchObject({ workflowId: "ai-sdlc" });
    expect(resolveRoute(agentUrl("claude-local"))).toMatchObject({ agentId: "claude-local" });
    expect(resolveRoute(configUrl())).toMatchObject({ document: "config" });
    expect(resolveRoute(configUrl("permissions"))).toMatchObject({ document: "permissions" });
  });

  it("survives an id with a slash or a space in it", () => {
    const url = artifactUrl("run_1", "docs/plan v2.md", 1);
    expect(resolveRoute(url)).toMatchObject({ name: "docs/plan v2.md", version: 1, runId: "run_1" });
  });
});

describe("urlForCrumb", () => {
  const crumbs: readonly Crumb[] = [
    { type: "item", id: "wi-1", label: "Add the SSO callback" },
    { type: "run", id: "run-1", label: "SSO rollout" },
    { type: "step", id: "s-build-1", label: "build", current: true },
  ];

  it("addresses a step by node within its run, never by the opaque step run id", () => {
    expect(urlForCrumb(crumbs, crumbs[2]!)).toBe("orca://run/run-1/step/build");
    expect(urlForCrumb(crumbs, crumbs[1]!)).toBe("orca://run/run-1");
    expect(urlForCrumb(crumbs, crumbs[0]!)).toBe("orca://item/wi-1");
  });

  it("addresses a config crumb by its document, which is what the Config surface shows", () => {
    /* The crumb's id is an absolute path and would differ between two checkouts of one
       repo, so the URL names the *document* instead — and the label is what says which. */
    expect(urlForCrumb(crumbs, { type: "config", id: "/w/orca.config.yaml", label: "orca.config.yaml" })).toBe(
      "orca://config",
    );
    expect(
      urlForCrumb(crumbs, { type: "config", id: "/w/orca.permissions.json", label: "orca.permissions.json" }),
    ).toBe("orca://config/permissions");
  });

  it("answers nothing for a crumb type with no canonical form yet", () => {
    expect(urlForCrumb(crumbs, { type: "request", id: "req-1", label: "req-1" })).toBeUndefined();
    // A step with no run above it in the trail cannot be addressed at all.
    expect(urlForCrumb([], { type: "step", id: "s-1", label: "build" })).toBeUndefined();
  });
});

describe("counterpartUrl", () => {
  const crumbs: readonly Crumb[] = [
    { type: "item", id: "wi-1", label: "Add the SSO callback" },
    { type: "run", id: "run-1", label: "SSO rollout", current: true },
  ];

  it("follows a run to the work item it claims, which is the crumb above it", () => {
    expect(counterpartUrl(crumbs, crumbs[1]!, { id: "claimed-item" })).toBe("orca://item/wi-1");
  });

  it("answers nothing for the three that are queries the header cannot make", () => {
    expect(counterpartUrl(crumbs, crumbs[1]!, { id: "workflow" })).toBeUndefined();
    expect(counterpartUrl(crumbs, crumbs[0]!, { id: "runs" })).toBeUndefined();
    expect(counterpartUrl(crumbs, crumbs[0]!, { id: "dependencies" })).toBeUndefined();
    // And nothing when the trail has no work item to go to.
    expect(counterpartUrl([crumbs[1]!], crumbs[1]!, { id: "claimed-item" })).toBeUndefined();
  });
});

describe("describeRoute", () => {
  it("names the object a landing is holding, for every kind of route", () => {
    expect(describeRoute(resolveRoute("orca://run/r1")!)).toEqual({ type: "run", id: "r1" });
    expect(describeRoute(resolveRoute("orca://run/r1/step/build.2")!)).toEqual({ type: "step", id: "build.2" });
    expect(describeRoute(resolveRoute("orca://run/r1/step/build")!)).toEqual({ type: "step", id: "build" });
    expect(describeRoute(resolveRoute("orca://gate/g1")!)).toEqual({ type: "gate", id: "g1" });
    expect(describeRoute(resolveRoute("orca://item/wi-1")!)).toEqual({ type: "work item", id: "wi-1" });
    expect(describeRoute(resolveRoute("orca://artifact/spec.md@v2?run=r1")!)).toEqual({
      type: "artifact",
      id: "spec.md@v2",
    });
    expect(describeRoute(resolveRoute("orca://artifact/spec.md")!)).toEqual({ type: "artifact", id: "spec.md" });
    expect(describeRoute(resolveRoute("orca://workflow/ai-sdlc")!)).toEqual({ type: "workflow", id: "ai-sdlc" });
    expect(describeRoute(resolveRoute("orca://agent/a1")!)).toEqual({ type: "agent", id: "a1" });
    expect(describeRoute(resolveRoute("orca://config")!)).toEqual({ type: "document", id: "orca.config.yaml" });
    expect(describeRoute(resolveRoute("orca://config/permissions")!)).toEqual({
      type: "document",
      id: "orca.permissions.json",
    });
  });
});
