/**
 * A scripted local stand-in for the model the real Codex talks to (an OpenAI Responses
 * endpoint), shared by the acceptance suites that run the pinned Codex pair (#705, #1026). No
 * account, key or model spend is involved.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Step = { tool: string; namespace?: string; args?: Record<string, unknown>; input?: string };

/**
 * A Responses endpoint that plays the `SCRIPT:` in the latest prompt: step k after k tool
 * outputs since that prompt, then "done". A step for a freeform (custom) tool sends its `input` as is. `"$SID"` in a
 * step's arguments is the session id the previous output reported.
 */
export interface ModelStandIn {
  server: Server;
  url: string;
  /** Every tool Codex offered the model, by name (or type, for hosted tools). */
  tools: Set<string>;
  /** Every tool output Codex sent back, as it sent it. */
  outputs: string[];
  /**
   * While set, every model request is answered as OpenAI answers a login whose usage limit is
   * reached: 429 `usage_limit_reached` with the `x-codex-primary-*` headers (#1164).
   */
  usageLimit?: { usedPercent: number; windowMinutes: number; resetsAt: number };
}

/** The script a user message is, when its text starts with `SCRIPT:`. */
function scriptOf(item: { type?: string; role?: string; content?: unknown }): Step[] | undefined {
  if (item.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) return undefined;
  for (const part of item.content as { text?: unknown }[]) {
    const found = typeof part.text === "string" ? /^SCRIPT: ([A-Za-z0-9+/=]+)$/.exec(part.text.trim()) : null;
    if (found) return JSON.parse(Buffer.from(found[1]!, "base64").toString("utf8")) as Step[];
  }
  return undefined;
}

export function modelStandIn(): Promise<ModelStandIn> {
  let n = 0;
  /** Every tool output Codex sent back, as it sent it; printed when a test fails. */
  const seen: string[] = [];
  /** Every tool Codex offered the model, by name (or type, for hosted tools). */
  const tools = new Set<string>();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      if (!req.url?.includes("/responses")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      if (standIn.usageLimit) {
        const { usedPercent, windowMinutes, resetsAt } = standIn.usageLimit;
        res.writeHead(429, {
          "content-type": "application/json",
          "x-codex-primary-used-percent": String(usedPercent),
          "x-codex-primary-window-minutes": String(windowMinutes),
          "x-codex-primary-reset-at": String(resetsAt),
        });
        res.end(
          JSON.stringify({
            error: {
              type: "usage_limit_reached",
              message: "The usage limit has been reached",
              resets_at: resetsAt,
              limit_window_minutes: windowMinutes,
            },
          }),
        );
        return;
      }
      const request = JSON.parse(body) as {
        input?: { type?: string; role?: string; content?: unknown; output?: unknown }[];
        tools?: { type: string; name?: string }[];
      };
      for (const t of request.tools ?? []) tools.add(t.name ?? t.type);
      const input = request.input ?? [];
      // The prompt being played is the last user message that is a script, and the outputs
      // that count are the ones since it. A message that only quotes a script is not one:
      // Codex asks a second model for a conversation title and quotes the first prompt to it.
      let script: Step[] = [];
      let from = input.length;
      input.forEach((item, i) => {
        const found = scriptOf(item);
        if (found) [script, from] = [found, i + 1];
      });
      const outputs = input
        .slice(from)
        .filter((i) => i.type === "function_call_output" || i.type === "custom_tool_call_output");
      const lastOut = outputs.length ? JSON.stringify(outputs[outputs.length - 1]!.output ?? "") : "";
      if (outputs.length) seen.push(lastOut.slice(0, 2000));
      const sid = /session ID (\d+)/.exec(lastOut)?.[1] ?? "0";
      const step = script[outputs.length];
      const id = `resp_${++n}`;
      let item: Record<string, unknown>;
      if (step) {
        const custom = request.tools?.find((t) => t.name === step.tool)?.type === "custom";
        item = custom
          ? { type: "custom_tool_call", id: `ctc_${n}`, call_id: `call_${n}`, name: step.tool, input: step.input ?? "" }
          : {
              type: "function_call",
              id: `fc_${n}`,
              call_id: `call_${n}`,
              name: step.tool,
              ...(step.namespace ? { namespace: step.namespace } : {}),
              arguments: JSON.stringify(step.args ?? {}).replaceAll('"$SID"', sid),
            };
      } else
        item = { type: "message", id: `msg_${n}`, role: "assistant", content: [{ type: "output_text", text: "done" }] };
      const usage = {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { id, usage } },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  const standIn: ModelStandIn = { server, url: "", tools, outputs: seen };
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      standIn.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      resolve(standIn);
    }),
  );
}

export const script = (...steps: Step[]) => `SCRIPT: ${Buffer.from(JSON.stringify(steps)).toString("base64")}`;
export const shell = (cmd: string): Step => ({ tool: "exec_command", args: { cmd } });
export const patch = (...lines: string[]): Step => ({
  tool: "apply_patch",
  input: ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n"),
});
