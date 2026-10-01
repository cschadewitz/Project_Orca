/**
 * The credential lifecycle - issue, verify, expire, rotate, revoke - on disk the way the
 * daemon and a CLI beside it share it, and the local bootstrap path a same-user client uses.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CredentialError,
  CredentialStore,
  FileAuditSink,
  bootstrapLocalOwner,
  openAuthDirectory,
  parseToken,
  readLocalToken,
} from "../src/auth/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orca-auth-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const mode = async (file: string) => (await stat(file)).mode & 0o777;

describe("CredentialStore", () => {
  it("keeps only a hash of the secret, owner-readable", async () => {
    const file = join(dir, "credentials.json");
    const store = new CredentialStore({ file });
    const { token, credential } = store.issue({ principal: "ci", preset: "client", label: "nightly bot" });
    const { secret } = parseToken(token)!;
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(secret);
    expect(text).toContain(credential.id);
    expect(await mode(file)).toBe(0o600);
    expect(store.list()[0]).not.toHaveProperty("secretSha256");
    expect(store.authenticate(token)).toMatchObject({ ok: true, principal: { id: "ci", credentialId: credential.id } });
  });

  it("classifies each failure for the audit log", () => {
    let now = 1_000_000;
    const store = new CredentialStore({ now: () => new Date(now) });
    const live = store.issue({ principal: "a", preset: "viewer", ttlMs: 1000 });
    const { id } = parseToken(live.token)!;
    expect(store.authenticate("orca1.short").ok).toBe(false);
    expect(store.authenticate("orca1.short")).toMatchObject({ reason: "malformed" });
    expect(store.authenticate(`orca1.${"z".repeat(12)}.${"z".repeat(43)}`)).toMatchObject({ reason: "unknown" });
    expect(store.authenticate(`orca1.${id}.${"z".repeat(43)}`)).toMatchObject({ reason: "mismatch" });
    now += 2000;
    expect(store.authenticate(live.token)).toMatchObject({ reason: "expired", credentialId: id });
    const other = store.issue({ principal: "b", preset: "viewer" });
    store.revoke(other.credential.id);
    expect(store.authenticate(other.token)).toMatchObject({ reason: "revoked" });
    expect(store.revoke(other.credential.id)).toBe(false);
  });

  it("sees another process's revocation and rotation without a restart", async () => {
    const file = join(dir, "credentials.json");
    const daemon = new CredentialStore({ file });
    const cli = () => new CredentialStore({ file });
    const issued = cli().issue({ principal: "ci", preset: "client" });
    expect(daemon.authenticate(issued.token).ok).toBe(true);
    const rotated = cli().rotate(issued.credential.id);
    expect(daemon.authenticate(issued.token)).toMatchObject({ ok: false, reason: "revoked" });
    expect(daemon.authenticate(rotated.token)).toMatchObject({ ok: true, principal: { id: "ci" } });
    expect(daemon.current(rotated.credential.id).ok).toBe(true);
  });

  it("fails closed on a damaged file, and refuses to start on one", async () => {
    const file = join(dir, "credentials.json");
    const store = new CredentialStore({ file });
    const { token } = store.issue({ principal: "ci", preset: "client" });
    await writeFile(file, "{ not json");
    expect(store.authenticate(token)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(() => new CredentialStore({ file })).toThrow(CredentialError);
  });

  it("refuses a principal name it could not log safely", () => {
    expect(() => new CredentialStore().issue({ principal: "a b\n", preset: "viewer" })).toThrow(CredentialError);
  });
});

describe("the local bootstrap", () => {
  it("writes one live owner token for same-user clients, and rotates it on every start", async () => {
    const first = openAuthDirectory(join(dir, "auth"));
    bootstrapLocalOwner(first);
    const token = readLocalToken(first.tokenFile)!;
    expect(token).toBeDefined();
    expect(await mode(first.tokenFile)).toBe(0o600);
    expect(await mode(join(dir, "auth"))).toBe(0o700);
    expect(await readFile(join(dir, "auth", ".gitignore"), "utf8")).toBe("*\n");
    expect(first.credentials.authenticate(token)).toMatchObject({ ok: true, principal: { id: "local-owner" } });

    const second = openAuthDirectory(join(dir, "auth"));
    bootstrapLocalOwner(second);
    expect(second.credentials.authenticate(token)).toMatchObject({ ok: false, reason: "revoked" });
    expect(second.credentials.authenticate(readLocalToken(second.tokenFile)!).ok).toBe(true);
    expect(second.credentials.list().filter((c) => c.bootstrap && !c.revokedAt)).toHaveLength(1);
  });

  it("reads nothing from a file that does not hold a token", async () => {
    const file = join(dir, "token");
    expect(readLocalToken(file)).toBeUndefined();
    await writeFile(file, "hello\n");
    expect(readLocalToken(file)).toBeUndefined();
  });

  it("creates an owner-only audit log up front", async () => {
    const file = join(dir, "audit.jsonl");
    const sink = new FileAuditSink(file);
    sink.record({ at: "t", event: "authn.denied", transport: "http", outcome: "denied", reason: "missing" });
    await sink.flush();
    expect(await mode(file)).toBe(0o600);
    expect(JSON.parse((await readFile(file, "utf8")).trim())).toMatchObject({ reason: "missing" });
  });
});
