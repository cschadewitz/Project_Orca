/** Nonsecret target contract shared by main, preload and the connection dialog. */
export interface DaemonIdentity {
  workspaceId: string;
  instanceId: string;
}
export interface DaemonTargetSnapshot {
  epoch: number;
  url: string;
  source: "env" | "saved" | "bundled" | "development" | "store";
  identity?: DaemonIdentity;
  environmentOverride: boolean;
}
export interface DaemonConnectionBridge {
  read(this: void): DaemonTargetSnapshot;
  subscribe(this: void, listener: (target: DaemonTargetSnapshot) => void): () => void;
  show(this: void): void;
  onShow(this: void, listener: () => void): () => void;
  connect(this: void, url: string | null): Promise<{ ok: true } | { ok: false; message: string }>;
  cancel(this: void): void;
  /** Called only after old surfaces have unmounted or the user discarded their drafts. */
  activate(this: void, epoch: number): void;
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
