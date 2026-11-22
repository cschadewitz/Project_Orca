/**
 * Saved SSH connection profiles for remote daemons (#874), main process only.
 *
 * A profile is nonsecret typed fields (`user@host`, ports, key path, one jump host) and lives in
 * `<dir>/profiles.json`. Beside it, per profile: the pinned host key
 * (`known_hosts/<id>`) and the encrypted daemon credential (`credentials/<id>.credential`,
 * sealed with the OS keychain through `safeStorage`). The renderer sees only
 * `RemoteProfileView`: never the credential, never the pinned key material.
 *
 * Tunnels are shared per profile and reference counted, so a reconnect to the profile that
 * is already on screen reuses the open tunnel instead of starting a second ssh.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ServerPathSchema } from "@orca/protocol";
import {
  ConnectionProfileSchema,
  CredentialSlots,
  forgetPin,
  pinState,
  profileIdFor,
  SshTunnel,
  TunnelRefusal,
  type ConnectionProfile,
  type RemoteCommand,
  type SecretCipher,
  type SshTunnelOptions,
  type TunnelState,
} from "@orca/protocol/remote-access";
import { CredentialTransportUnavailable, type DaemonTokenSource } from "../client/auth.js";
import { streamTransport, type StreamTransport } from "../client/stream-transport.js";
import type { RemoteProfileView } from "../daemon-connection.js";
import { ConnectionRefusal } from "./connection-target.js";

const ProfilesFileSchema = z.object({ version: z.literal(1), profiles: z.array(ConnectionProfileSchema) }).strict();

/**
 * The server updater a person approved for a profile (#879): where it is on that server. The
 * app runs only an approved updater; a daemon's `hello.deployment` is a hint that must match.
 */
export const ServerUpdaterApprovalSchema = z.object({ adapter: ServerPathSchema, manifest: ServerPathSchema }).strict();
export type ServerUpdaterApproval = z.infer<typeof ServerUpdaterApprovalSchema>;
const ApprovalsFileSchema = z
  .object({ version: z.literal(1), approvals: z.record(z.string(), ServerUpdaterApprovalSchema) })
  .strict();

/** What the connect dialog sends to create or edit a profile. `id` absent creates. */
export const RemoteProfileInputSchema = ConnectionProfileSchema.omit({ id: true })
  .extend({ id: ConnectionProfileSchema.shape.id.optional() })
  .strict();

/** One profile's tunnel and credential, held while a client uses them. */
export interface ProfileLease {
  readonly profile: ConnectionProfile;
  readonly url: string;
  readonly auth: DaemonTokenSource;
  /**
   * The only way the client reaches the daemon: each connection is its own authenticated
   * ssh stream, refused once the lease is released or the profile changed.
   */
  readonly transport: StreamTransport;
  /** The remote refused the forwarded connection just now: ssh works, no daemon listens. */
  remoteRefused(): boolean;
  /**
   * Run one command on the server over this profile's own ssh: the pinned host key, the
   * person's key, no forwards (#879). Refused like `transport` once the lease is released
   * or the profile changed.
   */
  exec(command: readonly string[], onLine: (stream: "stdout" | "stderr", line: string) => void): RemoteCommand;
  /** The server's host key as this tunnel authenticated it (`SHA256:…`), once it has. */
  hostKey(): string | undefined;
  release(): Promise<void>;
}

/**
 * What a pending import was started against. The file picker can stay open for minutes;
 * the credential is written only if the profile is still that one (same revision, same
 * destination), never into a profile that was edited, removed or reset meanwhile.
 */
export interface ProfileTicket {
  readonly id: string;
  readonly revision: number;
  readonly destination: string;
}

interface SharedTunnel {
  tunnel: SshTunnel;
  url: Promise<string>;
  users: number;
}

export interface RemoteProfilesDeps {
  dir: string;
  cipher: SecretCipher;
  sshBinary?: string;
  /** Test seam over `new SshTunnel`. */
  tunnel?: (options: SshTunnelOptions) => SshTunnel;
  /** Tunnel state changes, for the console. Never carries ssh output. */
  onTunnelState?: (profileId: string, state: TunnelState) => void;
}

export class RemoteProfiles {
  private readonly slots: CredentialSlots;
  private readonly tunnels = new Map<string, SharedTunnel>();
  /** Bumped by every edit, removal and pin reset of a profile (in memory: pending work is too). */
  private readonly revisions = new Map<string, number>();
  private closed = false;

  constructor(private readonly deps: RemoteProfilesDeps) {
    this.slots = new CredentialSlots(join(deps.dir, "credentials"), deps.cipher);
  }

  private get file(): string {
    return join(this.deps.dir, "profiles.json");
  }
  private get approvalsFile(): string {
    return join(this.deps.dir, "server-updaters.json");
  }
  private approvals(): Record<string, ServerUpdaterApproval> {
    try {
      const parsed = ApprovalsFileSchema.safeParse(JSON.parse(readFileSync(this.approvalsFile, "utf8")));
      if (parsed.success) return parsed.data.approvals;
    } catch {
      // Missing or unreadable: nothing is approved, which only means the app asks again.
    }
    return {};
  }
  private writeApprovals(approvals: Record<string, ServerUpdaterApproval>): void {
    mkdirSync(this.deps.dir, { recursive: true });
    const tmp = `${this.approvalsFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, approvals }, null, 2)}\n`);
    renameSync(tmp, this.approvalsFile);
  }

  /** The server updater approved for this profile, if any (#879). */
  serverUpdater(id: string): ServerUpdaterApproval | undefined {
    return this.get(id) ? this.approvals()[id] : undefined;
  }

  /** Record what the person approved. It lasts until the profile points elsewhere or its key is reset. */
  approveServerUpdater(id: string, approval: ServerUpdaterApproval): void {
    if (!this.get(id)) throw new ConnectionRefusal("That profile no longer exists.");
    const parsed = ServerUpdaterApprovalSchema.parse(approval);
    this.writeApprovals({ ...this.approvals(), [id]: parsed });
  }

  private forgetServerUpdater(id: string): void {
    const approvals = this.approvals();
    if (!(id in approvals)) return;
    delete approvals[id];
    this.writeApprovals(approvals);
  }

  private pins(id: string): string {
    return join(this.deps.dir, "known_hosts", id);
  }

  private revision(id: string): number {
    return this.revisions.get(id) ?? 0;
  }
  private bump(id: string): void {
    this.revisions.set(id, this.revision(id) + 1);
  }

  private read(): ConnectionProfile[] {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed = ProfilesFileSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data.profiles;
    } catch {
      // Fall through: an unreadable file is no profiles, never a crash.
    }
    console.warn("Ignoring invalid remote daemon profiles");
    return [];
  }

  private write(profiles: ConnectionProfile[]): void {
    mkdirSync(this.deps.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`);
    renameSync(tmp, this.file);
  }

  private view(profile: ConnectionProfile): RemoteProfileView {
    return {
      id: profile.id,
      name: profile.name,
      destination: profile.destination,
      ...(profile.sshPort ? { sshPort: profile.sshPort } : {}),
      ...(profile.identityFile ? { identityFile: profile.identityFile } : {}),
      ...(profile.jump
        ? {
            jump: {
              destination: profile.jump.destination,
              ...(profile.jump.sshPort ? { sshPort: profile.jump.sshPort } : {}),
              ...(profile.jump.identityFile ? { identityFile: profile.jump.identityFile } : {}),
            },
          }
        : {}),
      remotePort: profile.remotePort,
      hasCredential: this.slots.has(profile.id),
      ...this.pinView(profile),
    };
  }

  private pinView(profile: ConnectionProfile): { hostKeyPinned: boolean; hostKeyMissing?: true } {
    const states = [
      pinState(this.pins(profile.id)),
      ...(profile.jump ? [pinState(`${this.pins(profile.id)}.jump`)] : []),
    ];
    return {
      hostKeyPinned: states.every((state) => state === "pinned"),
      ...(states.includes("broken") ? { hostKeyMissing: true as const } : {}),
    };
  }

  list(): RemoteProfileView[] {
    return this.read().map((profile) => this.view(profile));
  }

  get(id: string): ConnectionProfile | undefined {
    return this.read().find((profile) => profile.id === id);
  }

  describe(id: string): RemoteProfileView | undefined {
    const profile = this.get(id);
    return profile && this.view(profile);
  }

  /** Create or edit. Changing where a profile points forgets its pinned key and its credential. */
  save(input: unknown): RemoteProfileView {
    const parsed = RemoteProfileInputSchema.safeParse(input);
    if (!parsed.success) throw new ConnectionRefusal(parsed.error.issues[0]?.message ?? "Invalid profile");
    const profiles = this.read();
    const { id: requested, ...fields } = parsed.data;
    const id = requested ?? profileIdFor(fields.name, new Set(profiles.map((p) => p.id)));
    const existing = profiles.find((p) => p.id === id);
    if (requested && !existing) throw new ConnectionRefusal("That profile no longer exists.");
    if (existing && this.tunnels.has(id))
      throw new ConnectionRefusal("Connect to another daemon before editing the profile in use.");
    const profile = ConnectionProfileSchema.parse({ ...fields, id });
    if (
      existing &&
      (existing.destination !== profile.destination ||
        existing.sshPort !== profile.sshPort ||
        existing.remotePort !== profile.remotePort ||
        existing.jump?.destination !== profile.jump?.destination ||
        existing.jump?.sshPort !== profile.jump?.sshPort)
    ) {
      // Another server, or another daemon on it: the old key and credential belong to that one.
      this.forgetPins(id);
      this.slots.remove(id);
      this.forgetServerUpdater(id);
    }
    if (existing) this.bump(id);
    this.write(existing ? profiles.map((p) => (p.id === id ? profile : p)) : [...profiles, profile]);
    return this.view(profile);
  }

  /** Delete the profile, its pinned key and its credential. Refused while it is in use. */
  remove(id: string): void {
    if (this.tunnels.has(id)) throw new ConnectionRefusal("Connect to another daemon before removing this profile.");
    const profiles = this.read();
    if (!profiles.some((p) => p.id === id)) return;
    this.bump(id);
    this.slots.remove(id);
    this.forgetPins(id);
    this.forgetServerUpdater(id);
    this.write(profiles.filter((p) => p.id !== id));
  }

  /** Pin what an import is about to be for, before anything slow (a file picker) runs. */
  ticket(id: string): ProfileTicket {
    const profile = this.get(id);
    if (!profile) throw new ConnectionRefusal("That profile no longer exists.");
    return { id, revision: this.revision(id), destination: profile.destination };
  }

  /**
   * Store a credential for the profile. The token is validated and sealed; it is never
   * returned. With a ticket, refused unless the profile is still the one the ticket names.
   */
  importCredential(id: string, token: string, ticket?: ProfileTicket): RemoteProfileView {
    const profile = this.get(id);
    if (!profile) throw new ConnectionRefusal("That profile no longer exists.");
    if (
      ticket &&
      (ticket.id !== id || ticket.revision !== this.revision(id) || ticket.destination !== profile.destination)
    )
      throw new ConnectionRefusal("The profile changed while the credential was being chosen. Import it again.");
    try {
      this.slots.write(id, token);
    } catch (error) {
      throw new ConnectionRefusal(error instanceof Error ? error.message : "The credential could not be stored.");
    }
    return this.view(profile);
  }

  /**
   * For a server whose key changed on purpose, or a pin that went missing: the next connect
   * pins whatever it presents. Refused while a tunnel of the profile is starting or open,
   * so a connect in flight cannot enroll a key the person did not ask to reset for.
   */
  forgetHostKey(id: string): void {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new ConnectionRefusal("Invalid profile");
    const shared = this.tunnels.get(id);
    if (shared && shared.tunnel.state.phase !== "failed" && shared.tunnel.state.phase !== "closed")
      throw new ConnectionRefusal("Connect to another daemon before forgetting this profile's host key.");
    this.bump(id);
    this.forgetPins(id);
    // Another key may be another server: what was approved on the old one is not carried over.
    this.forgetServerUpdater(id);
  }

  private forgetPins(id: string): void {
    forgetPin(this.pins(id));
    forgetPin(`${this.pins(id)}.jump`);
  }

  /** Open (or share) the profile's tunnel and hand out its credential source. */
  async open(id: string): Promise<ProfileLease> {
    if (this.closed) throw new ConnectionRefusal("The app is closing.");
    const profile = this.get(id);
    if (!profile) throw new ConnectionRefusal("That profile no longer exists.");
    if (!this.slots.has(id))
      throw new ConnectionRefusal(
        `No credential is stored for ${profile.name}. Import one with "Import credential…" in the connection dialog.`,
      );
    let shared = this.tunnels.get(id);
    if (!shared || shared.tunnel.state.phase === "failed" || shared.tunnel.state.phase === "closed") {
      const tunnel = (this.deps.tunnel ?? ((options) => new SshTunnel(options)))({
        profile,
        knownHostsFile: this.pins(id),
        ...(this.deps.sshBinary ? { sshBinary: this.deps.sshBinary } : {}),
        onState: (state) => this.deps.onTunnelState?.(id, state),
      });
      shared = { tunnel, url: tunnel.open(), users: 0 };
      this.tunnels.set(id, shared);
    }
    const current = shared;
    current.users += 1;
    const revision = this.revision(id);
    let url: string;
    try {
      url = await current.url;
    } catch (error) {
      await this.releaseTunnel(id, current);
      throw error;
    }
    // Nothing that started before an edit, removal or pin reset may finish after it.
    if (this.revision(id) !== revision) {
      await this.releaseTunnel(id, current);
      throw new ConnectionRefusal("The profile changed while connecting. Connect again.");
    }
    let released = false;
    const slots = this.slots;
    let cached: string | undefined;
    // Nothing of this lease outlives its release or a change to the profile.
    const usable = () => !released && this.revision(id) === revision;
    const transport = streamTransport(() => {
      if (!usable()) throw new CredentialTransportUnavailable();
      return current.tunnel.connect();
    });
    return {
      profile,
      url,
      // The credential only ever travels on `transport`: every connection is its own
      // authenticated ssh stream, so it goes to the pinned server or nowhere. Reads stop
      // once the tunnel has failed for good, the lease is released or the profile changed.
      auth: {
        read: () => {
          const phase = current.tunnel.state.phase;
          if (!usable() || phase === "failed" || phase === "closed") throw new CredentialTransportUnavailable();
          return (cached ??= slots.read(id));
        },
        refresh: () => {
          cached = undefined;
          return true;
        },
      },
      transport,
      remoteRefused: () => current.tunnel.remoteRefused(),
      exec: (command, onLine) => {
        if (!usable()) throw new TunnelRefusal("closed");
        return current.tunnel.exec(command, onLine);
      },
      hostKey: () => current.tunnel.hostKeyFingerprint,
      release: async () => {
        if (released) return;
        released = true;
        transport.close();
        await this.releaseTunnel(id, current);
      },
    };
  }

  private async releaseTunnel(id: string, shared: SharedTunnel): Promise<void> {
    shared.users -= 1;
    if (shared.users > 0) return;
    if (this.tunnels.get(id) === shared) this.tunnels.delete(id);
    await shared.tunnel.close();
  }

  /** Quit: stop every tunnel. */
  async close(): Promise<void> {
    this.closed = true;
    const all = [...this.tunnels.values()];
    this.tunnels.clear();
    await Promise.all(all.map((shared) => shared.tunnel.close()));
  }
}
