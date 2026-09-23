/**
 * Opt-in live smoke: one real System One call from a real run, with the credentials in the
 * environment. Skipped unless both `TYPESAFE_API_KEY` and `ORCA_JEV_LIVE=1` are set, so the
 * suite never touches the network by accident. See docs/INTEGRATIONS.md, "Live smoke".
 */
import { describe, expect, it } from "vitest";
import { parseFrontMatter } from "@orca/core";
import { artifactsOfKind, endedAt, jevHarness, ROUTED, stepFor } from "./jev-harness.js";

const live = process.env.ORCA_JEV_LIVE === "1" && !!process.env.TYPESAFE_API_KEY;

describe.skipIf(!live)("custom:jev-eval against the TypeSafe API (live)", () => {
  it("records an evaluation artifact from a real answer", async () => {
    const model = process.env.ORCA_JEV_MODEL ?? "jev-1.13.0";
    const h = jevHarness(ROUTED.replace("model: jev-1.13.0", `model: ${model}`), {});
    const state = await h.run("routed", {
      acceptance: "1. An export button on the settings page. 2. It works in Safari.",
    });
    // Whatever the model answered, the run must have finished through one of the workflow's own ends.
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(["agree", "disagree", "untested"]).toContain(endedAt(state));

    const [artifact] = artifactsOfKind(state, "evaluation");
    expect(artifact).toBeDefined();
    const { data } = parseFrontMatter(await h.stores.artifacts.content(artifact!.id));
    expect(data).toMatchObject({ status: "ok", model: { requested: model, resolved: model } });
    expect(data.usage).toMatchObject({ inputTokens: expect.any(Number) });
    const answers = data.answers as Record<string, Record<string, unknown>>;
    expect(answers.conflict).toMatchObject({ type: "choice", choice: expect.stringMatching(/^(none|minor|major)$/) });
    expect(answers.coverage).toMatchObject({ type: "score", levels: 3 });
    expect(answers.tested).toMatchObject({ type: "noul", noul: expect.any(Number) });
    expect(stepFor(state, "jev")?.result?.data).toMatchObject({ status: "ok", artifactId: artifact!.id });
    // eslint-disable-next-line no-console
    console.log("live JEV answers", JSON.stringify(answers, null, 2));
  });
});
