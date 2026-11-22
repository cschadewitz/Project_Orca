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
  pinnedKeyIdentity,
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
  installationId,
  serverKey,
  StrayCredential,
  tokenCredentialId,
  targetOf,
  type CredentialEntry,
  type CredentialPolicy,
  type IssuedEntry,
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

/** The daemon's answer, and on acceptance which workspace gave it. */
export interface HelloAnswer {
  verdict: CredentialVerdict;
  workspaceId?: string | undefined;
}

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
  /** Test seam: this installation's id. Default: made once and kept in `<dir>/installation.json`. */
  installationId?: string;
  credentialPolicy?: CredentialPolicy;
  now?: () => number;
  /** Test seam: ask the daemon, over the tunnel's streams, whether it accepts `token`. */
  verify?: (connect: () => Duplex, url: string, token: string) => Promise<HelloAnswer>;
}

/** Ask the daemon for `hello` with the token, over one of the tunnel's own streams. */
export async function helloVerdict(connect: () => Duplex, url: string, token: string): Promise<HelloAnswer> {
  const transport = streamTransport(connect);
  try {
    const hello = await new DaemonClient(url, transport.fetch, {
      auth: { read: () => token, refresh: () => false },
    }).hello("orca-app/sign-in", false);
    return { verdict: "accepted", workspaceId: hello.identity?.workspaceId };
  } catch (error) {
    if (
      error instanceof DaemonClientError &&
      (error.error.code === "AUTH_INVALID" || error.error.code === "AUTH_REQUIRED")
    )
      return { verdict: "refused" };
    return { verdict: "unknown" };
  } finally {
    transport.close();
  }
}

export class RemoteProfiles {
  private readonly slots: CredentialSlots;
  /** A new credential waits here until the daemon has accepted it. */
  private readonly nextSlots: CredentialSlots;
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
    this.nextSlots = new CredentialSlots(join(deps.dir, "credentials", "next"), deps.cipher);
    this.records = new CredentialRecords(join(deps.dir, "credentials"));
  }

  private installationNow: string | undefined;
  /** This installation's durable id, which names it in every principal it is issued. */
  private get installation(): string {
    return (this.installationNow ??= this.deps.installationId ?? installationId(this.deps.dir));
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
  private tunnelOptions(profile: ConnectionProfile): SshTunnelOptions {
    return {
      profile,
      knownHostsFile: this.pins(profile.id),
      ...(this.deps.sshBinary ? { sshBinary: this.deps.sshBinary } : {}),
      onState: (state) => this.deps.onTunnelState?.(profile.id, state),
    };
  }
  /** `pinnedOnly`: an administrative connection, which never trusts a key on first use. */
  private newTunnel(profile: ConnectionProfile, pinnedOnly = false): SshTunnel {
    return (this.deps.tunnel ?? ((options) => new SshTunnel(options)))({
      ...this.tunnelOptions(profile),
      ...(pinnedOnly ? { pinnedOnly: true } : {}),
    });
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

  private credentialView(id: string): {
    credentialExpiresAt?: string;
    credentialImported?: true;
    pendingRevocations?: number;
  } {
    const record = this.records.read(id);
    const pending = record?.retired?.length ?? 0;
    return {
      ...(this.slots.has(id) && !record?.current ? { credentialImported: true as const } : {}),
      ...(this.slots.has(id) && record?.current?.expiresAt ? { credentialExpiresAt: record.current.expiresAt } : {}),
      ...(pending ? { pendingRevocations: pending } : {}),
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

  /**
   * Create or edit. Pointing a profile at another server forgets its pinned keys and moves
   * its credentials to the list still to revoke; so does changing the server command,
   * workspace config or preset, since the credential was issued under the old ones.
   */
  save(input: unknown): RemoteProfileView {
    const parsed = RemoteProfileInputSchema.safeParse(input);
    if (!parsed.success) throw new ConnectionRefusal(parsed.error.issues[0]?.message ?? "Invalid profile");
    const profiles = this.read();
    const { id: requested, ...fields } = parsed.data;
    const id = requested ?? profileIdFor(fields.name, new Set(profiles.map((p) => p.id)));
    const existing = profiles.find((p) => p.id === id);
    if (requested && !existing) throw new ConnectionRefusal("That profile no longer exists.");
    if (existing) this.assertIdle(id, "editing");
    const profile = ConnectionProfileSchema.parse({ ...fields, id });
    if (existing) {
      const otherServer = serverKey(existing) !== serverKey(profile) || existing.remotePort !== profile.remotePort;
      const otherIssue =
        existing.serverCommand !== profile.serverCommand ||
        existing.serverConfig !== profile.serverConfig ||
        Boolean(existing.readOnly) !== Boolean(profile.readOnly);
      // The old credentials keep where they were issued, so they are revoked there, not here.
      if (otherServer || otherIssue) this.retireCredentials(id, otherServer ? "drop" : "keep");
      if (otherServer) this.forgetPins(id);
      this.bump(id);
    }
    this.write(existing ? profiles.map((p) => (p.id === id ? profile : p)) : [...profiles, profile]);
    return this.view(profile);
  }

  /**
   * Nothing may change a profile while it is connected, signing in, or being removed: each of
   * those runs against the profile as it was when it started.
   */
  private assertIdle(id: string, what: "editing" | "removing" | "importing" | "resetting"): void {
    if (this.removing.has(id)) throw new ConnectionRefusal("That profile is being removed.");
    if (this.tunnels.has(id) || this.setups.has(id)) {
      const verb = {
        editing: "editing",
        removing: "removing",
        importing: "importing a credential for",
        resetting: "resetting",
      }[what];
      throw new ConnectionRefusal(`Connect to another daemon before ${verb} this profile.`);
    }
  }

  /**
   * Move the profile's ORCA-issued credentials (current and staged) to the list still to
   * revoke, each with where it was issued, and empty the slots. An imported credential is
   * the person's: dropped from the slot only when it no longer fits the profile.
   */
  private retireCredentials(id: string, imported: "drop" | "keep" | "reauthorize"): void {
    const record = this.records.read(id);
    const issued = [record?.current, record?.next].filter((entry): entry is IssuedEntry => entry !== undefined);
    const retired = [
      ...(record?.retired ?? []),
      ...issued.map(({ credentialId, target }) => ({ credentialId, target })),
    ].slice(-64);
    const hasImport = this.slots.has(id) && !record?.current;
    const keep = hasImport && imported !== "drop";
    if (!keep) this.slots.remove(id);
    this.nextSlots.remove(id);
    const importState = keep
      ? { imported: { ...record?.imported, ...(imported === "reauthorize" ? { reauthorize: true as const } : {}) } }
      : {};
    if (retired.length || keep)
      this.records.write(id, { version: 1, ...(retired.length ? { retired } : {}), ...importState });
    else this.records.remove(id);
    this.generations.set(id, this.generation(id) + 1);
  }

  /**
   * Delete the profile, its pinned key and its credential, after revoking every credential
   * ORCA issued for it where it was issued, as far as the pinned server can be reached.
   * Refused while the profile is in use; nothing may edit or connect it meanwhile.
   */
  async remove(id: string): Promise<RevokeOutcome> {
    this.assertIdle(id, "removing");
    const profile = this.get(id);
    if (!profile) return "none";
    this.removing.add(id);
    this.bump(id);
    try {
      this.retireCredentials(id, "drop");
      const left = await this.revokeRetired(profile, (command) => this.newTunnel(profile, true).runOnce(command));
      const outcome: RevokeOutcome = left === undefined ? "none" : left.length ? "not-reached" : "revoked";
      const profiles = this.read();
      this.slots.remove(id);
      this.nextSlots.remove(id);
      this.records.remove(id);
      this.forgetPins(id);
      this.write(profiles.filter((p) => p.id !== id));
      return outcome;
    } finally {
      this.removing.delete(id);
    }
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
   * A credential ORCA had issued moves to the list still to revoke; the import is never
   * renewed, replaced or revoked by ORCA.
   */
  importCredential(id: string, token: string, ticket?: ProfileTicket): RemoteProfileView {
    const profile = this.get(id);
    if (!profile) throw new ConnectionRefusal("That profile no longer exists.");
    if (
      ticket &&
      (ticket.id !== id || ticket.revision !== this.revision(id) || ticket.destination !== profile.destination)
    )
      throw new ConnectionRefusal("The profile changed while the credential was being chosen. Import it again.");
    this.assertIdle(id, "importing");
    try {
      this.slots.write(id, token);
    } catch (error) {
      throw new ConnectionRefusal(error instanceof Error ? error.message : "The credential could not be stored.");
    }
    // The slot holds the import now; what ORCA issued before is only still to revoke. The
    // import is bound to the host keys it is first accepted through.
    const record = this.records.read(id);
    const retired = [
      ...(record?.retired ?? []),
      ...[record?.current, record?.next]
        .filter((entry): entry is IssuedEntry => entry !== undefined)
        .map(({ credentialId, target }) => ({ credentialId, target })),
    ].slice(-64);
    this.nextSlots.remove(id);
    this.records.write(id, { version: 1, ...(retired.length ? { retired } : {}), imported: {} });
    this.generations.set(id, this.generation(id) + 1);
    return this.view(profile);
  }

  /** Drop an imported credential, so the next connect signs in automatically. */
  useAutomaticSignIn(id: string): RemoteProfileView {
    const profile = this.get(id);
    if (!profile) throw new ConnectionRefusal("That profile no longer exists.");
    this.assertIdle(id, "resetting");
    const record = this.records.read(id);
    if (!record?.current) {
      this.slots.remove(id);
      if (record) {
        const { imported: _dropped, ...rest } = record;
        if (rest.retired?.length || rest.next) this.records.write(id, rest);
        else this.records.remove(id);
      }
      this.generations.set(id, this.generation(id) + 1);
    }
    return this.view(profile);
  }

  /**
   * For a server whose key changed on purpose, or a pin that went missing: the next connect
   * pins whatever it presents. Refused while a tunnel of the profile is starting or open,
   * or while it is being removed, so nothing in flight can enroll a key the person did not
   * ask to reset for.
   */
  forgetHostKey(id: string): void {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new ConnectionRefusal("Invalid profile");
    if (this.removing.has(id)) throw new ConnectionRefusal("That profile is being removed.");
    const shared = this.tunnels.get(id);
    if (
      this.setups.has(id) ||
      (shared && shared.tunnel.state.phase !== "failed" && shared.tunnel.state.phase !== "closed")
    )
      throw new ConnectionRefusal("Connect to another daemon before forgetting this profile's host key.");
    this.bump(id);
    // The credentials belong to the server behind the old key: never sent to whatever
    // answers under a new one. ORCA's go on the list to revoke (through the old key only);
    // an import waits for the person to authorize it again.
    this.retireCredentials(id, "reauthorize");
    this.forgetPins(id);
  }

  /** The host keys the profile's pins vouch for now (server, and jump host). */
  private hostKeys(profile: ConnectionProfile): string {
    return JSON.stringify([
      pinnedKeyIdentity(this.pins(profile.id)) ?? null,
      profile.jump ? (pinnedKeyIdentity(`${this.pins(profile.id)}.jump`) ?? null) : null,
    ]);
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
      const current = this.records.read(id)?.current;
      if (!current || !this.slots.has(id) || !dueForRenewal(current, this.policy, this.now())) return;
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

  /**
   * Make sure the slot holds a credential the daemon accepts, issuing one if needed. A new
   * credential is staged first and switches in only once the daemon has accepted it; the one
   * it replaces is revoked after that. A daemon that cannot be asked (`unknown`) switches
   * nothing: the staged one waits for the next connect.
   */
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
    const ask = (token: string) => (this.deps.verify ?? helloVerdict)(() => shared.tunnel.connect(), url, token);

    // Credentials are bound to the host keys they were issued through. Any issued through
    // keys the pins no longer hold are quarantined: never sent here, revoked only there.
    const keys = this.hostKeys(profile);
    const bound = this.records.read(id);
    if (
      (bound?.current && bound.current.target.hostKeys !== keys) ||
      (bound?.next && bound.next.target.hostKeys !== keys)
    )
      this.retireCredentials(id, "keep");

    // A replacement staged by an earlier connect: switch to it, or take it back.
    if (this.records.read(id)?.next) {
      const outcome = await this.settleNext(profile, run, ask);
      if (outcome === "promoted") return;
    }
    let record = this.records.read(id);
    if (!this.slots.has(id)) {
      if (!record?.next) {
        await this.stage(profile, run);
        await this.settleNext(profile, run, ask);
      }
      return;
    }
    if (!record?.current) {
      // Imported: kept as it is, and sent only through the host keys it was first accepted
      // through. Refused, or its server's key reset, it is the person's to act on, never ORCA's.
      const imported = record?.imported;
      if (imported?.reauthorize || (imported?.hostKeys !== undefined && imported.hostKeys !== keys))
        throw credentialRefusal("imported-reauthorize", profile);
      const token = this.slots.read(id);
      const answer = token ? await ask(token) : { verdict: "unknown" as const };
      if (answer.verdict === "refused") throw credentialRefusal("imported-refused", profile);
      if (answer.verdict === "accepted") {
        const latest = this.records.read(id);
        if (!latest?.imported?.hostKeys)
          this.records.write(id, { ...(latest ?? { version: 1 as const }), imported: { hostKeys: keys } });
        // What ORCA had issued before the import is still revoked where it came from.
        await this.revokeRetired(profile, run);
      }
      return;
    }
    if (dueForRenewal(record.current, this.policy, this.now()) && !record.next) {
      try {
        await this.stage(profile, run);
        if ((await this.settleNext(profile, run, ask)) === "promoted") return;
      } catch (error) {
        // A renewal that fails leaves the current credential in place while it is still valid.
        const expiresAt = record.current.expiresAt;
        if (!expiresAt || Date.parse(expiresAt) <= this.now()) throw error;
        if (error instanceof CredentialSetupRefusal && error.code === "wrong-workspace") throw error;
      }
    }
    record = this.records.read(id)!;
    const token = this.slots.read(id);
    const answer = token ? await ask(token) : { verdict: "refused" as const };
    if (answer.verdict === "accepted") {
      // The daemon must say which workspace it is, and be the one this credential is bound to.
      if (!answer.workspaceId) throw credentialRefusal("unverified", profile);
      if (record.current && record.current.workspaceId !== answer.workspaceId)
        throw credentialRefusal("wrong-workspace", profile);
      await this.revokeRetired(profile, run);
      return;
    }
    if (answer.verdict === "unknown") return;
    // Refused (expired or revoked on the server): one replacement, then a clear refusal.
    if (!record.next) {
      try {
        await this.stage(profile, run);
      } catch (error) {
        if (error instanceof CredentialSetupRefusal && error.code === "cli-failed")
          throw credentialRefusal("credential-refused", profile);
        throw error;
      }
    }
    if ((await this.settleNext(profile, run, ask)) !== "promoted")
      throw credentialRefusal("credential-refused", profile);
  }

  /**
   * Issue a credential into the staging slot. It is durable (token sealed, id and target on
   * record) before anything uses it; if it cannot be kept, it is taken back on the server.
   */
  private async stage(profile: ConnectionProfile, run: (command: string[]) => Promise<RemoteResult>): Promise<void> {
    const keys = this.hostKeys(profile);
    const principal = principalFor(this.deps.hostname ?? osHostname(), this.installation);
    const result = await run(issueCommand(profile, principal, new Date(this.now() + this.policy.ttlMs)));
    let issued: Issued;
    try {
      issued = issuedFrom(result, profile, principal);
    } catch (error) {
      if (error instanceof StrayCredential) {
        await run(revokeCommand(targetOf(profile, keys), error.credentialId)).catch(() => undefined);
        throw credentialRefusal("cli-failed", profile);
      }
      throw error;
    }
    const entry: IssuedEntry = {
      credentialId: issued.credentialId,
      target: targetOf(profile, keys),
      principal,
      ...(issued.expiresAt ? { expiresAt: issued.expiresAt } : {}),
      issuedAt: new Date(this.now()).toISOString(),
    };
    try {
      this.nextSlots.write(profile.id, issued.token);
      const record = this.records.read(profile.id) ?? { version: 1 as const };
      this.records.write(profile.id, { ...record, next: entry });
    } catch {
      this.nextSlots.remove(profile.id);
      // Not kept: take it back now, or remember to.
      const revoked = await run(revokeCommand(entry.target, entry.credentialId)).then(
        (r) => r.code === 0 || alreadyGone(r),
        () => false,
      );
      if (!revoked) this.remember(profile.id, entry);
      throw credentialRefusal("store-failed", profile);
    }
  }

  /** Add an entry to the list still to revoke, best effort: the record may be what failed. */
  private remember(id: string, entry: CredentialEntry): void {
    try {
      const record = this.records.read(id) ?? { version: 1 as const };
      const { next: _staged, ...rest } = record;
      this.records.write(id, {
        ...rest,
        retired: [...(record.retired ?? []), { credentialId: entry.credentialId, target: entry.target }].slice(-64),
      });
    } catch {
      // Nothing more can be kept: it expires on the server.
    }
  }

  /**
   * Ask the daemon about the staged credential. Accepted (by the same workspace as before):
   * it becomes the profile's, and the one it replaces goes to the list still to revoke.
   * Refused: it was issued for a workspace the daemon on this port does not serve, so it is
   * taken back and the connect refused. Unknown: nothing changes.
   */
  private async settleNext(
    profile: ConnectionProfile,
    run: (command: string[]) => Promise<RemoteResult>,
    ask: (token: string) => Promise<HelloAnswer>,
  ): Promise<"promoted" | "unknown"> {
    const id = profile.id;
    const record = this.records.read(id);
    const next = record?.next;
    if (!record || !next) return "unknown";
    const token = this.nextSlots.read(id);
    if (!token) {
      // Staged on record, but its token was never kept: only still to revoke.
      this.remember(id, next);
      return "unknown";
    }
    const answer = await ask(token);
    if (answer.verdict === "unknown") return "unknown";
    // Promotion needs positive proof: this token is the credential the CLI issued for this
    // installation's principal (checked when it was staged, and again here), the daemon
    // accepts it, and the daemon names its workspace, the same one as before if there was one.
    const workspaceId = answer.verdict === "accepted" ? answer.workspaceId : undefined;
    const proven =
      answer.verdict === "accepted" &&
      workspaceId !== undefined &&
      tokenCredentialId(token) === next.credentialId &&
      (!record.current?.workspaceId || record.current.workspaceId === workspaceId);
    if (proven) {
      // Durable in this order: the slot, then the record that says it is current. A crash
      // between them leaves the staged one on record, which the next connect settles again.
      try {
        this.slots.write(id, token);
      } catch {
        // Still staged: the next connect tries again; the current one stays as it was.
        throw credentialRefusal("store-failed", profile);
      }
      const retired = [
        ...(record.retired ?? []),
        ...(record.current ? [{ credentialId: record.current.credentialId, target: record.current.target }] : []),
      ].slice(-64);
      this.records.write(id, {
        version: 1,
        current: { ...next, workspaceId },
        ...(retired.length ? { retired } : {}),
      });
      this.nextSlots.remove(id);
      this.generations.set(id, this.generation(id) + 1);
      await this.revokeRetired(profile, run);
      return "promoted";
    }
    // Not proven for this daemon's workspace: take it back.
    this.nextSlots.remove(id);
    this.remember(id, next);
    await this.revokeRetired(profile, run).catch(() => undefined);
    throw credentialRefusal(answer.verdict === "accepted" && !workspaceId ? "unverified" : "wrong-workspace", profile);
  }

  /**
   * Revoke the credentials still to revoke, each with the CLI and workspace config it was
   * issued under, and only on the server it was issued on, behind the same pinned host keys.
   * What could not be revoked stays on the list. `undefined`: there was nothing to revoke.
   */
  private async revokeRetired(
    profile: ConnectionProfile,
    run: (command: string[]) => Promise<RemoteResult>,
  ): Promise<CredentialEntry[] | undefined> {
    const record = this.records.read(profile.id);
    if (!record?.retired?.length) return undefined;
    const here = serverKey(profile);
    const keys = this.hostKeys(profile);
    const left: CredentialEntry[] = [];
    for (const entry of record.retired) {
      // Only through the server, and the very host keys, it was issued through.
      if (entry.target.server !== here || entry.target.hostKeys !== keys) {
        left.push(entry);
        continue;
      }
      try {
        const result = await run(revokeCommand(entry.target, entry.credentialId));
        if (result.code !== 0 && !alreadyGone(result)) left.push(entry);
      } catch {
        left.push(entry);
      }
    }
    const latest = this.records.read(profile.id) ?? record;
    const done = new Set(record.retired.filter((entry) => !left.includes(entry)).map((entry) => entry.credentialId));
    const retired = (latest.retired ?? []).filter((entry) => !done.has(entry.credentialId));
    const { retired: _old, ...rest } = latest;
    if (retired.length || rest.current || rest.next)
      this.records.write(profile.id, { ...rest, ...(retired.length ? { retired } : {}) });
    else this.records.remove(profile.id);
    return left;
  }
}
