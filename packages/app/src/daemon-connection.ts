/** Nonsecret target contract shared by main, preload and the connection dialog. */
import type { ConnectionState } from "@orca/design";
import type { DisplayStatus, SessionSlotsSummary } from "@orca/protocol";

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
  hasCredential: boolean;
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
}

/** A URL, the bundled daemon (`null`), or a saved profile. */
export type DaemonConnectionRequest = string | null | { profile: string };

export type ProfileResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** Profile management. Every call is main-process work; secrets never cross this bridge. */
export interface RemoteProfilesBridge {
  list(this: void): Promise<RemoteProfileView[]>;
  save(this: void, input: RemoteProfileInput): Promise<ProfileResult<RemoteProfileView>>;
  remove(this: void, id: string): Promise<ProfileResult<null>>;
  /** Main opens a file picker, reads and seals the credential; nothing comes back but the view. */
  importCredential(this: void, id: string): Promise<ProfileResult<RemoteProfileView | null>>;
  forgetHostKey(this: void, id: string): Promise<ProfileResult<RemoteProfileView>>;
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
}

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
