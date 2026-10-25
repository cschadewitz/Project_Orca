// Materialize a private proposal against exact upstream snapshots; never accesses a repository or network.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL(".", import.meta.url);
const temp = mkdtempSync(join(tmpdir(), "orca-594-patch-"));
const read = (path) => readFileSync(new URL(path, root), "utf8");
function replaceExactly(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("upstream anchor changed");
  return source.replace(before, after);
}
try {
  for (const dir of ["old", "new"]) mkdirSync(join(temp, dir, "src"), { recursive: true });
  let client = read("upstream/CodexAppServerClient.ts.txt");
  let transport = read("upstream/CodexJsonRpcConnection.ts.txt");
  let stdio = read("upstream/StdUtils.ts.txt");
  writeFileSync(join(temp, "old/src/CodexAppServerClient.ts"), client);
  writeFileSync(join(temp, "old/src/CodexJsonRpcConnection.ts"), transport);
  writeFileSync(join(temp, "old/src/StdUtils.ts"), stdio);
  const writerStart = stdio.indexOf("export function createJSONRPCWriter(");
  const writerEnd = stdio.indexOf("//TODO ask to include proper jsonrpc field and remove", writerStart);
  const fixedStdio = read("native-stdio.ts");
  const fixedWriter = fixedStdio.slice(
    fixedStdio.indexOf("export function createJSONRPCWriter("),
    fixedStdio.indexOf("export function createJSONRPCReader("),
  );
  stdio = stdio.slice(0, writerStart) + fixedWriter + stdio.slice(writerEnd);
  transport = replaceExactly(
    transport,
    'import * as rpc from "vscode-jsonrpc/node";',
    'import {createCommandDispatch} from "./CommandApprovalDispatch";',
  );
  transport = replaceExactly(
    transport,
    "let connection = rpc.createMessageConnection(reader, writer);",
    "const {connection} = createCommandDispatch(reader, writer);",
  );
  client = 'import {commandDispatchFor, type PendingCommand} from "./CommandApprovalDispatch";\n' + client;
  client = replaceExactly(
    client,
    "handleCommandExecution(params: CommandExecutionRequestApprovalParams): Promise<CommandExecutionRequestApprovalResponse>;",
    "handleCommandExecution(params: CommandExecutionRequestApprovalParams, pending: PendingCommand): Promise<CommandExecutionRequestApprovalResponse>;",
  );
  client = replaceExactly(
    client,
    `const CommandExecutionApprovalRequest = new RequestType<
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    void
>('item/commandExecution/requestApproval');\n\n`,
    "",
  );
  client = replaceExactly(
    client,
    `        this.connection.onRequest(CommandExecutionApprovalRequest, async (params) => {
            if (this.isStaleTurn(params.threadId, params.turnId)) {
                return { decision: "cancel" };
            }
            const handler = this.approvalHandlers.get(params.threadId);
            if (!handler) {
                return { decision: "cancel" };
            }
            return await handler.handleCommandExecution(params);
        });`,
    `        commandDispatchFor(this.connection).onCommand(async (pending) => {
            // Preserve the immutable dispatch capture; display/legacy handlers get a copy.
            const params = structuredClone(pending.request.params) as CommandExecutionRequestApprovalParams;
            if (this.isStaleTurn(params.threadId, params.turnId)) {
                pending.cancel();
                return;
            }
            const handler = this.approvalHandlers.get(params.threadId);
            if (!handler) {
                pending.cancel();
                return;
            }
            const response = await handler.handleCommandExecution(params, pending);
            if (this.isStaleTurn(params.threadId, params.turnId) || pending.signal.aborted) {
                pending.cancel();
                return;
            }
            pending.respond(response);
        });`,
  );
  const dispatch = read("dispatch.ts").replace('"./native-request.ts"', '"./CommandNativeRequest"');
  const native = `// Typed native envelope, from the pinned upstream discriminated request union.
import type {ServerRequest} from "./app-server/ServerRequest";
export type {CommandExecutionRequestApprovalResponse as NativeResponse} from "./app-server/v2";
export type NativeCommandRequest = {jsonrpc: "2.0"} & Extract<ServerRequest, {method: "item/commandExecution/requestApproval"}>;
`;
  writeFileSync(join(temp, "new/src/CodexAppServerClient.ts"), client);
  writeFileSync(join(temp, "new/src/CodexJsonRpcConnection.ts"), transport);
  writeFileSync(join(temp, "new/src/StdUtils.ts"), stdio);
  writeFileSync(join(temp, "new/src/CommandApprovalDispatch.ts"), dispatch);
  writeFileSync(join(temp, "new/src/CommandNativeRequest.ts"), native);
  const diff = spawnSync("git", ["diff", "--no-index", "--", "old", "new"], { cwd: temp, encoding: "utf8" });
  if (diff.status !== 1) throw new Error("patch generation failed");
  writeFileSync(
    new URL("codex-acp.patch", root),
    diff.stdout.replaceAll("a/old/", "a/").replaceAll("b/new/", "b/").replaceAll("a/new/", "a/").replace(/^ $/gm, ""),
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
