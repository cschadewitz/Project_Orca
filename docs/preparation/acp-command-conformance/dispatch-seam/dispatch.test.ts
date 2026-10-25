// #594 actual JSON-RPC dispatch/closure regressions, over framed memory streams only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import * as rpc from "vscode-jsonrpc/node";
import { createCommandDispatch, commandDispatchFor, type PendingCommand } from "./dispatch.ts";
import type { NativeCommandRequest } from "./native-request.ts";
import { createJSONRPCReader, createJSONRPCWriter } from "./native-stdio.ts";

const METHOD = "item/commandExecution/requestApproval";
const params = (): NativeCommandRequest["params"] => ({
  kind: "command",
  threadId: "synthetic-thread",
  turnId: "synthetic-turn",
  itemId: "same-item",
  startedAtMs: 123,
  approvalId: null,
  environmentId: null,
  command: "/bin/bash -lc 'printf orca-594'",
  cwd: "/synthetic-workspace",
});
async function until(predicate: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.fail("bounded event wait expired");
}
async function drain() {
  for (let i = 0; i < 10; i++) await setImmediate();
}

function harness(t: TestContext, fault: "none" | "before" | "after" = "none") {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const reader = createJSONRPCReader(incoming);
  const writer = createJSONRPCWriter(outgoing);
  const peer = createJSONRPCReader(outgoing);
  const replies: rpc.Message[] = [];
  const attempts: rpc.Message[] = [];
  peer.listen((message) => replies.push(message));
  const dispatch = createCommandDispatch(reader, {
    onError: writer.onError,
    onClose: writer.onClose,
    dispose: () => writer.dispose(),
    end: () => writer.end(),
    async write(message) {
      attempts.push(structuredClone(message));
      if (fault === "before") throw new Error("synthetic transport fault");
      await writer.write(message);
      if (fault === "after") throw new Error("synthetic acknowledgement lost");
    },
  });
  const pending: PendingCommand[] = [];
  const handled = dispatch.onCommand((request) => {
    pending.push(request);
  });
  dispatch.connection.listen();
  t.after(() => {
    dispatch.connection.dispose();
    peer.dispose();
    incoming.destroy();
    outgoing.destroy();
  });
  function send(message: object) {
    const wire = { ...message } as { jsonrpc?: string };
    delete wire.jsonrpc;
    incoming.write(JSON.stringify(wire) + "\n");
  }
  const request = (id: string | number, p: object = params()) =>
    send({ jsonrpc: "2.0", method: METHOD, id, params: p });
  return { ...dispatch, pending, replies, attempts, request, send, handled };
}

await test("actual dispatcher keeps concurrent identical params on separate original response closures", async (t) => {
  const h = harness(t);
  h.request(1);
  h.request(2);
  await until(() => h.pending.length === 2);
  const [a, b] = h.pending as [PendingCommand, PendingCommand];
  assert.deepEqual(a.request.params, b.request.params);
  assert.equal(a.connectionIncarnation, b.connectionIncarnation);
  assert.notEqual(a.callback, b.callback);
  assert.equal(commandDispatchFor(h.connection).connectionIncarnation, a.connectionIncarnation);
  assert.equal(b.respond({ decision: "decline" }), true);
  await until(() => h.replies.length === 1);
  assert.equal(a.respond({ decision: "cancel" }), true);
  await until(() => h.replies.length === 2);
  assert.deepEqual(h.replies, [
    { jsonrpc: "2.0", id: 2, result: { decision: "decline" } },
    { jsonrpc: "2.0", id: 1, result: { decision: "cancel" } },
  ]);
});

await test("same item, distinct native approval callbacks, and typed IDs remain distinct", async (t) => {
  const h = harness(t);
  h.request("native-1", { ...params(), approvalId: "callback-a" });
  h.request(2, { ...params(), approvalId: "callback-b" });
  await until(() => h.pending.length === 2);
  assert.notEqual(h.pending[0]!.callback, h.pending[1]!.callback);
  assert.equal(typeof h.pending[0]!.request.id, "string");
  assert.equal(typeof h.pending[1]!.request.id, "number");
  h.pending[1]!.respond({ decision: "cancel" });
  h.pending[0]!.respond({ decision: "decline" });
  await until(() => h.replies.length === 2);
  assert.deepEqual(
    h.replies.map((m) => (m as rpc.ResponseMessage).id),
    [2, "native-1"],
  );
});

await test("claims one response synchronously across concurrent/duplicate completions", async (t) => {
  const h = harness(t);
  h.request(1);
  await until(() => h.pending.length === 1);
  const p = h.pending[0]!;
  const result = await Promise.all([
    Promise.resolve().then(() => p.respond({ decision: "decline" })),
    Promise.resolve().then(() => p.respond({ decision: "cancel" })),
  ]);
  assert.deepEqual(result, [true, false]);
  await until(() => h.replies.length === 1);
  assert.equal(p.respond({ decision: "decline" }), false);
  await drain();
  assert.equal(h.attempts.length, 1);
});

await test("native cancellation token settles only the original pending response with cancel", async (t) => {
  const h = harness(t);
  h.request(1);
  h.request(2);
  await until(() => h.pending.length === 2);
  h.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } });
  await until(() => h.replies.length === 1);
  assert.equal(h.pending[0]!.signal.aborted, true);
  assert.equal(h.pending[1]!.signal.aborted, false);
  assert.equal(h.pending[0]!.respond({ decision: "decline" }), false);
  assert.deepEqual(h.replies[0], { jsonrpc: "2.0", id: 1, result: { decision: "cancel" } });
});

await test("cancellation before queued dispatch never runs the handler", async (t) => {
  const h = harness(t);
  h.request(1);
  h.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } });
  await until(() => h.replies.length === 1);
  assert.equal(h.pending.length, 0);
  assert.deepEqual(h.replies[0], { jsonrpc: "2.0", id: 1, result: { decision: "cancel" } });
});

await test("cancel after local claim but before write cannot send the claimed result", async (t) => {
  const h = harness(t);
  h.request(1);
  await until(() => h.pending.length === 1);
  const p = h.pending[0]!;
  p.respond({ decision: "decline" });
  p.cancel();
  await until(() => h.replies.length === 1);
  assert.deepEqual(h.replies[0], { jsonrpc: "2.0", id: 1, result: { decision: "cancel" } });
});

for (const fault of ["before", "after"] as const) {
  await test(`no retry after uncertain ${fault}-write delivery, including library error fallback`, async (t) => {
    const h = harness(t, fault);
    h.request(1);
    await until(() => h.pending.length === 1);
    const p = h.pending[0]!;
    p.respond({ decision: "decline" });
    await until(() => h.attempts.length === 1);
    await drain();
    assert.deepEqual(p.status(), { claimed: true, write: "uncertain", remoteAcknowledged: false });
    assert.equal(h.replies.length, fault === "after" ? 1 : 0);
    assert.equal(p.respond({ decision: "decline" }), false);
    p.cancel();
    await drain();
    assert.equal(h.attempts.length, 1);
  });
}

await test("local write success makes no claim about native acknowledgement or command execution", async (t) => {
  const h = harness(t);
  h.request(1);
  await until(() => h.pending.length === 1);
  h.pending[0]!.respond({ decision: "decline" });
  await until(() => h.replies.length === 1);
  await drain();
  assert.deepEqual(h.pending[0]!.status(), { claimed: true, write: "write-returned", remoteAcknowledged: false });
});

await test("unmodified 9.0.1 attempts an error response after a result reached the peer but its write rejected", async (t) => {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const reader = createJSONRPCReader(incoming);
  const writer = createJSONRPCWriter(outgoing);
  const attempts: rpc.Message[] = [];
  const replies: rpc.Message[] = [];
  const peer = createJSONRPCReader(outgoing);
  peer.listen((m) => replies.push(m));
  const connection = rpc.createMessageConnection(
    reader,
    {
      onError: writer.onError,
      onClose: writer.onClose,
      dispose: () => writer.dispose(),
      end: () => writer.end(),
      async write(message) {
        attempts.push(message);
        await writer.write(message);
        throw new Error("synthetic lost acknowledgement");
      },
    },
    rpc.NullLogger,
  );
  connection.onRequest(METHOD, () => ({ decision: "decline" }));
  connection.listen();
  t.after(() => {
    connection.dispose();
    peer.dispose();
    incoming.destroy();
    outgoing.destroy();
  });
  const text = JSON.stringify({ jsonrpc: "2.0", method: METHOD, id: 1, params: params() });
  incoming.write(text + "\n");
  await until(() => replies.length === 2);
  assert.equal(attempts.length, 2);
  assert.ok("result" in replies[0]!);
  assert.ok("error" in replies[1]!);
  assert.equal((replies[0] as rpc.ResponseMessage).id, (replies[1] as rpc.ResponseMessage).id);
});

await test("disposal aborts old callbacks; reconnect gives a fresh incarnation without inherited response authority", async (t) => {
  const old = harness(t);
  old.request(1);
  await until(() => old.pending.length === 1);
  old.connection.dispose();
  const fresh = harness(t);
  fresh.request(1);
  await until(() => fresh.pending.length === 1);
  assert.equal(old.pending[0]!.signal.aborted, true);
  assert.equal(old.pending[0]!.respond({ decision: "decline" }), false);
  assert.notEqual(old.pending[0]!.connectionIncarnation, fresh.pending[0]!.connectionIncarnation);
  assert.notEqual(old.pending[0]!.callback, fresh.pending[0]!.callback);
  fresh.pending[0]!.respond({ decision: "decline" });
  await until(() => fresh.replies.length === 1);
  await drain();
  assert.equal(old.attempts.length, 0);
});

for (const timing of ["queued", "pending", "settled"] as const) {
  await test(`duplicate inbound ID at ${timing} retires incarnation and never replies twice`, async (t) => {
    const h = harness(t);
    let disposed = false;
    h.connection.onDispose(() => {
      disposed = true;
    });
    h.request(1);
    if (timing !== "queued") await until(() => h.pending.length === 1);
    if (timing === "settled") {
      h.pending[0]!.respond({ decision: "decline" });
      await until(() => h.replies.length === 1);
    }
    h.request(1);
    await until(() => disposed);
    await drain();
    assert.equal(h.attempts.length, timing === "settled" ? 1 : 0);
    assert.ok(h.pending.every((p) => p.signal.aborted));
  });
}

await test("rejects numeric/string ID aliases before the library's string-keyed queue can overwrite", async (t) => {
  const h = harness(t);
  let disposed = false;
  h.connection.onDispose(() => {
    disposed = true;
  });
  h.request(1);
  h.request("1");
  await until(() => disposed);
  await drain();
  assert.equal(h.pending.length, 0);
  assert.equal(h.attempts.length, 0);
});

await test("an unrelated method cannot steal a pending command's response ID", async (t) => {
  const h = harness(t);
  let disposed = false;
  h.connection.onDispose(() => {
    disposed = true;
  });
  h.connection.onRequest("synthetic/ping", () => "pong");
  h.request(1);
  await until(() => h.pending.length === 1);
  h.send({ jsonrpc: "2.0", method: "synthetic/ping", id: 1, params: {} });
  await until(() => disposed);
  await drain();
  assert.equal(h.attempts.length, 0);
  assert.equal(h.pending[0]!.respond({ decision: "decline" }), false);
});

await test("snapshot retains exact wrapper, unknown/native fields, omitted versus null, and cannot be mutated", async (t) => {
  const h = harness(t);
  h.request(1, {
    ...params(),
    additionalPermissions: null,
    availableDecisions: ["decline", "cancel"],
    commandActions: [{ type: "unknown", command: "display only" }],
    _meta: { scopeEvidence: "complete" },
  });
  await until(() => h.pending.length === 1);
  const p = h.pending[0]!;
  assert.equal(p.request.params.command, params().command);
  assert.equal(Object.hasOwn(p.request.params, "additionalPermissions"), true);
  assert.equal(Object.hasOwn(p.request.params, "networkApprovalContext"), false);
  assert.throws(() => {
    (p.request.params as { command: string }).command = "changed";
  }, TypeError);
  assert.throws(() => {
    (p.request.params.commandActions as object[]).push({});
  }, TypeError);
  assert.deepEqual(p.exactCommand(), { state: "unsupported", options: [], reason: "native-descriptor-unavailable" });
});

await test("native NDJSON framing retains multibyte, embedded newline and Unicode line separators as command data", async (t) => {
  const h = harness(t);
  const command = "/bin/bash -lc 'printf é\\n'\nsynthetic\u2028data\u2029";
  h.request(1, { ...params(), command });
  await until(() => h.pending.length === 1);
  assert.equal(h.pending[0]!.request.params.command, command);
  h.pending[0]!.respond({ decision: "decline" });
  await until(() => h.replies.length === 1);
});

await test("proposed native writer propagates synchronous write failure instead of swallowing it", async (t) => {
  const stream = new PassThrough();
  t.after(() => stream.destroy());
  stream.write = () => {
    throw new Error("synthetic native write failed");
  };
  const writer = createJSONRPCWriter(stream);
  await assert.rejects(
    writer.write({ jsonrpc: "2.0", id: 1, result: { decision: "cancel" } } as rpc.ResponseMessage),
    /synthetic native write failed/,
  );
});

await test("proposed native writer honors backpressure and emits native newline framing without jsonrpc", async (t) => {
  let complete: (() => void) | undefined;
  let bytes = "";
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      bytes += String(chunk);
      complete = callback;
    },
  });
  t.after(() => stream.destroy());
  const writer = createJSONRPCWriter(stream);
  let settled = false;
  const result = writer
    .write({ jsonrpc: "2.0", id: 1, result: { decision: "cancel" } } as rpc.ResponseMessage)
    .then(() => {
      settled = true;
    });
  await drain();
  assert.equal(settled, false);
  assert.ok(complete);
  complete();
  await result;
  assert.equal(bytes, '{"id":1,"result":{"decision":"cancel"}}\n');
});

for (const scope of [
  {},
  { additionalPermissions: null },
  { additionalPermissions: { network: true } },
  { evidenceDescriptor: { version: 1, scopeEvidence: "complete", environment: "local" } },
]) {
  await test(`existing/missing/forged native descriptor never establishes exact-command support: ${JSON.stringify(scope)}`, async (t) => {
    const h = harness(t);
    h.request(1, { ...params(), ...scope });
    await until(() => h.pending.length === 1);
    assert.equal(h.pending[0]!.exactCommand().state, "unsupported");
    assert.deepEqual(h.pending[0]!.exactCommand().options, []);
    assert.equal(h.attempts.length, 0);
  });
}

await test("handler failure resolves original callback as cancel without private error diagnostics", async (t) => {
  const h = harness(t);
  h.handled.dispose();
  // The factory intentionally permits exactly one handler binding per incarnation.
  assert.throws(() => h.onCommand(() => {}), /ALREADY_BOUND/);
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const reader = createJSONRPCReader(incoming);
  const writer = createJSONRPCWriter(outgoing);
  const replies: rpc.Message[] = [];
  const peer = createJSONRPCReader(outgoing);
  peer.listen((m) => replies.push(m));
  const d = createCommandDispatch(reader, writer);
  d.onCommand(() => {
    throw new Error("synthetic protected sentinel");
  });
  d.connection.listen();
  t.after(() => {
    d.connection.dispose();
    peer.dispose();
    incoming.destroy();
    outgoing.destroy();
  });
  const text = JSON.stringify({ jsonrpc: "2.0", method: METHOD, id: 1, params: params() });
  incoming.write(text + "\n");
  await until(() => replies.length === 1);
  assert.deepEqual(replies[0], { jsonrpc: "2.0", id: 1, result: { decision: "cancel" } });
});

await test("unrelated requests and notifications continue through original dispatch", async (t) => {
  const h = harness(t);
  let notifications = 0;
  h.connection.onRequest("synthetic/ping", () => "pong");
  h.connection.onNotification("synthetic/note", () => {
    notifications++;
  });
  h.send({ jsonrpc: "2.0", method: "synthetic/ping", id: 9, params: {} });
  h.send({ jsonrpc: "2.0", method: "synthetic/note", params: {} });
  await until(() => h.replies.length === 1 && notifications === 1);
  assert.deepEqual(h.replies[0], { jsonrpc: "2.0", id: 9, result: "pong" });
  assert.equal(h.pending.length, 0);
});

await test("request byte budget ends incarnation without projecting/truncating command data", async (t) => {
  const h = harness(t);
  let disposed = false;
  h.connection.onDispose(() => {
    disposed = true;
  });
  h.request(1, { ...params(), command: "é".repeat(256 * 1024) });
  await until(() => disposed);
  assert.equal(h.pending.length, 0);
  assert.equal(h.attempts.length, 0);
});

await test("bounded incarnation history refuses request 257 without evicting replay tombstones", async (t) => {
  const h = harness(t);
  let disposed = false;
  h.connection.onDispose(() => {
    disposed = true;
  });
  for (let id = 1; id <= 256; id++) h.request(id);
  await until(() => h.pending.length === 256);
  h.request(257);
  await until(() => disposed);
  await drain();
  assert.equal(h.pending.length, 256);
  assert.equal(h.attempts.length, 0);
});

await test("source correspondence: exact vendored blob IDs, original request branch and applicable upstream patch", () => {
  const root = new URL(".", import.meta.url);
  const pins = JSON.parse(readFileSync(new URL("source-pins.json", root), "utf8")) as {
    bridgeFiles: { path: string; blob: string; local: string }[];
  };
  for (const pin of pins.bridgeFiles) {
    const bytes = readFileSync(new URL(pin.local, root));
    const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    assert.equal(hash, pin.blob, pin.path);
  }
  const rpcPins = JSON.parse(readFileSync(new URL("source-pins.json", root), "utf8")).rpc as {
    version: string;
    connectionJsSha256: string;
  };
  const rpcPackage = JSON.parse(readFileSync(new URL("node_modules/vscode-jsonrpc/package.json", root), "utf8")) as {
    version: string;
  };
  assert.equal(rpcPackage.version, rpcPins.version);
  assert.equal(
    createHash("sha256")
      .update(readFileSync(new URL("node_modules/vscode-jsonrpc/lib/common/connection.js", root)))
      .digest("hex"),
    rpcPins.connectionJsSha256,
  );
  const request = readFileSync(new URL("upstream/app-server/ServerRequest.ts.txt", root), "utf8");
  assert.ok(
    request.includes(
      '{ "method": "item/commandExecution/requestApproval", id: RequestId, params: CommandExecutionRequestApprovalParams, }',
    ),
  );
  const temp = mkdtempSync(join(tmpdir(), "orca-594-apply-"));
  try {
    mkdirSync(join(temp, "src"));
    for (const name of ["CodexAppServerClient", "CodexJsonRpcConnection", "StdUtils"]) {
      writeFileSync(join(temp, "src", name + ".ts"), readFileSync(new URL(`upstream/${name}.ts.txt`, root)));
    }
    const patch = new URL("codex-acp.patch", root).pathname;
    execFileSync("git", ["apply", "--check", patch], { cwd: temp });
    execFileSync("git", ["apply", patch], { cwd: temp });
    const applied = readFileSync(join(temp, "src", "CommandApprovalDispatch.ts"), "utf8");
    const prototype = readFileSync(new URL("dispatch.ts", root), "utf8").replace(
      '"./native-request.ts"',
      '"./CommandNativeRequest"',
    );
    assert.equal(applied, prototype);
    const appliedStdio = readFileSync(join(temp, "src", "StdUtils.ts"), "utf8");
    const fixedStdio = readFileSync(new URL("native-stdio.ts", root), "utf8");
    const fixedWriter = fixedStdio.slice(
      fixedStdio.indexOf("export function createJSONRPCWriter("),
      fixedStdio.indexOf("export function createJSONRPCReader("),
    );
    assert.ok(appliedStdio.includes(fixedWriter));
    assert.ok(readFileSync(join(temp, "src", "CommandNativeRequest.ts"), "utf8").includes("Extract<ServerRequest"));
    assert.ok(readFileSync(join(temp, "src", "CodexAppServerClient.ts"), "utf8").includes("pending.respond(response)"));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
