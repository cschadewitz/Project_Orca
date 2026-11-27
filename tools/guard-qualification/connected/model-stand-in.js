/**
 * A local stand-in for the model behind a real Claude Code (#706 connected proof). It answers
 * a prompt that ends in `CALL:{"name":…,"input":…}` with exactly that tool call (or, for
 * `CALL:[…]`, those calls in one message), and anything
 * that follows a tool result with "done", so the agent, its adapter and ORCA run for real while
 * no account, key or model spend is involved. It streams, as Claude Code asks it to.
 *
 * It also records what the agent handed back: the tool names offered (on the latest request,
 * and with each call made) and every tool result, which are the connected route's surfaces
 * (what reaches the model).
 */
import { createServer } from "node:http";

const blocks = (m) => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n")
      : "";

export function modelStandIn() {
  let n = 0;
  const log = { offered: [], calls: [], results: [], requests: 0, errors: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d.toString()));
    req.on("end", () => {
      try {
        answer(body, req, res);
      } catch (error) {
        // An answer the stand-in cannot give fails the request, rather than hanging the turn. The
        // error stays in the stand-in's log; the agent gets a fixed message.
        log.errors.push(String(error));
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "the model stand-in failed" } }));
      }
    });
  });
  function answer(body, req, res) {
    {
      if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const request = JSON.parse(body);
      log.requests++;
      // Claude Code can follow the user's turn with a system message, so look at the last user turn.
      const users = request.messages.filter((m) => m.role === "user");
      const results = blocks(users[users.length - 1]).filter((b) => b.type === "tool_result");
      for (const r of results)
        log.results.push({
          toolUseId: r.tool_use_id,
          isError: r.is_error === true,
          text: textOf(r.content),
          at: Date.now(),
        });
      // The call comes from the newest user turn only. A turn after a cancelled one carries
      // the cancelled call's result in the same message as the new prompt.
      const text = blocks(users[users.length - 1])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
      // `CALL:{…}` is one call; `CALL:[{…}, …]` is several in one message, which the agent may run at once.
      const found = [...text.matchAll(/CALL:([[{].*[\]}])/g)];
      const last = found.length ? JSON.parse(found[found.length - 1][1]) : undefined;
      const calls = last === undefined ? [] : Array.isArray(last) ? last : [last];
      const id = `msg_${++n}`;
      const events = [
        [
          "message_start",
          {
            type: "message_start",
            message: {
              id,
              type: "message",
              role: "assistant",
              model: "claude-test",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      ];
      let stop = "end_turn";
      const offered = request.tools?.map((t) => t.name) ?? [];
      if (offered.length) log.offered = offered;
      if (calls.length && offered.length) {
        stop = "tool_use";
        calls.forEach((call, index) => {
          const toolUseId = `toolu_${n}_${index}`;
          // What the agent offered on the request the call was made in: a tool not offered
          // cannot run, which is independent evidence of no effect.
          log.calls.push({ toolUseId, name: call.name, offered, at: Date.now() });
          events.push(
            [
              "content_block_start",
              {
                type: "content_block_start",
                index,
                content_block: { type: "tool_use", id: toolUseId, name: call.name, input: {} },
              },
            ],
            [
              "content_block_delta",
              {
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
              },
            ],
            ["content_block_stop", { type: "content_block_stop", index }],
          );
        });
      } else {
        events.push(
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          [
            "content_block_delta",
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
          ],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
        );
      }
      events.push(
        [
          "message_delta",
          { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } },
        ],
        ["message_stop", { type: "message_stop" }],
      );
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    }
  }
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, log })),
  );
}
