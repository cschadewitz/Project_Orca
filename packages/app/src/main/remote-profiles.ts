/**
 * Saved SSH connection profiles for remote daemons (#874), main process only.
 *
 * A profile is nonsecret typed fields (`user@host`, ports, key path, one jump host) and lives in
 * `<dir>/profiles.json`. Beside it, per profile: the pinned host key
 * (`known_hosts/<id>`) and the encrypted daemon credential (`credentials/<id>.credential`,
 * sealed with the OS keychain through `safeStorage`). The renderer sees only
 * `RemoteProfileView`: never the credential, never the pinned key material.
 *
 * The credential sets itself up (#875): the first connect without one has ORCA's command line
 * on the server issue it over the pinned SSH connection (`remote-credentials.ts`), an open
 * connection renews it before it expires, and removing the profile revokes it.
 *
 * Tunnels are shared per profile and reference counted, so a reconnect to the profile that
 * is already on screen reuses the open tunnel instead of starting a second ssh.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  ConnectionProfileSchema,
  CredentialSlots,
  forgetPin,
  pinState,
  profileIdFor,
  SshTunnel,
  type ConnectionProfile,
  type RemoteResult,
  type SecretCipher,
  type SshTunnelOptions,
  type TunnelState,
} from "@orca/protocol/remote-access";
import { CredentialTransportUnavailable, type DaemonTokenSource } from "../client/auth.js";
import { DaemonClient, DaemonClientError } from "../client/daemon-client.js";
import { streamTransport, type StreamTransport } from "../client/stream-transport.js";
import type { RemoteProfileView } from "../daemon-connection.js";
import { ConnectionRefusal } from "./connection-target.js";
import {
  CredentialRecords,
  CredentialSetupRefusal,
  DEFAULT_CREDENTIAL_POLICY,
  credentialRefusal,
  dueForRenewal,
  issueCommand,
  issuedFrom,
  principalFor,
  revokeCommand,
  rotateCommand,
  type CredentialPolicy,
  type CredentialRecord,
  type Issued,
} from "./remote-credentials.js";

const ProfilesFileSchema = z.object({ version: z.literal(1), profiles: z.array(ConnectionProfileSchema) }).strict();

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
  /** Checks the credential for renewal while the tunnel is open. */
  renewal?: ReturnType<typeof setInterval>;
}

/** What the daemon made of a credential: `unknown` when it could not be asked (no daemon, say). */
export type CredentialVerdict = "accepted" | "refused" | "unknown";

/** What became of the server's credential when its profile was removed. */
export type RevokeOutcome = "revoked" | "not-reached" | "none";

/** A server answer that means the credential is not live there any more: nothing left to revoke or renew. */
function alreadyGone(result: RemoteResult): boolean {
  return result.code !== 0 && result.serverLines.some((line) => /no live credential/.test(line));
}

export interface RemoteProfilesDeps {
  dir: string;
  cipher: SecretCipher;
  sshBinary?: string;
  /** Test seam over `new SshTunnel`. */
  tunnel?: (options: SshTunnelOptions) => SshTunnel;
  /** Tunnel state changes, for the console. Never carries ssh output. */
  onTunnelState?: (profileId: string, state: TunnelState) => void;
  /** Names this computer in the principal of issued credentials. Default: the OS host name. */
  hostname?: string;
  credentialPolicy?: CredentialPolicy;
  now?: () => number;
  /** Test seam: ask the daemon, over the tunnel's streams, whether it accepts `token`. */
  verify?: (connect: () => Duplex, url: string, token: string) => Promise<CredentialVerdict>;
}

/** Ask the daemon for `hello` with the token, over one of the tunnel's own streams. */
export async function helloVerdict(connect: () => Duplex, url: string, token: string): Promise<CredentialVerdict> {
  const transport = streamTransport(connect);
  try {
    await new DaemonClient(url, transport.fetch, { auth: { read: () => token, refresh: () => false } }).hello(
      "orca-app/sign-in",
      false,
    );
    return "accepted";
  } catch (error) {
    if (
      error instanceof DaemonClientError &&
      (error.error.code === "AUTH_INVALID" || error.error.code === "AUTH_REQUIRED")
    )
      return "refused";
    return "unknown";
  } finally {
    transport.close();
  }
}

export class RemoteProfiles {
  private readonly slots: CredentialSlots;
  private readonly records: CredentialRecords;
  private readonly tunnels = new Map<string, SharedTunnel>();
  /** One credential setup at a time per profile: concurrent connects share it. */
  private readonly setups = new Map<string, Promise<void>>();
  /** Bumped whenever a profile's stored credential changes, so leases drop their cached copy. */
  private readonly generations = new Map<string, number>();
  /** Profiles being removed: their revoke is on the way, nothing may connect meanwhile. */
  private readonly removing = new Set<string>();
  /** Bumped by every edit, removal and pin reset of a profile (in memory: pending work is too). */
  private readonly revisions = new Map<string, number>();
  private closed = false;

  constructor(private readonly deps: RemoteProfilesDeps) {
    this.slots = new CredentialSlots(join(deps.dir, "credentials"), deps.cipher);
    this.records = new CredentialRecords(join(deps.dir, "credentials"));
  }

  private get policy(): CredentialPolicy {
    return this.deps.credentialPolicy ?? DEFAULT_CREDENTIAL_POLICY;
  }
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private generation(id: string): number {
    return this.generations.get(id) ?? 0;
  }
  private forgetCredential(id: string): void {
    this.slots.remove(id);
    this.records.remove(id);
    this.generations.set(id, this.generation(id) + 1);
  }
  private tunnelOptions(profile: ConnectionProfile): SshTunnelOptions {
    return {
      profile,
      knownHostsFile: this.pins(profile.id),
      ...(this.deps.sshBinary ? { sshBinary: this.deps.sshBinary } : {}),
      onState: (state) => this.deps.onTunnelState?.(profile.id, state),
    };
  }
  private newTunnel(profile: ConnectionProfile): SshTunnel {
    return (this.deps.tunnel ?? ((options) => new SshTunnel(options)))(this.tunnelOptions(profile));
  }

  private get file(): string {
    return join(this.deps.dir, "profiles.json");
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
      ...(profile.serverCommand ? { serverCommand: profile.serverCommand } : {}),
      ...(profile.serverConfig ? { serverConfig: profile.serverConfig } : {}),
      ...(profile.readOnly ? { readOnly: true as const } : {}),
      hasCredential: this.slots.has(profile.id),
      ...this.credentialView(profile.id),
      ...this.pinView(profile),
    };
  }

  private credentialView(id: string): { credentialExpiresAt?: string; credentialImported?: true } {
    if (!this.slots.has(id)) return {};
    const record = this.records.read(id);
    if (!record) return { credentialImported: true };
    return record.expiresAt ? { credentialExpiresAt: record.expiresAt } : {};
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
      this.forgetCredential(id);
    } else if (
      existing &&
      (existing.serverCommand !== profile.serverCommand ||
        existing.serverConfig !== profile.serverConfig ||
        Boolean(existing.readOnly) !== Boolean(profile.readOnly))
    ) {
      // Same server, but the credential was issued under other settings (another preset or
      // workspace): the next connect issues a new one, and revokes this one when it can.
      this.retireCredential(id);
    }
    if (existing) this.bump(id);
    this.write(existing ? profiles.map((p) => (p.id === id ? profile : p)) : [...profiles, profile]);
    return this.view(profile);
  }

  /** Keep the credential's id for revoking later, and drop the credential itself. */
  private retireCredential(id: string): void {
    const record = this.records.read(id);
    const retired = record ? [record.credentialId, ...(record.retired ?? [])].slice(0, 16) : [];
    this.forgetCredential(id);
    // A record without a credential in the slot only carries what is left to revoke.
    if (record && retired.length) this.records.write(id, { ...record, retired });
  }

  /**
   * Delete the profile, its pinned key and its credential, after revoking the credential on
   * the server when it can be reached. Refused while the profile is in use.
   */
  async remove(id: string): Promise<RevokeOutcome> {
    if (this.tunnels.has(id) || this.setups.has(id) || this.removing.has(id))
      throw new ConnectionRefusal("Connect to another daemon before removing this profile.");
    const profile = this.get(id);
    if (!profile) return "none";
    this.removing.add(id);
    this.bump(id);
    try {
      const outcome = await this.revokeAll(profile);
      const profiles = this.read();
      this.forgetCredential(id);
      this.forgetPins(id);
      this.write(profiles.filter((p) => p.id !== id));
      return outcome;
    } finally {
      this.removing.delete(id);
    }
  }

  /** Revoke every credential ORCA issued for the profile, on its own short-lived ssh. */
  private async revokeAll(profile: ConnectionProfile): Promise<RevokeOutcome> {
    const record = this.records.read(profile.id);
    const ids = record ? [...new Set([record.credentialId, ...(record.retired ?? [])])] : [];
    if (!ids.length) return "none";
    // Only a server whose key is pinned ever got a credential: never trust a new key to revoke.
    if (pinState(this.pins(profile.id)) !== "pinned") return "not-reached";
    let outcome: RevokeOutcome = "revoked";
    for (const credentialId of ids) {
      try {
        const result = await this.newTunnel(profile).runOnce(revokeCommand(profile, credentialId));
        if (result.code !== 0 && !alreadyGone(result)) outcome = "not-reached";
      } catch {
        outcome = "not-reached";
      }
    }
    return outcome;
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
    if (this.removing.has(id)) throw new ConnectionRefusal("That profile is being removed.");
    let shared = this.tunnels.get(id);
    if (!shared || shared.tunnel.state.phase === "failed" || shared.tunnel.state.phase === "closed") {
      const tunnel = this.newTunnel(profile);
      shared = { tunnel, url: tunnel.open(), users: 0 };
      this.tunnels.set(id, shared);
    }
    const current = shared;
    current.users += 1;
    const revision = this.revision(id);
    let url: string;
    try {
      url = await current.url;
      // Sign in: issue, renew or replace the credential as needed, before anyone uses it.
      if (this.revision(id) === revision) await this.ensureCredential(id, current, url);
    } catch (error) {
      await this.releaseTunnel(id, current);
      throw error;
    }
    // Nothing that started before an edit, removal or pin reset may finish after it.
    if (this.revision(id) !== revision) {
      await this.releaseTunnel(id, current);
      throw new ConnectionRefusal("The profile changed while connecting. Connect again.");
    }
    this.watchRenewal(id, current, url);
    let released = false;
    const slots = this.slots;
    let cached: string | undefined;
    let cachedGeneration = -1;
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
          // A renewal replaces the credential: read the new one, never the revoked one.
          if (cachedGeneration !== this.generation(id)) {
            cached = slots.read(id);
            cachedGeneration = this.generation(id);
          }
          return cached;
        },
        refresh: () => {
          cachedGeneration = -1;
          return true;
        },
      },
      transport,
      remoteRefused: () => current.tunnel.remoteRefused(),
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
    if (shared.renewal) clearInterval(shared.renewal);
    await shared.tunnel.close();
  }

  /** Quit: stop every tunnel. */
  async close(): Promise<void> {
    this.closed = true;
    const all = [...this.tunnels.values()];
    this.tunnels.clear();
    for (const shared of all) if (shared.renewal) clearInterval(shared.renewal);
    await Promise.all(all.map((shared) => shared.tunnel.close()));
  }

  /** While the tunnel is open, renew its credential when it comes due. */
  private watchRenewal(id: string, shared: SharedTunnel, url: string): void {
    if (shared.renewal) return;
    shared.renewal = setInterval(() => {
      const record = this.records.read(id);
      if (!record || !this.slots.has(id) || !dueForRenewal(record, this.policy, this.now())) return;
      if (shared.tunnel.state.phase !== "open") return;
      this.ensureCredential(id, shared, url).catch(() => {
        // Never the server's output: the next check, or the next connect, tries again.
        console.warn(`The credential of SSH profile ${id} could not be renewed yet`);
      });
    }, this.policy.checkEveryMs);
    shared.renewal.unref?.();
  }

  /** Concurrent connects of one profile share a single setup, so the server issues one credential. */
  private ensureCredential(id: string, shared: SharedTunnel, url: string): Promise<void> {
    const running = this.setups.get(id);
    if (running) return running;
    const setup = this.setUpCredential(id, shared, url).finally(() => this.setups.delete(id));
    this.setups.set(id, setup);
    return setup;
  }

  private async setUpCredential(id: string, shared: SharedTunnel, url: string): Promise<void> {
    const profile = this.get(id);
    if (!profile) throw new ConnectionRefusal("That profile no longer exists.");
    const revision = this.revision(id);
    const run = async (command: string[]): Promise<RemoteResult> => {
      const result = await shared.tunnel.exec(command);
      // Nothing that started before an edit, removal or pin reset may write after it.
      if (this.revision(id) !== revision)
        throw new ConnectionRefusal("The profile changed while connecting. Connect again.");
      return result;
    };
    let fresh = false;
    let record = this.records.read(id);
    if (!this.slots.has(id)) {
      await this.issue(profile, run, record);
      fresh = true;
    } else if (record && dueForRenewal(record, this.policy, this.now())) {
      await this.renew(profile, run, record);
      fresh = true;
    }
    await this.revokeRetired(profile, run);
    if ((await this.verify(id, shared, url)) !== "refused") return;
    if (!fresh) {
      // Expired or revoked on the server: one new credential, then a clear refusal.
      record = this.records.read(id);
      try {
        await this.issue(profile, run, record);
      } catch (error) {
        if (error instanceof CredentialSetupRefusal && error.code === "cli-failed")
          throw credentialRefusal("credential-refused", profile);
        throw error;
      }
      await this.revokeRetired(profile, run);
      if ((await this.verify(id, shared, url)) !== "refused") return;
    }
    // The server's CLI issued a credential the daemon on this port does not know: another
    // workspace. Take it back rather than leave a live credential nobody uses.
    this.retireCredential(id);
    await this.revokeRetired(profile, run).catch(() => undefined);
    throw credentialRefusal("wrong-workspace", profile);
  }

  private verify(id: string, shared: SharedTunnel, url: string): Promise<CredentialVerdict> {
    const token = this.slots.read(id);
    if (!token) return Promise.resolve("refused");
    return (this.deps.verify ?? helloVerdict)(() => shared.tunnel.connect(), url, token);
  }

  /** A new credential from the server, into the slot; the one it replaces is kept for revoking. */
  private async issue(
    profile: ConnectionProfile,
    run: (command: string[]) => Promise<RemoteResult>,
    previous: CredentialRecord | undefined,
  ): Promise<void> {
    const principal = principalFor(this.deps.hostname ?? osHostname());
    const issued = issuedFrom(
      await run(issueCommand(profile, principal, new Date(this.now() + this.policy.ttlMs))),
      profile,
    );
    const retired = previous
      ? [...new Set([...(this.slots.has(profile.id) ? [previous.credentialId] : []), ...(previous.retired ?? [])])]
      : [];
    await this.store(profile, run, issued, principal, retired);
  }

  /** `auth rotate`: the same grants, a new secret and expiry; the server revokes the old one. */
  private async renew(
    profile: ConnectionProfile,
    run: (command: string[]) => Promise<RemoteResult>,
    record: CredentialRecord,
  ): Promise<void> {
    const result = await run(rotateCommand(profile, record.credentialId, new Date(this.now() + this.policy.ttlMs)));
    if (alreadyGone(result)) {
      // Revoked on the server meanwhile: nothing to rotate, so issue a new one.
      await this.issue(profile, run, record);
      return;
    }
    await this.store(profile, run, issuedFrom(result, profile), record.principal, record.retired ?? []);
  }

  private async store(
    profile: ConnectionProfile,
    run: (command: string[]) => Promise<RemoteResult>,
    issued: Issued,
    principal: string,
    retired: string[],
  ): Promise<void> {
    try {
      this.slots.write(profile.id, issued.token);
    } catch (error) {
      // No keychain: take the credential back on the server, and keep the token nowhere.
      await run(revokeCommand(profile, issued.credentialId)).catch(() => undefined);
      throw new ConnectionRefusal(error instanceof Error ? error.message : "The credential could not be stored.");
    }
    this.records.write(profile.id, {
      version: 1,
      credentialId: issued.credentialId,
      principal,
      ...(issued.expiresAt ? { expiresAt: issued.expiresAt } : {}),
      issuedAt: new Date(this.now()).toISOString(),
      ...(retired.length ? { retired: retired.slice(0, 16) } : {}),
    });
    this.generations.set(profile.id, this.generation(profile.id) + 1);
  }

  /** Revoke credentials issued under replaced settings. Kept for later when the server cannot say. */
  private async revokeRetired(
    profile: ConnectionProfile,
    run: (command: string[]) => Promise<RemoteResult>,
  ): Promise<void> {
    const record = this.records.read(profile.id);
    if (!record?.retired?.length) return;
    const left: string[] = [];
    for (const credentialId of record.retired) {
      try {
        const result = await run(revokeCommand(profile, credentialId));
        if (result.code !== 0 && !alreadyGone(result)) left.push(credentialId);
      } catch {
        left.push(credentialId);
      }
    }
    const { retired: _dropped, ...rest } = this.records.read(profile.id) ?? record;
    this.records.write(profile.id, { ...rest, ...(left.length ? { retired: left } : {}) });
  }
}
