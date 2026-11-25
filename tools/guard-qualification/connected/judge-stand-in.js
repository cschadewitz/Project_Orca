/**
 * A local stand-in for the provider behind ORCA's plain-rule judge (#701), for the installed
 * Claude run's judged action (#1026). It answers each judge request in the Anthropic Messages
 * format with a verdict for every rule it was shown, `covered` or `not-covered` as the run sets,
 * and records what each request was about (its class and rule ids), never its criterion text.
 *
 * `prepare` builds the judge ORCA's own way (`preparePlainRuleJudge`), with the key in an env
 * variable read through ORCA's secret lease, a disclosure grant and an in-memory budget. The
 * daemon's own key, grant and budget plumbing is not run here; its tests cover it.
 * No account, key or provider spend is involved.
 */
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { preparePlainRuleJudge, secretJudgeCredentials } from "@orca/agents/review-judge";
import { memoryJudgeBudget } from "@orca/agents/judge-budget";

/** The reply schema ORCA's judge accepts (`PLAIN_RULE_VERDICT_SCHEMA`). */
const VERDICT_SCHEMA = "orca-plain-rule-verdict/v1"; // rename-keep: the judge's wire format keeps its pre-rename name

export async function judgeStandIn() {
  const state = { verdict: "covered", requests: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d.toString()));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const frame = JSON.parse(parsed.messages?.find((m) => m.role === "user")?.content ?? "{}");
      const rules = frame.rules ?? [];
      state.requests.push({ kind: frame.action?.kind ?? null, rules: rules.map((r) => r.id) });
      const text = JSON.stringify({
        schema: VERDICT_SCHEMA,
        requestId: frame.requestId,
        verdicts: rules.map((r) => ({
          ruleId: r.id,
          ruleRevision: r.revision,
          verdict: state.verdict,
          reasonCode: state.verdict === "covered" ? "matches-criterion" : "outside-criterion",
        })),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_orca_706",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const destination = `https://127.0.0.1:${server.address().port}/v1/messages`;
  const keyEnv = `ORCA_706_JUDGE_KEY_${randomUUID().replace(/-/g, "")}`;
  process.env[keyEnv] = `sk-orca-706-judge-${randomUUID()}`;
  const grant = { revision: "g1", expiresAt: "2999-01-01T00:00:00Z" };

  return {
    state,
    /** The judge for one session of `agentId`, for the classes asked, as the daemon hands it over. */
    async prepare(agentId, classes) {
      const services = {
        credentials: secretJudgeCredentials({
          secrets: () => ({ "judge-key": { host: "local", provider: "env", name: keyEnv, destination } }),
          host: { id: "local", spec: { type: "local" } },
          authorize: async () => undefined,
          authorizedNow: () => true,
          agentId,
        }),
        disclosure: {
          find: async (query) => ({ ...query, grantRef: "grant-orca-706", ...grant }),
          current: async () => grant,
          currentNow: () => grant,
        },
        budget: memoryJudgeBudget(),
        // The stand-in speaks plain HTTP on loopback; ORCA's sender is handed this request function.
        request: (options) => httpRequest(options),
      };
      const config = { provider: { kind: "anthropic" }, destination, credential: "judge-key" };
      const signal = new AbortController().signal;
      const read = await preparePlainRuleJudge(config, services, signal);
      if (read.status !== "prepared") throw new Error(`the judge was not prepared: ${read.reason}`);
      const judgeKinds = {};
      for (const kind of classes) {
        const one = await preparePlainRuleJudge(config, services, signal, kind);
        if (one.status !== "prepared") throw new Error(`the ${kind} judge was not prepared: ${one.reason}`);
        judgeKinds[kind] = one.judge;
      }
      return { judgePermission: read.judge, judgeKinds };
    },
    async close() {
      delete process.env[keyEnv];
      server.closeAllConnections();
      await new Promise((done) => server.close(() => done()));
    },
  };
}
