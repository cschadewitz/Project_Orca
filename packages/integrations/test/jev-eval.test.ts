/**
 * `custom:jev-eval` against a scripted provider: the three primitives, the artifact and its
 * provenance, every way a response can be wrong, provider failures, the bounded state, and the
 * downstream routing that reads the answers. No network anywhere.
 */
import { describe, expect, it } from "vitest";
import { parseFrontMatter } from "@orca/core";
import { JevHttpProvider, JevProviderError } from "@orca/integrations";
import {
  artifactsOfKind,
  endedAt,
  GOOD_ANSWERS,
  jevHarness,
  ROUTED,
  ScriptedJevProvider,
  stepFor,
} from "./jev-harness.js";

const ACCEPTANCE = "1. An export button on the settings page. 2. It works in Safari.";

describe("custom:jev-eval", () => {
  it("evaluates the three primitives, records a provenance-carrying artifact and routes on the answers", async () => {
    const provider = new ScriptedJevProvider({ body: GOOD_ANSWERS });
    const h = jevHarness(ROUTED, { provider });
    const state = await h.run("routed", { acceptance: ACCEPTANCE });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(state.run.outcome).toBe("success");
    expect(endedAt(state)).toBe("agree");

    // The request: only the named inputs, keyed by alias, plus the rendered context; the pinned model; the questions verbatim.
    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0]!;
    expect(req.model).toBe("jev-1.13.0");
    expect(Object.keys(req.questions).sort()).toEqual(["conflict", "coverage", "tested"]);
    expect(req.state).toEqual({
      artifacts: {
        implementation: "---\nstatus: done\n---\nAdded the export button.",
        report: "---\npassed: true\n---\nexport.test.ts covers it.",
      },
      context: { acceptance: ACCEPTANCE },
    });

    // The artifact: kind evaluation, parents = the judged inputs, front matter carrying the whole record.
    const [artifact, ...rest] = artifactsOfKind(state, "evaluation");
    expect(rest).toHaveLength(0);
    expect(artifact).toBeDefined();
    const impl = artifactsOfKind(state, "implementation")[0]!;
    const report = artifactsOfKind(state, "test-report")[0]!;
    expect(artifact!.name).toBe("jev");
    expect(artifact!.parents.sort()).toEqual([impl.id, report.id].sort());
    expect(artifact!.producedBy).toMatchObject({ runId: state.run.id, nodeId: "jev" });

    const content = await h.stores.artifacts.content(artifact!.id);
    const { data, body } = parseFrontMatter(content);
    expect(data).toMatchObject({
      status: "ok",
      rubric: { id: "test/shadow", version: 2 },
      model: { requested: "jev-1.13.0", resolved: "jev-1.13.0" },
      usage: { inputTokens: 512, outputTokens: 12 },
      missingInputs: ["review"],
      maxStateChars: 96_000,
      answers: {
        conflict: { type: "choice", choice: "none", confidence: 0.85 },
        coverage: { type: "score", score: 1.6, levels: 3, normalized: 0.8, confidence: 0.4 },
        tested: { type: "noul", noul: 0.93 },
      },
    });
    // The rubric travels with the answers, so a later reader knows what was asked, not just what came back.
    expect(data.questions).toEqual(req.questions);
    expect(data.inputs).toEqual([
      expect.objectContaining({
        alias: "implementation",
        artifactId: impl.id,
        contentHash: impl.contentHash,
        version: 1,
      }),
      expect.objectContaining({ alias: "report", artifactId: report.id, kind: "test-report", size: report.size }),
    ]);
    expect(data.stateChars).toBe(JSON.stringify(req.state).length);
    // The judged content is referenced, not copied: the artifact stays bounded.
    expect(body).not.toContain("Added the export button.");
    expect(body).toContain("| conflict | choice | `none` | 0.850 |");

    // Downstream: the same record on the step result, which the two decisions read.
    const jev = stepFor(state, "jev")!;
    expect(jev.result?.artifactIds).toEqual([artifact!.id]);
    expect(jev.result?.data).toMatchObject({ artifactId: artifact!.id, status: "ok" });
    expect(stepFor(state, "conflict")!.result?.choice).toBe("none");
    expect(stepFor(state, "tested")!.result?.choice).toBe("yes");
  });

  it("a different answer takes a different route; the model never picks the edge", async () => {
    const body = structuredClone(GOOD_ANSWERS);
    body.answers.conflict = {
      type: "choice",
      choice: "major",
      probabilities: { none: 0.1, minor: 0.2, major: 0.7 },
      confidence: 0.55,
    };
    const state = await jevHarness(ROUTED, { provider: new ScriptedJevProvider({ body }) }).run("routed", {
      acceptance: ACCEPTANCE,
    });
    expect(state.run.status).toBe("completed");
    expect(state.run.outcome).toBe("failure");
    expect(endedAt(state)).toBe("disagree");
  });

  it("routes on a nested answer through the artifact itself: a dotted `field` on `source: artifact` (#309)", async () => {
    // The decision names the evaluation artifact and a path into its data, not the node that
    // produced it, so it survives the node being renamed or the artifact coming from elsewhere.
    const yaml = ROUTED.replace(
      'source: { kind: expression, expr: "steps.jev.result.data.answers.conflict.choice" }',
      "source: { kind: artifact, artifact: jev, field: answers.conflict.choice }",
    );
    const h = jevHarness(yaml, { provider: new ScriptedJevProvider({ body: GOOD_ANSWERS }) });
    const state = await h.run("routed", { acceptance: ACCEPTANCE });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(endedAt(state)).toBe("agree");
    expect(stepFor(state, "conflict")!.result?.choice).toBe("none");
    const resolved = (await h.stores.events.read(state.run.id)).filter((e) => e.type === "decision.resolved");
    expect(resolved[0]?.payload).toMatchObject({ choice: "none", source: "artifact:jev.answers.conflict.choice" });

    // A path that reaches nothing is an unanswered decision, which a defaultOption catches and nothing else does.
    const missing = yaml.replace("field: answers.conflict.choice", "field: answers.nothing.choice");
    let failed = await jevHarness(missing, { provider: new ScriptedJevProvider({ body: GOOD_ANSWERS }) }).run(
      "routed",
      { acceptance: ACCEPTANCE },
    );
    expect(failed.run.status).toBe("failed");
    expect(failed.run.error?.message).toMatch(/decision 'conflict' produced 'undefined'/);
    failed = await jevHarness(
      missing.replace("options: [none, minor, major]", "options: [none, minor, major]\n    defaultOption: major"),
      {
        provider: new ScriptedJevProvider({ body: GOOD_ANSWERS }),
      },
    ).run("routed", { acceptance: ACCEPTANCE });
    expect(failed.run.status).toBe("completed");
    expect(endedAt(failed)).toBe("disagree");
  });

  it("rejects a response whose answers are not the questions asked, and records nothing", async () => {
    const body = structuredClone(GOOD_ANSWERS) as { answers: Record<string, unknown> };
    delete body.answers.tested;
    body.answers.extra = { type: "noul", noul: 0.5 };
    const state = await jevHarness(ROUTED, { provider: new ScriptedJevProvider({ body }) }).run("routed", {
      acceptance: ACCEPTANCE,
    });
    expect(state.run.status).toBe("failed");
    expect(state.run.error).toMatchObject({ code: "JEV_RESPONSE_INVALID" });
    expect(state.run.error?.details?.problems).toEqual([
      "answers.tested: missing",
      "answers.extra: not a question that was asked",
    ]);
    expect(artifactsOfKind(state, "evaluation")).toHaveLength(0);
    expect(stepFor(state, "jev")?.attempt).toBe(1); // not retryable
  });

  it("refuses a choice outside the options even when maxAttempts would allow a retry", async () => {
    const body = structuredClone(GOOD_ANSWERS);
    body.answers.conflict.choice = "unsure";
    const yaml = ROUTED.replace("model: jev-1.13.0", "model: jev-1.13.0\n    maxAttempts: 3");
    const provider = new ScriptedJevProvider({ body }, { body: GOOD_ANSWERS });
    const state = await jevHarness(yaml, { provider }).run("routed", { acceptance: ACCEPTANCE });
    expect(state.run.status).toBe("failed");
    expect(state.run.error?.message).toMatch(/choice 'unsure' is not one of \[none, minor, major\]/);
    expect(provider.requests).toHaveLength(1);
  });

  it("fails on a model other than the one pinned", async () => {
    const body = { ...structuredClone(GOOD_ANSWERS), model: "jev-1.14.0" };
    const state = await jevHarness(ROUTED, { provider: new ScriptedJevProvider({ body }) }).run("routed", {
      acceptance: ACCEPTANCE,
    });
    expect(state.run.status).toBe("failed");
    expect(state.run.error).toMatchObject({
      code: "JEV_MODEL_MISMATCH",
      details: { requested: "jev-1.13.0", resolved: "jev-1.14.0" },
    });
  });

  it("retries a retryable provider failure within maxAttempts and gives up on a non-retryable one", async () => {
    const yaml = ROUTED.replace("model: jev-1.13.0", "model: jev-1.13.0\n    maxAttempts: 2");
    const flaky = new ScriptedJevProvider(
      { throws: new JevProviderError("HTTP 429", true, 429) },
      { body: GOOD_ANSWERS },
    );
    const ok = await jevHarness(yaml, { provider: flaky }).run("routed", { acceptance: ACCEPTANCE });
    expect(ok.run.status).toBe("completed");
    expect(flaky.requests).toHaveLength(2);
    expect(stepFor(ok, "jev")?.attempt).toBe(2);

    const denied = new ScriptedJevProvider(
      { throws: new JevProviderError("HTTP 401: Missing or invalid API key", false, 401) },
      { body: GOOD_ANSWERS },
    );
    const bad = await jevHarness(yaml, { provider: denied }).run("routed", { acceptance: ACCEPTANCE });
    expect(bad.run.status).toBe("failed");
    expect(bad.run.error).toMatchObject({ code: "JEV_PROVIDER", details: { status: 401 } });
    expect(denied.requests).toHaveLength(1);
  });

  it("fails before calling the provider when the state is over the node's bound", async () => {
    const provider = new ScriptedJevProvider({ body: GOOD_ANSWERS });
    const yaml = ROUTED.replace("model: jev-1.13.0", "model: jev-1.13.0\n    maxStateChars: 40");
    const state = await jevHarness(yaml, { provider }).run("routed", { acceptance: ACCEPTANCE });
    expect(state.run.status).toBe("failed");
    expect(state.run.error).toMatchObject({ code: "JEV_STATE_TOO_LARGE", details: { maxStateChars: 40 } });
    expect(provider.requests).toHaveLength(0);
  });

  it("fails a run whose required input is missing, with the engine's own code", async () => {
    const yaml = ROUTED.replace("{ kind: review, required: false }", "{ kind: review }");
    const provider = new ScriptedJevProvider({ body: GOOD_ANSWERS });
    const state = await jevHarness(yaml, { provider }).run("routed", { acceptance: ACCEPTANCE });
    expect(state.run.status).toBe("failed");
    expect(state.run.error?.code).toBe("ARTIFACT_MISSING");
    expect(provider.requests).toHaveLength(0);
  });

  it("is WORKFLOW_INVALID for a malformed node or a model alias, without retrying", async () => {
    const provider = new ScriptedJevProvider({ body: GOOD_ANSWERS });
    const noRubric = ROUTED.replace("    rubric: { id: test/shadow, version: 2 }\n", "");
    let state = await jevHarness(noRubric, { provider }).run("routed", { acceptance: ACCEPTANCE });
    expect(state.run.error).toMatchObject({ code: "WORKFLOW_INVALID" });
    expect(state.run.error?.message).toMatch(/rubric/);

    const alias = ROUTED.replace("model: jev-1.13.0", "model: jev-latest\n    maxAttempts: 3");
    state = await jevHarness(alias, { provider }).run("routed", { acceptance: ACCEPTANCE });
    expect(state.run.error).toMatchObject({ code: "WORKFLOW_INVALID" });
    expect(state.run.error?.message).toMatch(/alias; pin a version/);
    expect(stepFor(state, "jev")?.attempt).toBe(1);

    const badOption = ROUTED.replace('none: "The two agree', 'no way: "The two agree');
    state = await jevHarness(badOption, { provider }).run("routed", { acceptance: ACCEPTANCE });
    expect(state.run.error).toMatchObject({ code: "WORKFLOW_INVALID" });
    expect(provider.requests).toHaveLength(0);
  });

  it("is JEV_NOT_CONFIGURED without a key or a model, and the plugin's model is the fallback", async () => {
    const unpinned = ROUTED.replace("    model: jev-1.13.0\n", "");
    let state = await jevHarness(unpinned, { env: {} }).run("routed", { acceptance: ACCEPTANCE });
    expect(state.run.error).toMatchObject({ code: "JEV_NOT_CONFIGURED" });
    expect(state.run.error?.message).toMatch(/no model/);

    state = await jevHarness(unpinned, { env: { ORCA_JEV_MODEL: "jev-1.13.0" } }).run("routed", {
      acceptance: ACCEPTANCE,
    });
    expect(state.run.error).toMatchObject({ code: "JEV_NOT_CONFIGURED" });
    expect(state.run.error?.message).toMatch(/TYPESAFE_API_KEY/);

    const provider = new ScriptedJevProvider({ body: GOOD_ANSWERS });
    state = await jevHarness(unpinned, { provider, model: "jev-1.13.0" }).run("routed", { acceptance: ACCEPTANCE });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(provider.requests[0]?.model).toBe("jev-1.13.0");
  });

  it("onError: record keeps the run going with an artifact that says the question went unanswered", async () => {
    const yaml = ROUTED.replace("model: jev-1.13.0", "model: jev-1.13.0\n    onError: record").replace(
      "options: [none, minor, major]",
      "options: [none, minor, major, unknown]\n    defaultOption: unknown",
    );
    const provider = new ScriptedJevProvider({ throws: new JevProviderError("HTTP 529: overloaded", true, 529) });
    const h = jevHarness(yaml, { provider });
    const state = await h.run("routed", { acceptance: ACCEPTANCE });
    // The step completed, the decision fell to its default, the run took the "disagree" route - never an approval.
    expect(state.run.status).toBe("completed");
    expect(endedAt(state)).toBe("disagree");
    expect(stepFor(state, "conflict")!.result?.choice).toBe("unknown");
    const jev = stepFor(state, "jev")!;
    expect(jev.status).toBe("completed");
    expect(jev.result?.data).toMatchObject({
      status: "failed",
      error: { code: "JEV_PROVIDER", details: { status: 529 } },
    });
    expect(jev.result?.data).not.toHaveProperty("answers");
    const [artifact] = artifactsOfKind(state, "evaluation");
    const { data, body } = parseFrontMatter(await h.stores.artifacts.content(artifact!.id));
    expect(data).toMatchObject({ status: "failed", error: { code: "JEV_PROVIDER" } });
    expect(body).toContain("No answers were recorded");
  });

  it("keeps the credential out of the artifact, the result and the error", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: url instanceof Request ? url.url : String(url), init: init! });
      return new Response(JSON.stringify(GOOD_ANSWERS), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const h = jevHarness(ROUTED, {
      provider: new JevHttpProvider({ apiKey: "sk-live-SECRET", baseUrl: "https://jev.test/", fetch: fetchImpl }),
    });
    const state = await h.run("routed", { acceptance: ACCEPTANCE });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(seen[0]!.url).toBe("https://jev.test/v1/systemone");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-live-SECRET");

    const everything =
      JSON.stringify(state) + (await h.stores.artifacts.content(artifactsOfKind(state, "evaluation")[0]!.id));
    expect(everything).not.toContain("SECRET");
  });
});
