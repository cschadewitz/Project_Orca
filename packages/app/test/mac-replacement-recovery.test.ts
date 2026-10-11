/** Durable POSIX/AES fixtures, complete synthetic protected files + binary pairs; no native acceptance. */
import { mkdtemp, mkdir, writeFile, readFile, readdir, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { afterEach, expect, it as platformIt, vi } from "vitest";
import {
  MacReplacementJournal,
  MacProtectedPairSchema,
  type MacProtectedPair,
  type MacReplacementRecord,
} from "../src/main/mac-replacement-journal.js";
import {
  MacReplacementRecovery,
  type MacProtectedOwner,
  type MacReplacementPorts,
} from "../src/main/mac-replacement-recovery.js";
import { PosixFixtureNativeAdapter, type DiagnosticsKeyAdapter } from "../src/main/diagnostics/native-adapter.js";
import { nodeRecoveryFiles } from "../src/main/diagnostics/recovery-files.js";
import { sha256 } from "../src/main/mac-candidate-manifest.js";
import { barrier } from "../../daemon/test/runtime-maintenance-fixture.js";
// The POSIX fixture adapter requires private modes and refuses a Windows journal root.
const it = platformIt.skipIf(process.platform === "win32");
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orca-complete-pair-test-"));
  closers.push(() => rm(root, { recursive: true }));
  const source = join(root, "source");
  await mkdir(source, { mode: 0o700 });
  for (const name of ["store", "app", "config"])
    await writeFile(join(source, name), `protected-${name}`, { mode: 0o600 });
  const key = randomBytes(32);
  const keys: DiagnosticsKeyAdapter = {
    available: async () => true,
    wrap: async (bytes) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    },
    unwrap: async (bytes) => {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    },
  };
  const native = () =>
    new PosixFixtureNativeAdapter({ stopped: async () => true, moveNoReplace: async () => "refused" });
  const journalRoot = join(root, "journal");
  const journals: MacReplacementJournal[] = [];
  const journal = () => {
    const value = new MacReplacementJournal(journalRoot, { native: native(), files: nodeRecoveryFiles, keys });
    journals.push(value);
    return value;
  };
  closers.push(async () => {
    for (const j of journals) await j.close();
    key.fill(0);
  });
  const previousManifestSha256 = "a".repeat(64),
    candidateDigest = "b".repeat(64);
  const pairs = new Map<string, { dir: string; value: MacProtectedPair }>();
  const writerEpoch = randomUUID();
  let revision = 0,
    intact = true,
    stopped = true;
  let last: MacProtectedPair | undefined;
  const owner: MacProtectedOwner = {
    rootIds: ["store", "app", "config"],
    check: () => intact,
    stopped: () => stopped,
    capture: vi.fn(async (manifestSha256) => {
      const id = randomUUID(),
        dir = join(root, id);
      await mkdir(dir, { mode: 0o700 });
      await cp(source, join(dir, "state"), { recursive: true });
      await writeFile(join(dir, "binary"), manifestSha256 === previousManifestSha256 ? "image-N" : "image-N-plus-1", {
        mode: 0o600,
      });
      const roots = await Promise.all(
        owner.rootIds.map(async (name) => ({ id: name, sha256: sha256(await readFile(join(dir, "state", name))) })),
      );
      const value: MacProtectedPair = MacProtectedPairSchema.parse({
        id,
        manifestSha256,
        roots,
        stateSha256: sha256(Buffer.from(JSON.stringify(roots))),
        binarySha256: sha256(await readFile(join(dir, "binary"))),
        continuitySha256: "c".repeat(64),
        writerEpoch,
        writeRevision: revision,
      });
      pairs.set(id, { dir, value });
      last = value;
      return structuredClone(value);
    }),
    verify: vi.fn(async (pair: MacProtectedPair) => {
      const saved = pairs.get(pair.id);
      if (!saved || JSON.stringify(saved.value) !== JSON.stringify(pair)) return false;
      if (sha256(await readFile(join(saved.dir, "binary"))) !== pair.binarySha256) return false;
      return (
        await Promise.all(
          pair.roots.map(
            async (component) => sha256(await readFile(join(saved.dir, "state", component.id))) === component.sha256,
          ),
        )
      ).every(Boolean);
    }),
    current: vi.fn(async () => structuredClone(last)),
    restorePair: vi.fn(async (previous, current) => {
      expect(pairs.has(previous.id) && pairs.has(current.id)).toBe(true);
      // Fixture selects both full protected roots and matching image, retaining both directories.
      await writeFile(
        join(root, "selected-pair.json"),
        JSON.stringify({
          pair: previous.id,
          state: join(pairs.get(previous.id)!.dir, "state"),
          binary: join(pairs.get(previous.id)!.dir, "binary"),
        }),
        { mode: 0o600 },
      );
      return "restored" as const;
    }),
  };
  const oldTarget = { workspaceId: randomUUID(), instanceId: randomUUID(), processId: 8100 };
  const ports: MacReplacementPorts = {
    closeBootstrap: vi.fn(async () => "closed" as const),
    verifyClosed: vi.fn(async () => ({ outcome: "refused" as const })),
  };
  const input = {
    candidate: {
      manifestSha256: candidateDigest,
      channel: "invited",
      compatibilityPlanId: "fixture",
      recoveryPlanId: "fixture",
    },
    previousManifestSha256,
    previousTarget: oldTarget,
    token: randomUUID(),
  };
  const first = journal();
  const recovery = (j: MacReplacementJournal) => new MacReplacementRecovery(j, owner, ports, 5000);
  const prepare = async () => {
    expect(await recovery(first).prepare(input, new AbortController().signal)).toMatchObject({
      outcome: "prepared-closed",
    });
    const record = (await first.read())!;
    await first.close();
    return record;
  };
  return {
    root,
    source,
    journalRoot,
    journal,
    first,
    native,
    keys,
    owner,
    ports,
    pairs,
    input,
    recovery,
    prepare,
    mutate: async (value: string) => {
      revision++;
      await writeFile(join(source, "config"), value);
    },
    lose: () => {
      intact = false;
    },
    live: () => {
      stopped = false;
    },
    revision: () => {
      revision++;
    },
  };
}
it("durably pins closed recovery identity across normal quit and fresh app bootstrap without restoring consent", async () => {
  const f = await fixture();
  const record = await f.prepare();
  const next = f.journal();
  expect(await next.read()).toEqual(record);
  expect(record.phase).toBe("closed");
  expect(record.token).toBe(f.input.token);
  const bytes = await readFile(join(f.journalRoot, "replacement.enc"));
  expect(bytes.includes(Buffer.from(f.input.token))).toBe(false);
  const order: string[] = [];
  vi.mocked(f.ports.closeBootstrap).mockImplementation(async () => {
    order.push("closed");
    return "closed";
  });
  vi.mocked(f.ports.verifyClosed).mockImplementation(async () => {
    order.push("verify");
    return {
      outcome: "verified-closed",
      startup: {
        manifestSha256: f.input.candidate.manifestSha256,
        target: { ...f.input.previousTarget, instanceId: randomUUID(), processId: 8101 },
        scope: "startup-only",
      },
    };
  });
  const result = await f.recovery(next).recover(new AbortController().signal);
  expect(result).toMatchObject({ outcome: "verified-closed", id: record.id });
  expect(order).toEqual(["closed", "verify"]);
  expect((await next.read())!.phase).toBe("verified-closed");
  expect(f.owner.restorePair).not.toHaveBeenCalled();
});
it("automatically selects the previous protected-state plus matching binary only with positive all-write equality", async () => {
  const f = await fixture();
  const previous = await f.prepare(),
    next = f.journal();
  expect(await f.recovery(next).recover(new AbortController().signal)).toMatchObject({ outcome: "restored-closed" });
  const record = (await next.read())!;
  expect(record.phase).toBe("restored-closed");
  expect(record.current).toBeDefined();
  expect(f.owner.restorePair).toHaveBeenCalledOnce();
  const selected = JSON.parse(await readFile(join(f.root, "selected-pair.json"), "utf8")) as {
    pair: string;
    state: string;
    binary: string;
  };
  expect(selected.pair).toBe(previous.previous.id);
  expect(await readFile(selected.binary, "utf8")).toBe("image-N");
  for (const name of f.owner.rootIds)
    expect(await readFile(join(selected.state, name), "utf8")).toBe(`protected-${name}`);
  expect(f.pairs.size).toBe(2);
  for (const pair of f.pairs.values())
    expect(await f.owner.verify(pair.value, new AbortController().signal)).toBe(true);
});
it.each(["migration", "reverted-migration", "startup-write"] as const)(
  "preserves both complete generations after %s, even without newly admitted runs",
  async (change) => {
    const f = await fixture();
    await f.prepare();
    if (change === "migration") await f.mutate("new-format-protected-config");
    else if (change === "reverted-migration") {
      await f.mutate("migration");
      await f.mutate("protected-config");
    } else f.revision();
    const next = f.journal();
    expect(await f.recovery(next).recover(new AbortController().signal)).toMatchObject({
      outcome: "preserved",
      reason: "newer-writes",
    });
    expect(f.owner.restorePair).not.toHaveBeenCalled();
    const record = (await next.read())!;
    expect(record.phase).toBe("preserved");
    expect(record.current!.writeRevision).toBeGreaterThan(record.previous.writeRevision);
    expect(f.pairs.size).toBe(2);
    const current = f.pairs.get(record.current!.id)!;
    expect(await readFile(join(current.dir, "binary"), "utf8")).toBe("image-N-plus-1");
    expect(await readFile(join(current.dir, "state", "config"), "utf8")).toBe(
      change === "migration" ? "new-format-protected-config" : "protected-config",
    );
  },
);
it.each(["launching", "restoring"] as const)(
  "retains closed admission after interrupted %s and never repeats the operation",
  async (phase) => {
    const f = await fixture();
    const record = await f.prepare(),
      next = f.journal();
    await next.commit({ ...record, phase });
    await next.close();
    expect(await f.recovery(f.journal()).recover(new AbortController().signal)).toMatchObject({ outcome: "unknown" });
    expect(f.ports.verifyClosed).not.toHaveBeenCalled();
    expect(f.owner.restorePair).not.toHaveBeenCalled();
  },
);
it("preserves the live generation when startup outcome or clean stop is uncertain", async () => {
  const f = await fixture();
  await f.prepare();
  f.live();
  vi.mocked(f.ports.verifyClosed).mockResolvedValue({ outcome: "unknown" });
  const next = f.journal();
  expect(await f.recovery(next).recover(new AbortController().signal)).toMatchObject({ outcome: "unknown" });
  expect((await next.read())!.phase).toBe("launching");
  expect(f.owner.capture).toHaveBeenCalledOnce();
  expect(f.owner.restorePair).not.toHaveBeenCalled();
});
it.each(["workspace", "candidate", "scope"] as const)(
  "rejects incompatible accepted startup %s without rollback",
  async (field) => {
    const f = await fixture();
    await f.prepare();
    const startup = {
      manifestSha256: f.input.candidate.manifestSha256,
      target: { ...f.input.previousTarget, instanceId: randomUUID(), processId: 8101 },
      scope: "startup-only" as const,
    };
    if (field === "workspace") startup.target.workspaceId = randomUUID();
    if (field === "candidate") startup.manifestSha256 = "d".repeat(64);
    if (field === "scope") Object.assign(startup, { scope: "recovery" });
    vi.mocked(f.ports.verifyClosed).mockResolvedValue({ outcome: "verified-closed", startup });
    expect(await f.recovery(f.journal()).recover(new AbortController().signal)).toMatchObject({ outcome: "unknown" });
    expect(f.owner.restorePair).not.toHaveBeenCalled();
  },
);
it("requires complete writer/root capture and preserves a corrupted previous binary without attempting recovery", async () => {
  const f = await fixture();
  const record = await f.prepare();
  await writeFile(join(f.pairs.get(record.previous.id)!.dir, "binary"), "wrong-binary");
  expect(await f.recovery(f.journal()).recover(new AbortController().signal)).toMatchObject({ outcome: "unknown" });
  expect(f.ports.verifyClosed).not.toHaveBeenCalled();
  expect(f.owner.restorePair).not.toHaveBeenCalled();
});
it("does not capture or authorize native replacement with unconfirmed writer stop", async () => {
  const f = await fixture();
  f.live();
  expect(await f.recovery(f.first).prepare(f.input, new AbortController().signal)).toMatchObject({
    outcome: "refused",
  });
  expect(f.owner.capture).not.toHaveBeenCalled();
  expect(await f.first.read()).toBeUndefined();
});
it("blocks rollback if protected state or writer revision changes after the preserved capture", async () => {
  const f = await fixture();
  await f.prepare();
  const original = vi.mocked(f.owner.current).getMockImplementation()!;
  vi.mocked(f.owner.current).mockImplementation(async (signal) => ({
    ...((await original(signal)) as MacProtectedPair),
    writeRevision: 1,
  }));
  expect(await f.recovery(f.journal()).recover(new AbortController().signal)).toMatchObject({
    outcome: "preserved",
    reason: "incompatible",
  });
  expect(f.owner.restorePair).not.toHaveBeenCalled();
});
it("retains both pairs and a durable restoring intention on lost restore acknowledgement", async () => {
  const f = await fixture();
  await f.prepare();
  vi.mocked(f.owner.restorePair).mockResolvedValue("unknown");
  const next = f.journal(),
    recovery = f.recovery(next);
  expect(await recovery.recover(new AbortController().signal)).toMatchObject({ outcome: "unknown" });
  await recovery.recover(new AbortController().signal);
  expect(f.owner.restorePair).toHaveBeenCalledOnce();
  expect((await next.read())!.phase).toBe("restoring");
  expect(f.pairs.size).toBe(2);
});
it("rejects corrupt encrypted journals and incomplete durable commits before startup", async () => {
  const f = await fixture();
  await f.prepare();
  await writeFile(join(f.journalRoot, "replacement.tmp"), "partial", { mode: 0o600 });
  expect(await f.recovery(f.journal()).recover(new AbortController().signal)).toMatchObject({ outcome: "unknown" });
  expect(f.ports.verifyClosed).not.toHaveBeenCalled();
});
it("does not promote a late durable preparation commit after cancellation", async () => {
  const f = await fixture();
  const entered = barrier(),
    finish = barrier();
  const original = f.first.commit.bind(f.first);
  const journal = {
    read: () => f.first.read(),
    commit: async (record: MacReplacementRecord) => {
      entered.release();
      await finish.promise;
      await original(record);
    },
  };
  const recovery = new MacReplacementRecovery(journal, f.owner, f.ports, 5000),
    abort = new AbortController();
  const result = recovery.prepare(f.input, abort.signal);
  await entered.promise;
  abort.abort();
  expect(await result).toMatchObject({ outcome: "unknown" });
  finish.release();
  await vi.waitFor(async () => expect(await readdir(f.journalRoot)).toContain("replacement.enc"));
  expect(f.ports.closeBootstrap).not.toHaveBeenCalled();
  expect((await f.first.read())!.phase).toBe("closed");
});
it("lost durability acknowledgement is closed on fresh restart and never authorizes native readiness", async () => {
  const f = await fixture();
  const storage = f.native(),
    replace = storage.replace.bind(storage);
  vi.spyOn(storage, "replace").mockImplementation(async (from, to) => {
    await replace(from, to);
    throw new Error("Lost durable ACK");
  });
  const journal = new MacReplacementJournal(f.journalRoot, { native: storage, files: nodeRecoveryFiles, keys: f.keys });
  expect(await f.recovery(journal).prepare(f.input, new AbortController().signal)).toMatchObject({
    outcome: "unknown",
  });
  expect(f.ports.closeBootstrap).not.toHaveBeenCalled();
  await journal.close();
  expect((await f.journal().read())!.phase).toBe("closed");
});
it("revalidates the preserved replacement pair on a fresh supervisor and refuses a mismatching binary", async () => {
  const f = await fixture();
  await f.prepare();
  await f.mutate("migration");
  const next = f.journal();
  expect(await f.recovery(next).recover(new AbortController().signal)).toMatchObject({ outcome: "preserved" });
  const record = (await next.read())!;
  await next.close();
  await writeFile(join(f.pairs.get(record.current!.id)!.dir, "binary"), "mismatched-current-image");
  expect(await f.recovery(f.journal()).recover(new AbortController().signal)).toMatchObject({ outcome: "unknown" });
  expect(f.owner.restorePair).not.toHaveBeenCalled();
});
it("fails closed on journal ciphertext corruption without normal bootstrap or a recovery retry", async () => {
  const f = await fixture();
  await f.prepare();
  const path = join(f.journalRoot, "replacement.enc"),
    bytes = await readFile(path);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  await writeFile(path, bytes);
  expect(await f.recovery(f.journal()).recover(new AbortController().signal)).toMatchObject({ outcome: "unknown" });
  expect(f.ports.verifyClosed).not.toHaveBeenCalled();
  expect(f.owner.restorePair).not.toHaveBeenCalled();
});
