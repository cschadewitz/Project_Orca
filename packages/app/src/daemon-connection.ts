/** Nonsecret target contract shared by main, preload and the connection dialog. */
import type { ConnectionState } from "@orca/design";
import type { DisplayStatus, RunOperationsView, SessionSlotsSummary } from "@orca/protocol";

export interface DaemonIdentity {
  workspaceId: string;
  instanceId: string;
}
export interface DaemonTargetSnapshot {
  epoch: number;
  /** For a profile connection, the local end of its tunnel. */
  url: string;
  source: "env" | "saved" | "bundled" | "development" | "store";
  identity?: DaemonIdentity;
  environmentOverride: boolean;
  /** Set when the connection runs through an app-managed SSH profile (#874). */
  profile?: { id: string; name: string; destination: string };
}

/**
 * A saved SSH connection profile as the renderer sees it (#874): where it points and
 * whether a credential and a pinned host key exist, never the credential or the key.
 */
export interface RemoteProfileHop {
  destination: string;
  sshPort?: number;
  /** An absolute private key path. Absent: the keys the SSH agent offers. */
  identityFile?: string;
}
export interface RemoteProfileView extends RemoteProfileHop {
  id: string;
  name: string;
  /** One jump host, with its own pinned host key. */
  jump?: RemoteProfileHop;
  remotePort: number;
  /** The server's ORCA CLI for automatic sign-in (#875). Absent: `orca` on the server's PATH. */
  serverCommand?: string;
  /** The daemon's workspace config on the server. Absent: the CLI's own default. */
  serverConfig?: string;
  /** Credentials are issued with the read-only `viewer` preset. */
  readOnly?: true;
  /** Picked from the tailnet (#1226): bound to this node's stable ID; `name` is its MagicDNS name then. */
  tailnet?: { node: string; name: string };
  hasCredential: boolean;
  /** When the automatically issued credential expires; it is renewed well before. */
  credentialExpiresAt?: string;
  /** The credential was imported by hand, so ORCA cannot renew or revoke it. */
  credentialImported?: true;
  /** Replaced credentials ORCA issued that are not revoked on the server yet. */
  pendingRevocations?: number;
  hostKeyPinned: boolean;
  /** A pin was enrolled and is now missing, empty or unreadable: connects fail closed until it is forgotten. */
  hostKeyMissing?: true;
}

/** What the dialog sends to create (`id` absent) or edit a profile. */
export interface RemoteProfileInput extends RemoteProfileHop {
  id?: string;
  name: string;
  jump?: RemoteProfileHop;
  remotePort?: number;
  serverCommand?: string;
  serverConfig?: string;
  readOnly?: boolean;
  /** Bind to a tailnet node (#1226). Left out on an edit: the profile keeps the node it had. */
  tailnet?: { node: string; name: string };
}

/**
 * What removing a profile did to its credential on the server: revoked there, not reached
 * (it stays valid there until it expires), or there was none ORCA had issued.
 */
export type ProfileRemoval = { revoke: "revoked" | "not-reached" | "none" };

/** A URL, the bundled daemon (`null`), or a saved profile. */
export type DaemonConnectionRequest = string | null | { profile: string };

export type ProfileResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** One step of setting up a server (#881), as the server reported it. */
export interface ServerSetupStepView {
  step: string;
  result: "ok" | "changed" | "repaired" | "warning" | "refused" | "failed";
  detail: string;
}
/**
 * What setting up a profile's server came to: `ready`, `refused` (an unmanaged installation,
 * say: nothing changed for it), `failed` (put back as it was, and confirmed), `mismatch` (the
 * server reported other than what was confirmed: nothing saved, no sign-in), `no-python`, or
 * `unknown` (it did not say how it ended, or could not confirm the put-back: run it again).
 * Then whether this computer signed in.
 */
export interface ServerSetupView {
  setup: {
    kind: "ready" | "refused" | "failed" | "mismatch" | "no-python" | "unknown";
    steps: ServerSetupStepView[];
    step?: string;
    detail?: string;
    version?: string;
  };
  signIn?: { ok: true } | { ok: false; message: string };
}

/**
 * What the person confirms before their machine is set up (#881): read-only findings, over host
 * keys shown here before they are enrolled. `confirmation` goes back to `setUpServer`.
 */
export interface ServerInspectionView {
  confirmation: string;
  destination: string;
  account: string;
  fingerprints: { server: string[]; jump?: string[] };
  firstUse: boolean;
  /** The keys are the ones the machine's tailnet advertises (#1227): shown as such, still confirmed. */
  advertised?: true;
  version: string;
  root: string;
  current: string | null;
  scope: "install-and-sign-in";
  /** A Windows server (#1238): its setup is a scheduled task, and it downloads its own bundle. */
  os?: "windows";
}
/** An inspection: something to confirm, or (`setup`) why this server cannot be set up. */
export interface ServerInspectionResultView {
  inspection?: ServerInspectionView;
  setup?: ServerSetupView["setup"];
}

/** A machine on this computer's tailnet (#1226), as Add a machine lists it. */
export interface TailnetMachineView {
  /** The stable node ID a profile is bound to. */
  node: string;
  /** Its MagicDNS name, without the trailing dot. */
  name: string;
  hostName: string;
  os: string;
  online: boolean;
  /** Runs Tailscale SSH, so it advertises its host keys (#1227). */
  tailscaleSsh: boolean;
  /** Shared in from another tailnet: its host keys are confirmed by hand. */
  sharedIn: boolean;
  /** ORCA can set up a server there: Linux or Windows (#1238). */
  hostSupported: boolean;
}
/**
 * The tailnet as Add a machine sees it: `off` (the `tailnet-hosts` flag is off: nothing is
 * shown), Tailscale missing, stopped or unreadable here, or running with its machines.
 */
export type TailnetMachinesView =
  | { state: "running"; tailnetName?: string; machines: TailnetMachineView[] }
  | { state: "off" | "absent" | "stopped" | "signed-out" | "error"; detail?: string };

/** Tailscale SSH asks the person to approve a connection (check mode, #1228). */
export interface LoginApprovalView {
  profileId: string;
  /** The approval page's host, to name it; main opens the page itself. */
  host: string;
}

/** A repository a push put on a managed server (#1235), with the checkout a daemon there works in. */
export interface HostRepositoryView {
  name: string;
  /** The checkout on the server. */
  checkout: string;
  /** Its branches there (`refs/heads/…`). */
  branches: string[];
  /**
   * The `workspace:` settings that work in the checkout, built by this computer from what it
   * checked there: from the branch the checkout has. Absent when it is on no branch of its own.
   */
  workspace?: {
    provider: "git-worktree";
    repo: string;
    baseBranch: string;
    fetchRemote: "origin";
    allowedRefs?: string[];
  };
  /** Why there are no workspace settings for it. */
  problem?: string;
}

/** One agent ORCA can put on a managed server (#1236), and its state there. */
export interface HostAgentView {
  agent: string;
  name: string;
  /** The version this ORCA pins. */
  version: string;
  /** That exact install is on the server, unchanged since it was installed. */
  installed: boolean;
  signedIn: "yes" | "no" | "unknown";
  /** Why the install there cannot be used, when it is there but changed. */
  problem?: string;
  /**
   * `device-code`: Sign in runs the agent's own sign-in there. `yourself`: the person signs it
   * in on that machine (Claude Code); ORCA never takes part.
   */
  signIn: "device-code" | "yourself";
  /** For `yourself`, once installed: what to run on that machine to sign it in. */
  signInCommand?: string;
  /** Once installed: the `agents:` entry that runs it in that machine's own config (#1235). */
  entry?: { id: string; name: string; command: string; args: string[]; env: Record<string, string> };
}

/** An agent's sign-in on a server waits for the person (#1236): the page's host and the code to enter. */
export interface AgentSignInView {
  profileId: string;
  agent: string;
  /** Which sign-in this prompt is for: opening its page names it. */
  attempt: string;
  /** The sign-in page's host, to name it; main opens the page itself. */
  host?: string;
  code?: string;
}

/** Profile management. Every call is main-process work; secrets never cross this bridge. */
export interface RemoteProfilesBridge {
  list(this: void): Promise<RemoteProfileView[]>;
  save(this: void, input: RemoteProfileInput): Promise<ProfileResult<RemoteProfileView>>;
  remove(this: void, id: string): Promise<ProfileResult<ProfileRemoval>>;
  /** Main opens a file picker, reads and seals the credential; nothing comes back but the view. */
  importCredential(this: void, id: string): Promise<ProfileResult<RemoteProfileView | null>>;
  forgetHostKey(this: void, id: string): Promise<ProfileResult<RemoteProfileView>>;
  /** Drop an imported credential, so the next connect signs in automatically. */
  useAutomaticSignIn(this: void, id: string): Promise<ProfileResult<RemoteProfileView>>;
  /**
   * Check the profile's machine before setting it up (#881): read only, nothing enrolled or
   * changed. Absent in builds without server setup.
   */
  inspectServer?(this: void, id: string): Promise<ProfileResult<ServerInspectionResultView>>;
  /**
   * Make the profile's machine a managed ORCA server, or verify and repair it (#881), then sign
   * in, exactly as confirmed (`inspectServer`'s confirmation, used once). Runs for minutes.
   */
  setUpServer?(
    this: void,
    id: string,
    confirmation: string,
    /**
     * `carryBundle: false`: a machine on the tailnet fetches and verifies the bundle itself instead
     * of this computer carrying it (#1234). Ignored for any other profile.
     */
    options?: { carryBundle?: boolean },
  ): Promise<ProfileResult<ServerSetupView>>;
  /** The machines on this computer's tailnet (#1226). `off` unless the `tailnet-hosts` flag is on. */
  tailnetMachines?(this: void): Promise<ProfileResult<TailnetMachinesView>>;
  /** Tailscale SSH waits for the person to approve a connection (#1228). */
  onLoginApproval?(this: void, listener: (approval: LoginApprovalView) => void): () => void;
  /** Open the approval page main last received for this profile, in the browser. */
  openLoginApproval?(this: void, id: string): Promise<ProfileResult<null>>;
  /** The agents on the profile's managed server (#1236). Absent unless the `tailnet-hosts` flag is on. */
  hostAgents?(this: void, id: string): Promise<ProfileResult<HostAgentView[]>>;
  /** The repositories pushes put on the profile's managed server (#1235). Absent unless `tailnet-hosts` is on. */
  hostRepositories?(this: void, id: string): Promise<ProfileResult<HostRepositoryView[]>>;
  /** Install the agent's pinned packages there from this computer; returns the server config that runs it. */
  installHostAgent?(this: void, id: string, agent: string): Promise<ProfileResult<{ settings: string }>>;
  /** Run the agent's own device-code sign-in there; resolves when it is signed in. */
  signInHostAgent?(this: void, id: string, agent: string): Promise<ProfileResult<null>>;
  /** An agent's sign-in waits for the person: the page to open and the code to enter. */
  onAgentSignIn?(this: void, listener: (prompt: AgentSignInView) => void): () => void;
  /** Open the sign-in page main last received for this profile and agent, in the browser. */
  openAgentSignIn?(this: void, id: string, agent: string, attempt: string): Promise<ProfileResult<null>>;
}
export interface DaemonConnectionBridge {
  read(this: void): DaemonTargetSnapshot;
  subscribe(this: void, listener: (target: DaemonTargetSnapshot) => void): () => void;
  show(this: void): void;
  onShow(this: void, listener: () => void): () => void;
  connect(this: void, target: DaemonConnectionRequest): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Absent in builds or tests without profile support. */
  profiles?: RemoteProfilesBridge;
  /** Absent in builds or tests without the Machines surface. */
  fleet?: FleetBridge;
  cancel(this: void): void;
  /** Called only after old surfaces have unmounted or the user discarded their drafts. */
  activate(this: void, epoch: number): void;
}

/* ---------- watched machines (#882) ---------- */

/** A run as a machine's section lists it: enough for a row, nothing it could act on. */
export interface FleetRun {
  id: string;
  name: string;
  status: DisplayStatus;
  waitingOn?: string;
  /** The engine's words for that wait, when it recorded some. */
  waitingDetail?: string;
  /**
   * The run's operations facts (#340, protocol 2.3): step counts, last activity and who holds
   * it. Absent from a daemon older than 2.3, which says nothing rather than zero.
   */
  operations?: Pick<RunOperationsView, "lastActivityAt" | "progress" | "owner">;
}
/** A waiting gate or permission ask on a machine. */
export interface FleetInput {
  id: string;
  tier: "permission" | "gate";
  runId: string;
  runName: string;
  question: string;
  requestedAt: string;
}
/** What a machine last said it was doing. */
export interface FleetWork {
  runs: FleetRun[];
  /** Every active run, which may be more than `runs` lists. */
  activeTotal: number;
  inputs: FleetInput[];
  /** `inputs.list`'s own count, never recounted. */
  waiting: number;
  /** The daemon's clock when it answered. */
  asOf: string;
}

export interface FleetMachine {
  /** `profile:<id>`, `bundled`, or the focused target's own key. */
  key: string;
  name: string;
  /** Where it is: `ssh <destination>`, "This computer", or a URL. */
  detail: string;
  focused: boolean;
  /** What `daemon.connect` is given to focus this machine. Absent: it cannot be focused from here. */
  request?: DaemonConnectionRequest;
  /** Whether the person chose to watch it (a profile), as opposed to the parked bundled daemon. */
  watched: boolean;
  state: ConnectionState;
  /** ISO 8601: when it last stopped being live, while it is not live. */
  staleSince?: string;
  /** Why it is not connected, when there is a sentence for it. */
  reason?: string;
  /** Absent until the machine has answered once: unknown, never zero. */
  work?: FleetWork;
  /** `hello.sessionSlots` (#873), when the daemon reports it. */
  slots?: SessionSlotsSummary;
}

export interface FleetSnapshot {
  machines: FleetMachine[];
}

/** The Machines surface's bridge: what every machine is doing, and which profiles are watched. */
export interface FleetBridge {
  read(this: void): FleetSnapshot;
  subscribe(this: void, listener: (snapshot: FleetSnapshot) => void): () => void;
  /** Start or stop watching a saved profile. Focusing one goes through `connect`. */
  watch(this: void, profileId: string, watched: boolean): Promise<ProfileResult<null>>;
  /**
   * Whether each profile bound to a tailnet node is online there (#1230), from this computer's
   * Tailscale client: read only while a listener is subscribed. A hint only; a machine's
   * connection state still comes from its SSH lease. Absent unless `tailnet-hosts` is on.
   */
  tailnetPresence?(this: void, listener: (snapshot: TailnetPresenceView) => void): () => void;
}

/** Tailnet presence by profile id (#1230). Empty when Tailscale is not running here. */
export type TailnetPresenceView = Record<
  string,
  | { kind: "online"; name: string }
  | { kind: "offline"; name: string; lastSeen?: string }
  | { kind: "gone" | "different-machine" }
>;

/** Never echo a rejected URL: it may contain a pasted credential. */
export function daemonEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter an HTTP or HTTPS daemon URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP or HTTPS URL without credentials, query parameters or fragments");
  }
  return url.href.replace(/\/$/, "");
}
