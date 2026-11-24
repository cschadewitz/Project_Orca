/**
 * A local stand-in for the OpenAI Responses API behind a real Codex (#1026 installed receipts
 * for Codex). It answers a prompt that ends in `CALL:{"name":…,"input":…}` with exactly that tool
 * call (or, for `CALL:[…]`, those calls in one response), and anything that follows the tool
 * outputs with "done", so Codex, its ACP adapter and ORCA run for real while no account, key or
 * model spend is involved.
 *
 * A call's `name` is the tool as Codex offers it: `exec_command`, `apply_patch` (a freeform
 * tool: `input` is the patch text), `view_image`, or `mcp__<server>__<tool>`, which is sent as
 * the tool `<tool>` in the namespace `mcp__<server>`, as Codex expects an MCP call.
 *
 * It records what Codex handed back: the tool names offered (on the latest request, and with
 * each call made) and every tool output, which are the connected route's surfaces (what
 * reaches the model). An image in an output is recorded as its decoded bytes (latin1), so a
 * token a read put in the image is visible in that call's own result.
 */
import { createServer } from "node:http";

/** The text of a tool output: a string, or content items (text, and images as their bytes). */
function outputText(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return JSON.stringify(output ?? "");
  return output
    .map((item) => {
      if (typeof item?.text === "string") return item.text;
      const url = typeof item?.image_url === "string" ? item.image_url : "";
      const data = /^data:[^;]+;base64,(.*)$/s.exec(url)?.[1];
      return data === undefined ? "" : Buffer.from(data, "base64").toString("latin1");
    })
    .join("\n");
}

/** Every tool Codex offered, by the name a call uses (an MCP tool as `mcp__<server>__<tool>`). */
function offeredNames(tools = []) {
  const names = [];
  for (const t of tools) {
    if (t.type === "namespace" && Array.isArray(t.tools))
      for (const inner of t.tools) names.push(`${t.name}__${inner.name}`);
    else names.push(t.name ?? t.type);
  }
  return names;
}

export function codexModelStandIn() {
  let n = 0;
  const answered = new Set();
  const log = { offered: [], calls: [], results: [], requests: 0, errors: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d.toString()));
    req.on("end", () => {
      try {
        answer(body, req, res);
      } catch (error) {
        // An answer the stand-in cannot give fails the request rather than hanging the turn.
        log.errors.push(String(error));
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "the model stand-in failed" } }));
      }
    });
  });

  function answer(body, req, res) {
    if (!req.url?.includes("/responses")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
      return;
    }
    const request = JSON.parse(body);
    log.requests++;
    const input = request.input ?? [];
    const offered = offeredNames(request.tools);
    if (offered.length) log.offered = offered;
    const kinds = new Map((request.tools ?? []).map((t) => [t.name ?? t.type, t.type]));

    // What follows the model's last message or call: tool outputs (the turn's results, so the
    // turn ends) or the user's new prompt (which may name calls to make).
    let last = -1;
    input.forEach((item, i) => {
      if ((item.type === "message" && item.role === "assistant") || /_call$/.test(item.type ?? "")) last = i;
    });
    const tail = input.slice(last + 1);
    const outputs = tail.filter((i) => i.type === "function_call_output" || i.type === "custom_tool_call_output");
    for (const o of outputs) log.results.push({ toolUseId: o.call_id, isError: false, text: outputText(o.output) });
    const id = `resp_${++n}`;
    const items = [];
    // A prompt's calls are made once. Codex may send the same history again (after a hook
    // blocks a call it can start a new sampling request before the output is in); a repeat is
    // answered "done", so no call is made twice and each call is bound to one prompt.
    const conversation = request.prompt_cache_key ?? req.headers["session_id"] ?? req.headers["conversation_id"] ?? "";
    const promptKey = `${conversation}:${last}:${input.length}`;
    if (outputs.length === 0 && !answered.has(promptKey)) {
      answered.add(promptKey);
      const text = tail
        .filter((i) => i.type === "message" && i.role === "user")
        .flatMap((i) => (Array.isArray(i.content) ? i.content : [{ text: String(i.content ?? "") }]))
        .map((c) => c.text ?? "")
        // Only a prompt that is a call script; Codex's side requests (a title for the
        // conversation) quote the user's prompt inside their own and must make no call.
        .filter((t) => t.trimStart().startsWith("CALL:"))
        .join("\n");
      const found = [...text.matchAll(/CALL:([[{].*[\]}])/gs)];
      const last = found.length ? JSON.parse(found[found.length - 1][1]) : undefined;
      const calls = last === undefined ? [] : Array.isArray(last) ? last : [last];
      calls.forEach((call, index) => {
        const callId = `call_${n}_${index}`;
        log.calls.push({ toolUseId: callId, name: call.name, offered });
        const mcp = /^(mcp__.+?)__(.+)$/.exec(call.name);
        if (kinds.get(call.name) === "custom")
          items.push({
            type: "custom_tool_call",
            id: `ctc_${n}_${index}`,
            call_id: callId,
            name: call.name,
            input: String(call.input ?? ""),
          });
        else
          items.push({
            type: "function_call",
            id: `fc_${n}_${index}`,
            call_id: callId,
            name: mcp ? mcp[2] : call.name,
            ...(mcp ? { namespace: mcp[1] } : {}),
            arguments: JSON.stringify(call.input ?? {}),
          });
      });
    }
    if (items.length === 0)
      items.push({
        type: "message",
        id: `msg_${n}`,
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      });
    const usage = {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      { type: "response.created", response: { id } },
      ...items.map((item) => ({ type: "response.output_item.done", item })),
      { type: "response.completed", response: { id, usage } },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  }

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1`, log })),
  );
}
