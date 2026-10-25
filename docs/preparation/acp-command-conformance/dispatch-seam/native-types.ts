// #594 type-only bundle of pinned generated types; imports removed, Prettier formatting only.
// Unmodified originals and Git blob identities are retained in upstream/ and source-pins.json.

export type CommandExecutionRequestApprovalParams = {
  /**
   * Kind of action under review. Defaults to `command` for older servers.
   */
  kind: CommandExecutionApprovalKind;
  threadId: string;
  turnId: string;
  itemId: string; /**
   * Unix timestamp (in milliseconds) when this approval request started.
   */
  startedAtMs: number; /**
   * Unique identifier for this specific approval callback.
   *
   * For regular shell/unified_exec approvals, this is null.
   *
   * For zsh-exec-bridge subcommand approvals, multiple callbacks can belong to
   * one parent `itemId`, so `approvalId` is a distinct opaque callback id
   * (a UUID) used to disambiguate routing.
   * Stdin approvals also use a distinct callback id; inspect `kind` to distinguish them.
   */
  approvalId?: string | null; /**
   * Environment in which the command will run.
   */
  environmentId: string | null; /**
   * Optional explanatory reason (e.g. request for network access).
   */
  reason?: string | null; /**
   * Optional context for a managed-network approval prompt.
   */
  networkApprovalContext?: NetworkApprovalContext | null; /**
   * The command to be executed.
   */
  command?: string | null; /**
   * The command's working directory.
   */
  cwd?: LegacyAppPathString | null; /**
   * Best-effort parsed command actions for friendly display.
   */
  commandActions?: Array<CommandAction> | null; /**
   * Optional proposed execpolicy amendment to allow similar commands without prompting.
   */
  proposedExecpolicyAmendment?: ExecPolicyAmendment | null; /**
   * Optional proposed network policy amendments (allow/deny host) for future requests.
   */
  proposedNetworkPolicyAmendments?: Array<NetworkPolicyAmendment> | null;
};

/**
 * A UTF-8 path for preserving raw path compatibility at the app-server API
 * boundary while Codex migrates to [`PathUri`].
 *
 * Supports storing arbitrary strings read from the API and converting to and
 * from [`PathUri`] using an explicitly selected native path convention.
 *
 * When converting from [`PathUri`], "native" refers to the supplied
 * [`PathConvention`], which may be foreign to the operating system running
 * this process. The inner string is private so path-producing code must use a
 * path conversion method instead of bypassing the intended conversion
 * boundary. Non-UTF-8 paths are converted to UTF-8 lossily because this API
 * value is serialized as a JSON string.
 *
 * Deserialization and [`Self::from_string`] accept any UTF-8 string without
 * interpreting or validating it. Use [`Self::from_string`] when a caller
 * already owns legacy app-server path text and needs to preserve its wire
 * spelling; use [`Self::from_path`], [`Self::from_abs_path`], or
 * [`Self::from_path_uri`] when converting an actual path value. Relative
 * path text remains valid until an operation such as [`Self::to_path_uri`]
 * requires an absolute path.
 */
export type LegacyAppPathString = string;

export type CommandAction =
  | { type: "read"; command: string; name: string; path: LegacyAppPathString }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

/**
 * Distinguishes a command approval from input sent to an existing terminal.
 */
export type CommandExecutionApprovalKind = "command" | "writeStdin";

export type ExecPolicyAmendment = Array<string>;

export type NetworkApprovalContext = { host: string; protocol: NetworkApprovalProtocol };

export type NetworkApprovalProtocol = "http" | "https" | "socks5Tcp" | "socks5Udp";

export type NetworkPolicyAmendment = { host: string; action: NetworkPolicyRuleAction };

export type NetworkPolicyRuleAction = "allow" | "deny";

export type CommandExecutionRequestApprovalResponse = { decision: CommandExecutionApprovalDecision };

export type CommandExecutionApprovalDecision =
  | "accept"
  | "acceptForSession"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: ExecPolicyAmendment } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: NetworkPolicyAmendment } }
  | "decline"
  | "cancel";

export type RequestId = string | number;
