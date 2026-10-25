// The command branch of ServerRequest at bridge 202e66e; see source-pins.json.
// The generated params/response types below are unmodified upstream bytes.
import type { RequestId, CommandExecutionRequestApprovalParams } from "./native-types.ts";
export type { CommandExecutionRequestApprovalResponse as NativeResponse } from "./native-types.ts";

export type NativeCommandRequest = {
  jsonrpc: "2.0";
  method: "item/commandExecution/requestApproval";
  id: RequestId;
  params: CommandExecutionRequestApprovalParams;
};
