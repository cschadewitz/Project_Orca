/** JEV response and workflow-field validation plus HTTP provider contracts with injected fetch. */
import { describe, expect, it } from "vitest";
import { parseWorkflow, validateWorkflow } from "@orca/core";
import { NodeExecutorRegistry } from "@orca/engine";
import {
  JevHttpProvider,
  JevProviderError,
  jevEvalExecutor,
  validateJevResponse,
  type JevQuestion,
} from "@orca/integrations";
import { ROUTED, ScriptedJevProvider } from "./jev-harness.js";

describe("custom:jev-eval", () => {
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
        captured = { url: url instanceof Request ? url.url : String(url), init: init! };
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
