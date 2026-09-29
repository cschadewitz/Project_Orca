/**
 * `custom:jev-eval` against a scripted provider: the three primitives, the artifact and its
 * provenance, every way a response can be wrong, provider failures, the bounded state, and the
 * downstream routing that reads the answers. No network anywhere.
 */
import { describe, expect, it } from "vitest";
import { parseFrontMatter, parseWorkflow, validateWorkflow } from "@orca/core";
import { NodeExecutorRegistry } from "@orca/engine";
import {
  JevHttpProvider,
  JevProviderError,
  jevEvalExecutor,
  validateJevResponse,
  type JevQuestion,
} from "@orca/integrations";
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

  it("checks a node's fields when the workflow is validated, before any agent has run (#308)", () => {
    const executors = new NodeExecutorRegistry().register(jevEvalExecutor({ provider: new ScriptedJevProvider() }));
    const check = (yaml: string) =>
      validateWorkflow(parseWorkflow(yaml), { validateCustomNode: (n) => executors.validateNode(n) });

    const good = check(ROUTED);
    expect(good.errors).toEqual([]);
    // The harness's seed node is registered by the test plugin, not here: the validator says so and moves on.
    expect(good.warnings.map((w) => w.path)).toEqual(["workflow(routed).nodes.impl", "workflow(routed).nodes.tests"]);
    expect(good.warnings[0]?.message).toMatch(/no executor is registered for 'custom:seed'/);

    const noRubric = check(ROUTED.replace("    rubric: { id: test/shadow, version: 2 }\n", ""));
    expect(noRubric.ok).toBe(false);
    expect(noRubric.errors).toEqual([{ path: "workflow(routed).nodes.jev.rubric", message: expect.any(String) }]);

    const alias = check(ROUTED.replace("model: jev-1.13.0", "model: jev-latest"));
    expect(alias.errors).toEqual([
      {
        path: "workflow(routed).nodes.jev.model",
        message: "model 'jev-latest' is an alias; pin a version such as jev-1.13.0",
      },
    ]);

    const badOption = check(ROUTED.replace('none: "The two agree', 'no way: "The two agree'));
    expect(badOption.ok).toBe(false);
    expect(badOption.errors[0]?.path).toMatch(/^workflow\(routed\)\.nodes\.jev\.questions\.conflict\.criteria/);
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
      seen.push({ url: String(url), init: init! });
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

describe("JevHttpProvider", () => {
  const request = { state: "x", model: "jev-1.13.0", questions: { q: { type: "noul" as const, instructions: "?" } } };
  const provider = (status: number, body: string, contentType = "application/json") =>
    new JevHttpProvider({
      apiKey: "k",
      fetch: async () => new Response(body, { status, headers: { "content-type": contentType } }),
    });
  const signal = new AbortController().signal;

  it("posts the request as JSON to the default endpoint", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const p = new JevHttpProvider({
      apiKey: "k",
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init! };
        return new Response('{"answers":{}}', { status: 200 });
      },
    });
    await expect(p.evaluate(request, { signal })).resolves.toEqual({ answers: {} });
    expect(captured!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(captured!.init.method).toBe("POST");
    expect(JSON.parse(captured!.init.body as string)).toEqual(request);
  });

  it.each([
    [429, true],
    [529, true],
    [500, true],
    [503, true],
    [401, false],
    [422, false],
  ])("maps HTTP %s to retryable=%s", async (status, retryable) => {
    const err = await provider(status, `{"error":"status ${status}"}`)
      .evaluate(request, { signal })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevProviderError);
    expect(err).toMatchObject({ retryable, status, message: `HTTP ${status}: {"error":"status ${status}"}` });
  });

  it("treats a network failure as retryable and a non-JSON body as not", async () => {
    const down = new JevHttpProvider({
      apiKey: "k",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(down.evaluate(request, { signal })).rejects.toMatchObject({
      retryable: true,
      message: /fetch failed/,
    });
    await expect(provider(200, "<html>", "text/html").evaluate(request, { signal })).rejects.toMatchObject({
      retryable: false,
      message: /not JSON/,
    });
  });

  it("lets the caller's abort through untouched", async () => {
    const ac = new AbortController();
    const p = new JevHttpProvider({
      apiKey: "k",
      fetch: async (_url: unknown, init?: RequestInit) => {
        ac.abort(new Error("run cancelled"));
        init!.signal!.throwIfAborted();
        return new Response("{}");
      },
    });
    await expect(p.evaluate(request, { signal: ac.signal })).rejects.toThrow("run cancelled");
  });
});

describe("validateJevResponse", () => {
  const questions: Record<string, JevQuestion> = {
    pick: { type: "choice", instructions: "?", criteria: { a: "A", b: "B" } },
    rate: { type: "score", instructions: "?", criteria: ["low", "mid", "high"] },
    yes: { type: "noul", instructions: "?" },
  };
  const good = {
    model: "jev-1.13.0",
    answers: {
      pick: { type: "choice", choice: "a", probabilities: { a: 0.7, b: 0.3 }, confidence: 0.4 },
      rate: { type: "score", score: 2, probabilities: { "0": 0, "1": 0, "2": 1 }, confidence: 1 },
      yes: { type: "noul", noul: 0.5 },
    },
    usage: { input_tokens: 10, output_tokens: 1 },
  };
  const withAnswer = (id: string, patch: Record<string, unknown>) => {
    const raw = structuredClone(good) as { answers: Record<string, Record<string, unknown>> };
    raw.answers[id] = { ...raw.answers[id], ...patch };
    return raw;
  };
  const problemsOf = (raw: unknown) => {
    const v = validateJevResponse(questions, raw);
    return v.ok ? [] : v.problems;
  };

  it("accepts a well-formed response and derives the score's normalized position", () => {
    const v = validateJevResponse(questions, good);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.response.model).toBe("jev-1.13.0");
    expect(v.response.usage).toEqual({ inputTokens: 10, outputTokens: 1 });
    expect(v.response.answers.rate).toMatchObject({ levels: 3, normalized: 1 });
    expect(v.response.answers.rate).not.toHaveProperty("legend");
  });

  it("tolerates a distribution that rounds to 1 but not one that does not", () => {
    expect(problemsOf(withAnswer("pick", { probabilities: { a: 0.69, b: 0.3 } }))).toEqual([]);
    expect(problemsOf(withAnswer("pick", { probabilities: { a: 0.5, b: 0.3 } }))).toEqual([
      "answers.pick: probabilities sum to 0.800, expected 1",
    ]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a choice not offered", { choice: "c" }, "answers.pick: choice 'c' is not one of [a, b]"],
    [
      "a distribution over other options",
      { probabilities: { a: 1, c: 0 } },
      "answers.pick: probabilities cover [a, c], expected [a, b]",
    ],
    [
      "a probability out of range",
      { probabilities: { a: 1.2, b: -0.2 } },
      "answers.pick: probability for 'a' is not a number in [0, 1]",
    ],
    ["a confidence out of range", { confidence: 1.5 }, "answers.pick: confidence is not a number in [0, 1]"],
    ["a wrong answer type", { type: "noul" }, "answers.pick: type is 'noul', asked for 'choice'"],
  ])("rejects %s", (_name, patch, problem) => {
    expect(problemsOf(withAnswer("pick", patch))).toEqual([problem]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a score above the top level", { score: 2.5 }, "answers.rate: score '2.5' is not a number in [0, 2]"],
    ["a negative score", { score: -1 }, "answers.rate: score '-1' is not a number in [0, 2]"],
    ["a non-numeric score", { score: "high" }, "answers.rate: score 'high' is not a number in [0, 2]"],
    [
      "levels that are not the rubric's",
      { probabilities: { "0": 1, "1": 0 } },
      "answers.rate: probabilities cover [0, 1], expected [0, 1, 2]",
    ],
    ["a missing confidence", { confidence: undefined }, "answers.rate: confidence is not a number in [0, 1]"],
  ])("rejects %s", (_name, patch, problem) => {
    expect(problemsOf(withAnswer("rate", patch))).toEqual([problem]);
  });

  it("rejects a noul outside [0, 1] or of the wrong type", () => {
    expect(problemsOf(withAnswer("yes", { noul: 1.01 }))).toEqual(["answers.yes: noul is not a number in [0, 1]"]);
    expect(problemsOf(withAnswer("yes", { noul: "0.5" }))).toEqual(["answers.yes: noul is not a number in [0, 1]"]);
    expect(problemsOf({ ...good, answers: { ...good.answers, yes: "yes" } })).toEqual([
      "answers.yes: must be an object",
    ]);
  });

  it("rejects a body that is not a response at all, and malformed usage or model", () => {
    expect(problemsOf(null)).toEqual(["response is not an object"]);
    expect(problemsOf("ok")).toEqual(["response is not an object"]);
    expect(problemsOf({ model: "x" })).toEqual(["response has no 'answers' object"]);
    expect(problemsOf({ ...good, usage: { input_tokens: "10" } })).toEqual(["usage is malformed"]);
    expect(problemsOf({ ...good, model: 13 })).toEqual(["model is not a string"]);
    const v = validateJevResponse(questions, { answers: good.answers });
    expect(v.ok && v.response.model === undefined && v.response.usage === undefined).toBe(true);
  });

  it("reports every problem, not just the first", () => {
    const raw = { answers: { pick: { choice: "z" }, extra: {} } };
    expect(problemsOf(raw)).toEqual([
      "answers.rate: missing",
      "answers.yes: missing",
      "answers.extra: not a question that was asked",
      "answers.pick: choice 'z' is not one of [a, b]",
    ]);
  });
});
