/**
 * A scripted OpenAI-compatible model for the Cline acceptance suite (#711).
 *
 * Cline is configured with its `openai-compatible` provider pointed at this server, so a real
 * Cline runs real tools on a scripted model's say-so, with no account, key or paid request.
 * Each prompt names a scenario (`SCENARIO:<name>`); the scenario's steps are played in order,
 * one per model call after that prompt: a tool call, a text reply, an HTTP error, or a reply
 * that never comes (for cancellation). When the steps run out the model says "done".
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type StandInStep =
  | { tool: string; args: Record<string, unknown> }
  | { text: string }
  | { status: number; message: string }
  | { hang: true };

export const STAND_IN_MODEL = "stand-in";

export interface StandInCall {
  scenario: string | undefined;
  step: number;
  /** The tool results Cline sent back since the scenario's prompt, newest last. */
  toolResults: string[];
  stream: boolean;
  tools: string[];
}

type Message = { role: string; content?: unknown; tool_calls?: unknown[] };

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : ""))
          .join("")
      : "";

export class StandInModel {
  readonly calls: StandInCall[] = [];
  private server: Server | undefined;
  private readonly hanging = new Set<ServerResponse>();
  private nextCall = 1;

  constructor(private readonly scenarios: Record<string, readonly StandInStep[]>) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.serve(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  async stop(): Promise<void> {
    for (const res of this.hanging) res.destroy();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    if (req.method === "GET" && url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: STAND_IN_MODEL, object: "model", owned_by: "orca" }] }));
      return;
    }
    if (req.method !== "POST" || !url.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as {
      messages: Message[];
      stream?: boolean;
      tools?: { function?: { name?: string } }[];
    };
    const messages = body.messages ?? [];
    let start = -1;
    let scenario: string | undefined;
    messages.forEach((m, i) => {
      const found = m.role === "user" ? /SCENARIO:([a-z0-9-]+)/.exec(text(m.content)) : null;
      if (found) {
        start = i;
        scenario = found[1];
      }
    });
    const after = start < 0 ? [] : messages.slice(start + 1);
    const step = after.filter((m) => m.role === "assistant").length;
    this.calls.push({
      scenario,
      step,
      toolResults: after.filter((m) => m.role === "tool").map((m) => text(m.content)),
      stream: body.stream === true,
      tools: (body.tools ?? []).map((t) => t.function?.name ?? ""),
    });
    const next: StandInStep = (scenario && this.scenarios[scenario]?.[step]) || { text: "done" };
    if ("hang" in next) {
      this.hanging.add(res);
      res.on("close", () => this.hanging.delete(res));
      return;
    }
    if ("status" in next) {
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: next.message, type: "stand_in_error", code: next.status } }));
      return;
    }
    const id = `chatcmpl-${this.nextCall++}`;
    const toolCall =
      "tool" in next
        ? {
            index: 0,
            id: `call_${id}`,
            type: "function",
            function: { name: next.tool, arguments: JSON.stringify(next.args) },
          }
        : undefined;
    const finish = toolCall ? "tool_calls" : "stop";
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          created: 0,
          model: STAND_IN_MODEL,
          choices: [
            {
              index: 0,
              message: toolCall
                ? { role: "assistant", content: null, tool_calls: [{ ...toolCall, index: undefined }] }
                : { role: "assistant", content: (next as { text: string }).text },
              finish_reason: finish,
            },
          ],
          usage,
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const chunk = (delta: object, finish_reason: string | null, extra: object = {}) =>
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: STAND_IN_MODEL, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`,
      );
    chunk({ role: "assistant", content: "" }, null);
    if (toolCall) chunk({ tool_calls: [toolCall] }, null);
    else chunk({ content: (next as { text: string }).text }, null);
    chunk({}, finish);
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: STAND_IN_MODEL, choices: [], usage })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  }
}
