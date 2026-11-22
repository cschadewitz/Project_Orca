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
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  ConnectionProfileSchema,
  CredentialSlots,
  forgetPin,
  tunnelKeyIdentity,
  pinState,
  profileIdFor,
  SshTunnel,
  type ConnectionProfile,
  type RemoteResult,
  type SecretCipher,
  type SshTunnelOptions,
  type TunnelState,
} from "@orca/protocol/remote-access";
import { OperatorDiscoverySchema } from "@orca/protocol";
import { CredentialTransportUnavailable, type DaemonTokenSource } from "../client/auth.js";
import { DaemonClient, DaemonClientError } from "../client/daemon-client.js";
import { streamTransport, type StreamTransport } from "../client/stream-transport.js";
import type { RemoteProfileView } from "../daemon-connection.js";
import { ConnectionRefusal } from "./connection-target.js";
import {
  confirmationCode,
  confirmedResult,
  discoverServer,
  dropDiscovery,
  enrollDiscovered,
  keyFingerprints,
  managedLauncher,
  readSetup,
  setupCommand,
  setupProgram,
  SETUP_TIMEOUT_MS,
  type Discovery,
  type InspectOutcome,
  type SetupOutcome,
} from "@orca/protocol/server-setup";
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
  newSlotId,
  type CredentialEntry,
  type CredentialRecord,
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

/**
 * What the daemon made of a credential. `accepted` only on positive proof that the daemon
 * authenticated this credential (see `helloVerdict`). `unproven`: the daemon answered, but
 * nothing shows it authenticated the credential (a daemon that does not authenticate
 * callers ignores the token, say). `unknown`: it could not be asked (no daemon, say).
 */
export type CredentialVerdict = "accepted" | "refused" | "unproven" | "unknown";

/** The daemon's answer, and on acceptance which workspace gave it. */
export interface HelloAnswer {
  verdict: CredentialVerdict;
  workspaceId?: string | undefined;
}

/** What setting up a profile's server came to (#881), and whether this computer then signed in. */
export interface ServerSetupResult {
  setup: SetupOutcome;
  /** Set when the setup was `ready`: the first connect signed in (#875), or why it did not. */
  signIn?: { ok: true } | { ok: false; message: string };
}

/**
 * What the person confirms before a server is set up (#881 review): read from the server by a
 * read-only inspection, over keys that are shown here before they are ever enrolled.
 */
export interface ServerInspection {
  /** Bound to everything below and the profile's revision: what `setUpServer` takes back. */
  confirmation: string;
  destination: string;
  /** The account the setup will run as, and install for. */
  account: string;
  /** SHA-256 fingerprints of the server's host keys, and the jump host's. */
  fingerprints: { server: string[]; jump?: string[] };
  /** The keys are not pinned for this profile yet: confirming enrolls them. */
  firstUse: boolean;
  version: string;
  root: string;
  /** The version already set up there, if any (then this verifies and repairs it). */
  current: string | null;
  scope: "install-and-sign-in";
}

/** What an inspection came to: something to confirm, or why the server cannot be set up. */
export interface ServerInspectionResult {
  inspection?: ServerInspection;
  outcome: InspectOutcome;
}

/** A confirmation waits this long for the person; then the server is inspected again. */
const CONFIRMATION_MS = 15 * 60_000;

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
  /** Test seam: runs before each credential record write, and may throw to interrupt it. */
  beforeRecordWrite?: (id: string, record: CredentialRecord) => void;
  /** Test seam: this installation's id. Default: made once and kept in `<dir>/installation.json`. */
  installationId?: string;
  credentialPolicy?: CredentialPolicy;
  now?: () => number;
  /** Test seam: ask the daemon, over the tunnel's streams, whether it accepts `token`. */
  verify?: (connect: () => Duplex, url: string, token: string, principal?: string) => Promise<HelloAnswer>;
}

/**
 * Ask the daemon, over one of the tunnel's own streams, whether it authenticates `token`.
 * A `hello` answer proves nothing about the token: a daemon that does not authenticate its
 * callers answers it while ignoring the token. Acceptance is `operator.discover` answered
 * for this credential, which a daemon serves only to an authenticated credential: it says
 * `authentication: "credential"`, names the principal the credential was issued to (when
 * `principal` is given), and names the same workspace as the handshake.
 */
export async function helloVerdict(
  connect: () => Duplex,
  url: string,
  token: string,
  principal?: string,
): Promise<HelloAnswer> {
  const transport = streamTransport(connect);
  try {
    const client = new DaemonClient(url, transport.fetch, { auth: { read: () => token, refresh: () => false } });
    const hello = await client.hello("orca-app/sign-in", false);
    if (!hello.methods?.includes("operator.discover")) return { verdict: "unproven" };
    const found = await client.call("operator.discover", {}, OperatorDiscoverySchema, false);
    if (
      found.authentication !== "credential" ||
      (principal !== undefined && found.principalId !== principal) ||
      (hello.identity !== undefined && hello.identity.workspaceId !== found.target.workspaceId)
    )
      return { verdict: "unproven" };
    return { verdict: "accepted", workspaceId: found.target.workspaceId };
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
  /** Immutable token slots; the record says which one is current, staged or imported. */
  private readonly vault: CredentialSlots;
  /** Before #875 an imported token sat in `credentials/<id>.credential`: moved into the vault on first use. */
  private readonly legacy: CredentialSlots;
  private readonly records: CredentialRecords;
  private readonly tunnels = new Map<string, SharedTunnel>();
  /** One credential setup at a time per profile: concurrent connects share it. */
  private readonly setups = new Map<string, Promise<void>>();
  /** Bumped whenever a profile's stored credential changes, so leases drop their cached copy. */
  private readonly generations = new Map<string, number>();
  /** Profiles being removed: their revoke is on the way, nothing may connect meanwhile. */
  private readonly removing = new Set<string>();
  /** Profiles whose server is being set up (#881): nothing may connect, edit or remove them meanwhile. */
  private readonly serverSetups = new Set<string>();
  /** The inspection each profile's confirmation was given for (#881): one at a time, used once. */
  private readonly inspections = new Map<
    string,
    {
      code: string;
      discovery: Discovery;
      account: string;
      root: string;
      current: string | null;
      version: string;
      revision: number;
      until: number;
    }
  >();
  /** Bumped by every edit, removal and pin reset of a profile (in memory: pending work is too). */
  private readonly revisions = new Map<string, number>();
  private closed = false;

  constructor(private readonly deps: RemoteProfilesDeps) {
    this.vault = new CredentialSlots(join(deps.dir, "credentials", "vault"), deps.cipher);
    this.legacy = new CredentialSlots(join(deps.dir, "credentials"), deps.cipher);
    this.records = new CredentialRecords(join(deps.dir, "credentials"), deps.beforeRecordWrite);
    this.sweep();
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
  private changed(id: string): void {
    this.generations.set(id, this.generation(id) + 1);
  }

  /**
   * The profile's record, after moving a token imported before #875 (a bare slot named for
   * the profile) into the vault as an import. The token is copied into its own slot, the
   * record that names it is committed, and only then is the old file deleted.
   */
  private record(id: string): CredentialRecord | undefined {
    const record = this.records.read(id);
    if (record?.current || record?.imported || !this.legacy.has(id)) return record;
    const token = this.legacy.read(id);
    if (!token) return record;
    const slot = this.put(token);
    try {
      this.records.write(id, { ...(record ?? { version: 1 as const }), imported: { slot } });
    } catch (error) {
      this.vault.remove(slot);
      throw error;
    }
    this.legacy.remove(id);
    return this.records.read(id);
  }

  /** The token the profile uses now: ORCA's current one, or the person's import. */
  private activeSlot(record: CredentialRecord | undefined): string | undefined {
    const slot = record?.current?.slot ?? record?.imported?.slot;
    return slot && this.vault.has(slot) ? slot : undefined;
  }

  /** Seal a token into a new slot of its own. */
  private put(token: string): string {
    const slot = newSlotId();
    this.vault.write(slot, token);
    return slot;
  }

  /**
   * Commit a record, then delete the slots it no longer names; if the commit fails, delete
   * the new slots instead, so the previous record and its slots stay exactly as they were.
   */
  private commit(id: string, next: CredentialRecord | undefined, created: string[] = []): void {
    const before = this.records.read(id);
    try {
      if (next) this.records.write(id, next);
      else this.records.remove(id);
    } catch (error) {
      for (const slot of created) this.vault.remove(slot);
      throw error;
    }
    const kept = new Set([next?.current?.slot, next?.next?.slot, next?.imported?.slot]);
    for (const slot of [before?.current?.slot, before?.next?.slot, before?.imported?.slot])
      if (slot && !kept.has(slot)) this.vault.remove(slot);
    this.changed(id);
  }

  /**
   * Delete vault slots no record names: what an interrupted write left behind. Only when
   * every record could be read: a record that cannot be may name any slot, so then nothing
   * is swept, and what is left over waits for a later start.
   */
  private sweep(): void {
    try {
      const referenced = this.records.referencedSlots();
      if (!referenced) {
        console.warn("Not sweeping unused credential slots: a credential record could not be read");
        return;
      }
      for (const name of readdirSync(join(this.deps.dir, "credentials", "vault"))) {
        const slot = /^([a-z0-9]{20})\.credential$/.exec(name)?.[1];
        if (slot && !referenced.has(slot)) this.vault.remove(slot);
      }
    } catch {
      // No vault yet.
    }
  }
  private tunnelOptions(profile: ConnectionProfile, expectKeys?: string): SshTunnelOptions {
    return {
      profile,
      knownHostsFile: this.pins(profile.id),
      ...(expectKeys !== undefined ? { expectKeys } : {}),
      ...(this.deps.sshBinary ? { sshBinary: this.deps.sshBinary } : {}),
      onState: (state) => this.deps.onTunnelState?.(profile.id, state),
    };
  }
  /**
   * `pinnedOnly`: an administrative connection, which never trusts a key on first use.
   * `expectKeys`: it carries nothing unless its sealed pins vouch for exactly these keys.
   */
  private newTunnel(profile: ConnectionProfile, pinnedOnly = false, expectKeys?: string): SshTunnel {
    return (this.deps.tunnel ?? ((options) => new SshTunnel(options)))({
      ...this.tunnelOptions(profile, expectKeys),
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
      hasCredential: this.activeSlot(this.record(profile.id)) !== undefined,
      ...this.credentialView(profile.id),
      ...this.pinView(profile),
    };
  }

  private credentialView(id: string): {
    credentialExpiresAt?: string;
    credentialImported?: true;
    pendingRevocations?: number;
  } {
    const record = this.record(id);
    const pending = record?.retired?.length ?? 0;
    const active = this.activeSlot(record) !== undefined;
    return {
      ...(active && record?.imported ? { credentialImported: true as const } : {}),
      ...(active && record?.current?.expiresAt ? { credentialExpiresAt: record.current.expiresAt } : {}),
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
    if (this.serverSetups.has(id)) throw new ConnectionRefusal("That profile's server is being set up.");
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
    const record = this.record(id);
    const retired = this.retiredWith(record, record?.current, record?.next);
    const keep = record?.imported && imported !== "drop" ? record.imported : undefined;
    const importState = keep
      ? { imported: { ...keep, ...(imported === "reauthorize" ? { reauthorize: true as const } : {}) } }
      : {};
    this.commit(
      id,
      retired.length || keep ? { version: 1, ...(retired.length ? { retired } : {}), ...importState } : undefined,
    );
  }

  /** The record's list to revoke, plus these entries, each with where it was issued. */
  private retiredWith(
    record: CredentialRecord | undefined,
    ...entries: (IssuedEntry | undefined)[]
  ): CredentialEntry[] {
    return [
      ...(record?.retired ?? []),
      ...entries
        .filter((entry): entry is IssuedEntry => entry !== undefined)
        .map(({ credentialId, target }) => ({ credentialId, target })),
    ].slice(-64);
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
      // Through a tunnel sealed with exactly the keys the credentials were issued through.
      const keys = this.hostKeys(profile);
      const left = await this.revokeRetired(
        profile,
        (command) => this.newTunnel(profile, true, keys).runOnce(command),
        keys,
      );
      const outcome: RevokeOutcome = left === undefined ? "none" : left.length ? "not-reached" : "revoked";
      const profiles = this.read();
      this.commit(id, undefined);
      this.legacy.remove(id);
      this.forgetPins(id);
      this.write(profiles.filter((p) => p.id !== id));
      return outcome;
    } finally {
      this.removing.delete(id);
    }
  }

  /**
   * The first half of setting a profile's machine up (#881): connect without enrolling any
   * key, and inspect the server read-only. What comes back is everything the person confirms:
   * the host keys, the account, the version and what will be done. Nothing on the server or in
   * the profile's pins changes.
   */
  async inspectServer(id: string, options: { version: string; scripts: string }): Promise<ServerInspectionResult> {
    if (this.closed) throw new ConnectionRefusal("The app is closing.");
    this.assertIdle(id, "editing");
    const profile = this.get(id);
    if (!profile) throw new ConnectionRefusal("That profile no longer exists.");
    const revision = this.revision(id);
    this.dropInspection(id);
    this.serverSetups.add(id);
    let discovery: Discovery;
    try {
      discovery = await discoverServer({
        base: this.tunnelOptions(profile),
        tunnel: (tunnelOptions) => (this.deps.tunnel ?? ((o) => new SshTunnel(o)))(tunnelOptions),
        version: options.version,
        program: setupProgram(options.scripts),
      });
    } finally {
      this.serverSetups.delete(id);
    }
    const { outcome } = discovery;
    if (outcome.kind !== "inspected" || this.revision(id) !== revision || this.closed) {
      dropDiscovery(discovery);
      if (outcome.kind === "inspected")
        throw new ConnectionRefusal("The profile changed while its server was inspected. Try again.");
      return { outcome };
    }
    const { account, root, current } = outcome.inspected;
    const code = confirmationCode({
      profile,
      revision,
      keys: discovery.keys,
      account,
      root,
      current,
      version: options.version,
      scope: "install-and-sign-in",
    });
    this.inspections.set(id, {
      code,
      discovery,
      account,
      root,
      current,
      version: options.version,
      revision,
      until: Date.now() + CONFIRMATION_MS,
    });
    return {
      outcome,
      inspection: {
        confirmation: code,
        destination: profile.destination,
        account,
        fingerprints: keyFingerprints(discovery.keys),
        firstUse: discovery.firstUse,
        version: options.version,
        root,
        current,
        scope: "install-and-sign-in",
      },
    };
  }

  private dropInspection(id: string): void {
    const pending = this.inspections.get(id);
    this.inspections.delete(id);
    if (pending) dropDiscovery(pending.discovery);
  }

  /**
   * The second half (#881): make the profile's machine a managed ORCA server, or verify and
   * repair one set up before, exactly as the person confirmed `confirmation` (from
   * `inspectServer`, used once). Only then are the inspected keys enrolled; the setup runs over
   * a pinned-only connection that carries nothing unless its pins vouch for exactly those keys,
   * as exactly the confirmed account. It stages the signed server bundle of `version` (the app's
   * own). Once the server is ready, the profile runs the server's managed launcher, and the
   * first connect signs this computer in (#875): the sign-in the confirmation covered. Nothing
   * may connect, edit or remove the profile meanwhile. `scripts`: the directory holding the
   * setup and the managed adapter.
   */
  async setUpServer(
    id: string,
    options: { version: string; scripts: string; confirmation: string },
  ): Promise<ServerSetupResult> {
    if (this.closed) throw new ConnectionRefusal("The app is closing.");
    this.assertIdle(id, "editing");
    const profile = this.get(id);
    if (!profile) throw new ConnectionRefusal("That profile no longer exists.");
    const pending = this.inspections.get(id);
    const revision = this.revision(id);
    // Used once, whatever comes of it.
    this.inspections.delete(id);
    if (
      !pending ||
      pending.code !== options.confirmation ||
      pending.revision !== revision ||
      pending.version !== options.version ||
      Date.now() > pending.until
    ) {
      if (pending) dropDiscovery(pending.discovery);
      throw new ConnectionRefusal("That confirmation is not current. Check the server again, then confirm.");
    }
    let command: string[];
    let program: string;
    try {
      command = setupCommand(options.version, profile.remotePort, pending);
      program = setupProgram(options.scripts);
    } catch (error) {
      dropDiscovery(pending.discovery);
      throw error;
    }
    enrollDiscovered(pending.discovery, this.pins(id), profile.jump !== undefined);
    this.serverSetups.add(id);
    let setup: SetupOutcome;
    try {
      const tunnel = this.newTunnel(profile, true, pending.discovery.keys);
      try {
        await tunnel.open();
        // Only the setup that was confirmed counts: what the server reports must match it.
        setup = confirmedResult(readSetup(await tunnel.exec(command, SETUP_TIMEOUT_MS, program)), {
          version: options.version,
          port: profile.remotePort,
          account: pending.account,
          root: pending.root,
        });
      } finally {
        await tunnel.close();
      }
    } finally {
      this.serverSetups.delete(id);
    }
    if (setup.kind !== "ready") return { setup };
    if (this.revision(id) !== revision || this.closed)
      throw new ConnectionRefusal("The profile changed while its server was set up. Set it up again.");
    // Still pinned to exactly the confirmed keys: what signs in is the server that was set up.
    if (this.hostKeys(profile) !== pending.discovery.keys)
      throw new ConnectionRefusal(
        "The profile's pinned host keys changed while its server was set up. Set it up again.",
      );
    // Repointed only at the launcher derived here from the confirmed directory, on the same
    // server and port (so the verified pins stay). The managed launcher passes the server's
    // config itself, so the profile names none.
    const latest = this.get(id)!;
    const launcher = managedLauncher(pending.root);
    if (latest.serverCommand !== launcher || latest.serverConfig !== undefined) {
      const { serverConfig: _config, ...rest } = latest;
      this.save({ ...rest, serverCommand: launcher });
      if (this.hostKeys(profile) !== pending.discovery.keys)
        throw new ConnectionRefusal("The profile's pinned host keys changed while its server was set up.");
    }
    try {
      await (await this.open(id)).release();
      return { setup, signIn: { ok: true } };
    } catch (error) {
      return { setup, signIn: { ok: false, message: error instanceof Error ? error.message : String(error) } };
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
    // The import gets a slot of its own, and becomes the profile's credential in one record
    // commit, which also moves what ORCA had issued to the list still to revoke. Interrupted
    // before that commit, the previous credential and record stand as they were.
    let slot: string;
    try {
      slot = this.put(token);
    } catch (error) {
      throw new ConnectionRefusal(error instanceof Error ? error.message : "The credential could not be stored.");
    }
    const record = this.record(id);
    const retired = this.retiredWith(record, record?.current, record?.next);
    try {
      this.commit(id, { version: 1, ...(retired.length ? { retired } : {}), imported: { slot } }, [slot]);
    } catch {
      throw new ConnectionRefusal("The credential could not be stored.");
    }
    return this.view(profile);
  }

  /** Drop an imported credential, so the next connect signs in automatically. */
  useAutomaticSignIn(id: string): RemoteProfileView {
    const profile = this.get(id);
    if (!profile) throw new ConnectionRefusal("That profile no longer exists.");
    this.assertIdle(id, "resetting");
    const record = this.record(id);
    if (record?.imported) {
      const { imported: _dropped, ...rest } = record;
      this.commit(id, rest.retired?.length || rest.next ? rest : undefined);
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
      this.serverSetups.has(id) ||
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
    return tunnelKeyIdentity(this.pins(profile.id), profile.jump !== undefined);
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
    if (this.serverSetups.has(id)) throw new ConnectionRefusal("That profile's server is being set up.");
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
    let cached: string | undefined;
    let cachedKeys: string | undefined;
    let cachedGeneration = -1;
    // The keys this tunnel sealed: every stream of this lease is verified against them, and
    // they cannot change while the tunnel lives.
    const sealed = current.tunnel.pinnedKeys;
    // Nothing of this lease outlives its release or a change to the profile.
    const usable = () => !released && this.revision(id) === revision && sealed !== undefined;
    const transport = streamTransport(() => {
      if (!usable() || current.tunnel.pinnedKeys !== sealed) throw new CredentialTransportUnavailable();
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
            // Whatever the record names as the profile's credential now, from its own slot,
            // with the keys it is bound to.
            const record = this.record(id);
            const slot = this.activeSlot(record);
            cached = slot ? this.vault.read(slot) : undefined;
            cachedKeys = record?.current ? record.current.target.hostKeys : record?.imported?.hostKeys;
            cachedGeneration = this.generation(id);
          }
          // Sent only on streams verified against the keys it is bound to. An import not yet
          // bound (never accepted by a daemon) goes where the person imported it for.
          if (cached !== undefined && cachedKeys !== undefined && cachedKeys !== sealed)
            throw new CredentialTransportUnavailable();
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
    for (const id of [...this.inspections.keys()]) this.dropInspection(id);
    const all = [...this.tunnels.values()];
    this.tunnels.clear();
    for (const shared of all) if (shared.renewal) clearInterval(shared.renewal);
    await Promise.all(all.map((shared) => shared.tunnel.close()));
  }

  /** While the tunnel is open, renew its credential when it comes due. */
  private watchRenewal(id: string, shared: SharedTunnel, url: string): void {
    if (shared.renewal) return;
    shared.renewal = setInterval(() => {
      const current = this.record(id)?.current;
      if (!current || !dueForRenewal(current, this.policy, this.now())) return;
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
    const ask = (token: string, principal?: string) =>
      (this.deps.verify ?? helloVerdict)(() => shared.tunnel.connect(), url, token, principal);

    // Credentials are bound to the host keys they were issued through: the keys this tunnel
    // sealed, which every command and question below goes through. Any issued through keys
    // the pins no longer hold are quarantined: never sent here, revoked only there.
    const keys = shared.tunnel.pinnedKeys;
    if (keys === undefined || keys !== this.hostKeys(profile))
      throw new ConnectionRefusal("The server's pinned host key changed while connecting. Connect again.");
    const bound = this.record(id);
    if (
      (bound?.current && bound.current.target.hostKeys !== keys) ||
      (bound?.next && bound.next.target.hostKeys !== keys)
    )
      this.retireCredentials(id, "keep");

    // A replacement staged by an earlier connect: switch to it, or take it back.
    if (this.record(id)?.next) {
      const outcome = await this.settleNext(profile, run, ask, keys);
      if (outcome === "promoted") return;
    }
    let record = this.record(id);
    const active = this.activeSlot(record);
    if (!active) {
      if (!record?.next) {
        await this.stage(profile, run, keys);
        await this.settleNext(profile, run, ask, keys);
      }
      return;
    }
    if (record?.imported) {
      // Imported: kept as it is, and sent only through the host keys it was first accepted
      // through. Refused, or its server's key reset, it is the person's to act on, never ORCA's.
      const imported = record.imported;
      if (imported.reauthorize || (imported.hostKeys !== undefined && imported.hostKeys !== keys))
        throw credentialRefusal("imported-reauthorize", profile);
      const token = this.vault.read(active);
      const answer = token ? await ask(token) : { verdict: "unknown" as const };
      if (answer.verdict === "refused") throw credentialRefusal("imported-refused", profile);
      // Bound only on positive proof; an unproven answer leaves it as the person imported it.
      if (answer.verdict === "accepted") {
        const latest = this.record(id);
        if (latest?.imported?.slot === imported.slot && !latest.imported.hostKeys) {
          this.records.write(id, { ...latest, imported: { ...latest.imported, hostKeys: keys } });
          this.changed(id);
        }
        // What ORCA had issued before the import is still revoked where it came from.
        await this.revokeRetired(profile, run, keys);
      }
      return;
    }
    const current = record!.current!;
    if (dueForRenewal(current, this.policy, this.now()) && !record!.next) {
      try {
        await this.stage(profile, run, keys);
        if ((await this.settleNext(profile, run, ask, keys)) === "promoted") return;
      } catch (error) {
        // A renewal that fails leaves the current credential in place while it is still valid.
        if (!current.expiresAt || Date.parse(current.expiresAt) <= this.now()) throw error;
        if (error instanceof CredentialSetupRefusal && error.code === "wrong-workspace") throw error;
      }
    }
    record = this.record(id);
    const slot = this.activeSlot(record);
    const token = slot ? this.vault.read(slot) : undefined;
    const answer = token ? await ask(token, record?.current?.principal) : { verdict: "refused" as const };
    if (answer.verdict === "unproven") throw credentialRefusal("unverified", profile);
    if (answer.verdict === "accepted") {
      // The daemon must say which workspace it is, and be the one this credential is bound to.
      if (!answer.workspaceId) throw credentialRefusal("unverified", profile);
      if (record?.current && record.current.workspaceId !== answer.workspaceId)
        throw credentialRefusal("wrong-workspace", profile);
      await this.revokeRetired(profile, run, keys);
      return;
    }
    if (answer.verdict === "unknown") return;
    // Refused (expired or revoked on the server): one replacement, then a clear refusal.
    if (!record?.next) {
      try {
        await this.stage(profile, run, keys);
      } catch (error) {
        if (error instanceof CredentialSetupRefusal && error.code === "cli-failed")
          throw credentialRefusal("credential-refused", profile);
        throw error;
      }
    }
    if ((await this.settleNext(profile, run, ask, keys)) !== "promoted")
      throw credentialRefusal("credential-refused", profile);
  }

  /**
   * Issue a credential and stage it: its token in a new slot of its own, then one record
   * commit that names the slot as staged. Until the daemon accepts it, nothing uses it; if it
   * cannot be kept, it is taken back on the server.
   */
  private async stage(
    profile: ConnectionProfile,
    run: (command: string[]) => Promise<RemoteResult>,
    keys: string,
  ): Promise<void> {
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
    const entry = {
      credentialId: issued.credentialId,
      target: targetOf(profile, keys),
      principal,
      ...(issued.expiresAt ? { expiresAt: issued.expiresAt } : {}),
      issuedAt: new Date(this.now()).toISOString(),
    };
    try {
      const slot = this.put(issued.token);
      const record = this.record(profile.id) ?? { version: 1 as const };
      this.commit(profile.id, { ...record, next: { ...entry, slot } }, [slot]);
    } catch {
      // Not kept: take it back now, or remember to.
      const revoked = await run(revokeCommand(entry.target, entry.credentialId)).then(
        (r) => r.code === 0 || alreadyGone(r),
        () => false,
      );
      if (!revoked) this.remember(profile.id, entry);
      throw credentialRefusal("store-failed", profile);
    }
  }

  /** Move a credential (and the staged one, if it is that) to the list still to revoke. Best effort. */
  private remember(id: string, entry: CredentialEntry): void {
    try {
      const record = this.record(id) ?? { version: 1 as const };
      const staged = record.next?.credentialId === entry.credentialId;
      const { next, ...rest } = record;
      this.commit(id, {
        ...rest,
        ...(next && !staged ? { next } : {}),
        retired: [...(record.retired ?? []), { credentialId: entry.credentialId, target: entry.target }].slice(-64),
      });
    } catch {
      // Nothing more can be kept: it expires on the server.
    }
  }

  /**
   * Ask the daemon about the staged credential. Proven: it becomes the profile's in one
   * record commit, which also moves the one it replaces to the list still to revoke; the
   * replaced slot is deleted only after that commit. Refused, or accepted without proof: it
   * is taken back and the connect refused. Unknown: nothing changes.
   */
  private async settleNext(
    profile: ConnectionProfile,
    run: (command: string[]) => Promise<RemoteResult>,
    ask: (token: string, principal?: string) => Promise<HelloAnswer>,
    keys: string,
  ): Promise<"promoted" | "unknown"> {
    const id = profile.id;
    const record = this.record(id);
    const next = record?.next;
    if (!record || !next) return "unknown";
    const token = this.vault.has(next.slot) ? this.vault.read(next.slot) : undefined;
    if (!token) {
      // Staged on record, but its token is gone: only still to revoke.
      this.remember(id, next);
      return "unknown";
    }
    // Only through the keys it was issued through.
    if (next.target.hostKeys !== keys) return "unknown";
    const answer = await ask(token, next.principal);
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
      // Recheck before promotion: still the staged one, and the pins still vouch for the keys
      // the daemon was asked through.
      const latest = this.record(id);
      if (latest?.next?.slot !== next.slot || this.hostKeys(profile) !== keys) return "unknown";
      const retired = this.retiredWith(latest, latest.current);
      try {
        this.commit(id, { version: 1, current: { ...next, workspaceId }, ...(retired.length ? { retired } : {}) });
      } catch {
        // Still staged, the current one untouched: the next connect settles it again.
        throw credentialRefusal("store-failed", profile);
      }
      await this.revokeRetired(profile, run, keys);
      return "promoted";
    }
    // Not proven for this daemon's workspace: take it back.
    this.remember(id, next);
    await this.revokeRetired(profile, run, keys).catch(() => undefined);
    throw credentialRefusal(
      answer.verdict === "unproven" || (answer.verdict === "accepted" && !workspaceId)
        ? "unverified"
        : "wrong-workspace",
      profile,
    );
  }

  /**
   * Revoke the credentials still to revoke, each with the CLI and workspace config it was
   * issued under, and only on the server it was issued on, behind the same pinned host keys.
   * What could not be revoked stays on the list. `undefined`: there was nothing to revoke.
   */
  private async revokeRetired(
    profile: ConnectionProfile,
    run: (command: string[]) => Promise<RemoteResult>,
    /** The keys `run` goes through: sealed, so they cannot change under it. */
    keys: string,
  ): Promise<CredentialEntry[] | undefined> {
    const record = this.record(profile.id);
    if (!record?.retired?.length) return undefined;
    const here = serverKey(profile);
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
    const latest = this.record(profile.id) ?? record;
    const done = new Set(record.retired.filter((entry) => !left.includes(entry)).map((entry) => entry.credentialId));
    const retired = (latest.retired ?? []).filter((entry) => !done.has(entry.credentialId));
    const { retired: _old, ...rest } = latest;
    this.commit(
      profile.id,
      retired.length || rest.current || rest.next || rest.imported
        ? { ...rest, ...(retired.length ? { retired } : {}) }
        : undefined,
    );
    return left;
  }
}
