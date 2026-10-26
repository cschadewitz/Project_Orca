/** Real disposable composition. Test supervisor identities/profile are explicit assumptions.
 * OS reads are independently intercepted by this test; external syscall acceptance is separate.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { fileStores } from "@orca/store";
import { resolveManagedRootBinding } from "../src/typed-workspace-gate.js";
import { runControlledOwnedReadTest, type ControlledReadTestSupervisor } from "./controlled-owned-read-producer.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const content = "disposable candidate bytes";
async function supervisor(
  lane: "bootstrap" | "connected",
  previous?: { evidenceRef: string; assertCurrent(): undefined },
  fault?: ControlledReadTestSupervisor["fault"],
) {
  const base = await mkdtemp(join(tmpdir(), "orca-controlled-test-"));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  for (const path of ["workspace", "workspace/.orca", "workspace/.orca/workspace-identity", "control", "releases"])
    await mkdir(join(base, path), { mode: 0o700 });
  const id = join(base, "workspace/.orca/workspace-identity/id");
  await writeFile(id, `${randomUUID()}\n`, { mode: 0o600 });
  const binding = resolveManagedRootBinding(
    [
      { role: "config", path: join(base, "workspace") },
      { role: "sidecar", path: join(base, "workspace/orca.permissions.json") },
      { role: "store", path: join(base, "workspace/.orca") },
    ],
    join(base, "control"),
    join(base, "releases"),
  );
  await writeFile(join(base, "control/never-typed"), `${digest(await readFile(id))}\n${binding.rootBindingRef}\n`, {
    mode: 0o600,
  });
  // A real supervisor-owned flock, not a boolean lifetime substitute.
  const lock = join(base, "lifetime.lock");
  const holder = spawn(
    "python3",
    [
      "-c",
      "import os,fcntl,sys\nf=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600)\nfcntl.flock(f,fcntl.LOCK_EX)\nprint(f,flush=True)\nsys.stdin.read()",
      lock,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  cleanup.push(async () => {
    holder.stdin.end();
    if (holder.exitCode === null) await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
  });
  const fd = await new Promise<number>((resolve, reject) => {
    holder.stdout.once("data", (b: Buffer) => resolve(Number(b.toString().trim())));
    holder.once("error", reject);
  });
  const identity = (path: string) => {
    const info = fs.lstatSync(path, { bigint: true });
    return [info.dev, info.ino, info.mode, info.uid, info.gid].join(":");
  };
  const originals = new Map(
    [
      base,
      ...[
        "workspace",
        "workspace/.orca",
        "workspace/.orca/workspace-identity",
        "control",
        "releases",
        "lifetime.lock",
        "workspace/.orca/workspace-identity/id",
      ].map((p) => join(base, p)),
    ].map((path) => [path, identity(path)]),
  );
  const identityBytes = fs.readFileSync(id);
  const image = new URL("./controlled-owned-read-producer.ts", import.meta.url);
  const imageBytes = fs.readFileSync(image),
    imageStamp = identity(image.pathname);
  const phases: string[] = [],
    observed: { phase: string; offset: number; length: number; bytes: string }[] = [];
  let phase = "outside";
  const check = (): undefined => {
    expect(holder.exitCode).toBeNull();
    expect(fs.readFileSync(`/proc/${holder.pid}/fdinfo/${fd}`, "utf8")).toMatch(/FLOCK\s+ADVISORY\s+WRITE /);
    for (const [path, stamp] of originals) expect(identity(path)).toBe(stamp);
    expect(digest(fs.readFileSync(id))).toBe(digest(identityBytes));
    expect(identity(image.pathname)).toBe(imageStamp);
    expect(digest(fs.readFileSync(image))).toBe(digest(imageBytes));
    return undefined;
  };
  const originalRead = fs.readSync;
  const spy = vi.spyOn(fs, "readSync").mockImplementation(((
    descriptor: number,
    bytes: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    const result = originalRead(descriptor, bytes, offset, length, position);
    const info = fs.fstatSync(descriptor);
    if (
      info.isFile() &&
      info.nlink === 0 &&
      info.size === Buffer.byteLength(content) &&
      (info.mode & 0o777) === 0o400
    ) {
      observed.push({
        phase,
        offset: position!,
        length,
        bytes: Buffer.from(bytes.buffer, bytes.byteOffset + offset, result).toString(),
      });
    }
    return result;
  }) as typeof fs.readSync);
  cleanup.push(async () => spy.mockRestore());
  const options: ControlledReadTestSupervisor = {
    content,
    offset: 2,
    length: 4,
    assertCurrent: check,
    ...(previous ? { bootstrap: previous } : {}),
    ...(fault ? { fault } : {}),
    phase: async (name, work) => {
      phases.push(name);
      phase = name;
      try {
        await work();
      } finally {
        phase = "outside";
      }
    },
  };
  return { base, lane, options, phases, observed, check, holder, image, originals, restore: () => spy.mockRestore() };
}
async function bootstrap() {
  const s = await supervisor("bootstrap");
  const result = await runControlledOwnedReadTest(s.base, "bootstrap", s.options);
  expect(s.observed).toEqual([{ phase: "bootstrap", offset: 2, length: 4, bytes: "spos" }]);
  expect(result.authorizationRefs).toHaveLength(1);
  s.restore();
  const ref = result.authorizationRefs[0]!;
  const protectedBytes = fs.readFileSync(
    join(s.base, "workspace/.orca/private-execution", `${encodeURIComponent(ref)}.payload.json`),
  );
  const grant = {
    evidenceRef: `test-supervisor-bootstrap:${digest(protectedBytes)}`,
    assertCurrent: (): undefined => {
      s.check();
      expect(
        digest(
          fs.readFileSync(join(s.base, "workspace/.orca/private-execution", `${encodeURIComponent(ref)}.payload.json`)),
        ),
      ).toBe(digest(protectedBytes));
      expect(s.observed).toEqual([{ phase: "bootstrap", offset: 2, length: 4, bytes: "spos" }]);
      return undefined;
    },
  };
  return { ...s, result, grant };
}
it("connects actual Save, separately settled original Allow once and fresh rule execution", async () => {
  const b = await bootstrap();
  const c = await supervisor("connected", b.grant);
  const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
  expect(c.phases).toEqual(["save", "human-read", "rule-read"]);
  expect(c.observed).toEqual([
    { phase: "human-read", offset: 2, length: 4, bytes: "spos" },
    { phase: "rule-read", offset: 2, length: 4, bytes: "spos" },
  ]);
  expect(result.initialRevision).not.toBe(result.finalRevision);
  const stores = fileStores(join(c.base, "workspace/.orca"));
  const records = await Promise.all(
    result.authorizationRefs.map((ref) => stores.execution.getPayload("controlled", ref, "agent.update")),
  );
  const values = records.map(
    (payload) =>
      JSON.parse((payload as { update: { text: string } }).update.text).value as {
        action: { invocation: { invocationId: string } };
        verdict: { authorizedBy: { kind: string; acceptedAnswerRef?: string } };
      },
  );
  expect(values.map((v) => v.verdict.authorizedBy.kind)).toEqual(["human", "rule"]);
  expect(values[0]!.action.invocation.invocationId).not.toBe(values[1]!.action.invocation.invocationId);
  const answers = await stores.events.readTypes("controlled", ["human.answered"]);
  expect(answers).toHaveLength(1);
  expect(values[0]!.verdict.authorizedBy.acceptedAnswerRef).toBe(JSON.stringify(["controlled", answers[0]!.id]));
  const approvals = await stores.events.readTypes("controlled", ["agent.permission"]);
  expect(approvals).toHaveLength(1);
  const approval = (await stores.execution.getPayload(
    "controlled",
    approvals[0]!.executionPayloadRef!,
    "agent.permission",
  )) as { entry: { requiredReview: string; persistenceReview: { result: string } } };
  expect(approval.entry.requiredReview).toBe("unavailable");
  expect(approval.entry.persistenceReview.result).toBe("passed");
}, 30000);
it.each([
  "review-proof",
  "reviewer-revoked",
  "stale-revision",
  "lost-ack",
  "cancel",
  "wrong-interval",
  "revoke-rule",
] as const)(
  "refuses %s without an extra read",
  async (fault) => {
    const b = await bootstrap();
    const c = await supervisor("connected", b.grant, fault);
    await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
    expect(c.observed.filter((r) => r.phase === "save")).toEqual([]);
    expect(c.observed.length).toBe(["wrong-interval", "revoke-rule"].includes(fault) ? 1 : 0);
  },
  30000,
);
it("refuses unknown bootstrap evidence before creating connected state", async () => {
  const c = await supervisor("connected");
  await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
  expect(c.phases).toEqual([]);
  expect(c.observed).toEqual([]);
});

it.each([false, true])(
  "awaits the genuine deferred final ack; lost=%s never grants read authority",
  async (lost) => {
    const b = await bootstrap();
    const c = await supervisor("connected", b.grant, lost ? "lost-ack" : undefined);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const atAck = new Promise<void>((resolve) => {
      entered = resolve;
    });
    c.options.settleOriginalDelivery = async () => {
      entered();
      await gate;
    };
    const running = runControlledOwnedReadTest(c.base, "connected", c.options);
    void running.catch(() => undefined);
    await Promise.race([
      atAck,
      running.then(() => {
        throw new Error("Completed before deferred ack");
      }),
    ]);
    const stores = fileStores(join(c.base, "workspace/.orca"));
    expect(await stores.events.readTypes("controlled", ["human.answered"])).toHaveLength(1);
    expect(c.observed).toEqual([]);
    let settled = false;
    void running
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    if (lost) {
      await expect(running).rejects.toThrow();
      expect(c.observed).toEqual([]);
    } else {
      await running;
      expect(c.observed.map((read) => read.phase)).toEqual(["human-read", "rule-read"]);
    }
  },
  30000,
);
it.each(["root", "lifetime"] as const)(
  "refuses actual changed %s after Save",
  async (fault) => {
    const b = await bootstrap();
    const c = await supervisor("connected", b.grant);
    const original = c.options.phase.bind(c.options);
    c.options.phase = async (name, work) => {
      if (name === "human-read") {
        if (fault === "root") {
          const path = join(c.base, "workspace/.orca/workspace-identity/id"),
            bytes = await readFile(path);
          await fs.promises.rename(path, `${path}.old`);
          await writeFile(path, bytes, { mode: 0o600 });
        } else {
          c.holder.stdin.end();
          await new Promise<void>((resolve) => c.holder.once("exit", () => resolve()));
        }
      }
      return original(name, work);
    };
    await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
    expect(c.observed).toEqual([]);
  },
  30000,
);

it.each(["reviewer", "proof", "actor"] as const)(
  "authenticates saved %s again after Save",
  async (fault) => {
    const b = await bootstrap();
    const c = await supervisor("connected", b.grant);
    const original = c.options.phase.bind(c.options);
    c.options.phase = (name, work) =>
      original(name, async () => {
        await work();
        if (name !== "save") return;
        const storeDir = join(c.base, "workspace/.orca"),
          stores = fileStores(storeDir);
        if (fault === "proof") {
          const saved = (await stores.events.readTypes("controlled", ["agent.permission"]))[0]!;
          const payload = (await stores.execution.getPayload(
            "controlled",
            saved.executionPayloadRef!,
            "agent.permission",
          )) as { entry: { persistenceReview: { sourceRefs: string[] } } };
          const path = join(
            storeDir,
            "private-execution",
            `${encodeURIComponent(payload.entry.persistenceReview.sourceRefs[0]!)}.payload.json`,
          );
          const bytes = await readFile(path);
          bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
          await writeFile(path, bytes);
        } else {
          const { CredentialStore } = await import("../../daemon/src/auth/credentials.js");
          const credentials = new CredentialStore({ file: join(c.base, "credentials.json") });
          const target = credentials
            .list()
            .find((record) => record.principal === `controlled-test-${fault === "actor" ? "operator" : "reviewer"}`)!;
          expect(await credentials.revoke(target.id)).toBe(true);
        }
      });
    await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
    expect(c.observed).toEqual([]);
  },
  30000,
);
