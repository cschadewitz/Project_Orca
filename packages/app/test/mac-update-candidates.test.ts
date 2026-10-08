/** Local synthetic ports exercise consent/owned-download failures; no Mac binary, signature or native acceptance. */
import { mkdtemp, readFile, readdir, rm, stat, mkdir, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadMacCandidate,
  macSource,
  type MacCandidateBinding,
  type MacCandidateDownloadPorts,
  type MacNativeInspection,
  type MacCatalogVerdict,
} from "../src/main/mac-candidate-download.js";
import { readMacManifest, sha256 } from "../src/main/mac-candidate-manifest.js";
import { MacCandidateSession, type MacCandidateOffer } from "../src/main/mac-update-candidates.js";

const filesystemFaults = vi.hoisted(() => ({
  cleanup: new Set<string>(),
  writeGate: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (filesystemFaults.cleanup.has(String(args[0]))) throw new Error("Synthetic cleanup refusal");
      return actual.rm(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (typeof args[0] === "string" && args[0].endsWith("/native-mac-artifact.json"))
        await filesystemFaults.writeGate?.();
      return actual.writeFile(...args);
    },
  };
});
const fixture = new URL("../../../tools/deploy/tests/native-mac/fixtures/valid/", import.meta.url);
const target = {
  workspaceId: "973de3ea-4338-4af5-850b-d44a5f1fb889",
  instanceId: "92b1e198-29dd-4e6d-8ee9-9d58ea5f7d8f",
  epoch: 1,
};
const source = "https://delivery.invalid/invited/";
const roots: string[] = [];
const signal = () => new AbortController().signal;
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function response(url: string, data: BodyInit | Uint8Array | null, status = 200): Response {
  const value = new Response(data instanceof Uint8Array ? new Uint8Array(data).buffer : data, { status });
  Object.defineProperty(value, "url", { value: url });
  return value;
}
async function rig() {
  const root = await mkdtemp(join(tmpdir(), "orca-mac-candidate-test-"));
  roots.push(root);
  // Candidate-SHAPED synthetic metadata is used only with fake trust ports. The unchanged
  // fixture validator still rejects candidates; none of these bytes are signed artifacts.
  const manifest = readMacManifest(await readFile(new URL("delivery/native-mac-artifact.json", fixture)));
  manifest.kind = "candidate";
  manifest.signing.teamId = "Q2FP9UY5T4";
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const identity = await readFile(new URL("ORCA.app/Contents/Resources/orca-build.json", fixture));
  const files = new Map<string, Buffer>();
  for (const record of [...manifest.artifacts, ...manifest.evidence])
    files.set(record.path, await readFile(new URL(`delivery/${record.path}`, fixture)));
  files.set(
    "SHA256SUMS",
    Buffer.from(
      [
        ["native-mac-artifact.json", sha256(bytes)],
        ...[...manifest.artifacts, ...manifest.evidence].map((file) => [file.path, file.sha256]),
      ]
        .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0))
        .map(([path, hash]) => `${hash}  ${path}\n`)
        .join(""),
    ),
  );
  const input: MacCandidateOffer = {
    manifestBytes: bytes,
    source,
    channel: "invited-beta",
    compatibilityPlanId: "synthetic-compat-plan",
    recoveryPlanId: "synthetic-whole-state-plan",
  };
  const binding: MacCandidateBinding = {
    manifest,
    source,
    candidate: {
      manifestSha256: sha256(bytes),
      channel: input.channel,
      compatibilityPlanId: input.compatibilityPlanId,
      recoveryPlanId: input.recoveryPlanId,
    },
  };
  const catalog = vi.fn(async (): Promise<MacCatalogVerdict> => "trusted");
  const inspect = vi.fn(async (_binding: MacCandidateBinding, directory: string): Promise<MacNativeInspection> => {
    for (const [path, content] of files) expect(await readFile(join(directory, path))).toEqual(content);
    expect(await readFile(join(directory, "native-mac-artifact.json"))).toEqual(bytes);
    return {
      outcome: "verified",
      manifestSha256: binding.candidate.manifestSha256,
      copies: ["dmg", "zip"].map((format) => ({
        format: format as "dmg" | "zip",
        identityBytes: identity,
        daemonSha256: manifest.identity.daemon.sha256,
      })),
    };
  });
  const fetch = vi.fn(async (url: string, _init: Parameters<MacCandidateDownloadPorts["fetch"]>[1]) => {
    const path = new URL(url).pathname
      .slice(new URL(source).pathname.length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    return response(url, files.get(path)!);
  });
  const ports: MacCandidateDownloadPorts = {
    root,
    limits: { fileBytes: 100_000, totalBytes: 1_000_000, operationMs: 10_000 },
    trust: { catalog, inspect },
    fetch,
  };
  const session = new MacCandidateSession(ports);
  const offer = async () => {
    const result = await session.offer(input, target, signal());
    expect(result.outcome).toBe("available");
    if (result.outcome !== "available") throw new Error("Synthetic offer unavailable");
    return result.offerId;
  };
  return { root, manifest, bytes, identity, files, input, binding, catalog, inspect, fetch, ports, session, offer };
}
afterEach(async () => {
  vi.useRealTimers();
  filesystemFaults.cleanup.clear();
  filesystemFaults.writeGate = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("main-only candidate binding and consent", () => {
  it("refuses missing policy without catalog, filesystem or network access", async () => {
    const r = await rig();
    expect(await new MacCandidateSession().offer(r.input, target, signal())).toEqual({ outcome: "refused" });
    expect(r.catalog).not.toHaveBeenCalled();
    expect(r.fetch).not.toHaveBeenCalled();
    expect(await readdir(r.root)).toEqual([]);
  });
  it("rejects fixture declarations even when the injected catalog would trust them", async () => {
    const r = await rig();
    const bytes = await readFile(new URL("delivery/native-mac-artifact.json", fixture));
    expect(await r.session.offer({ ...r.input, manifestBytes: bytes }, target, signal())).toEqual({
      outcome: "refused",
    });
    expect(r.catalog).not.toHaveBeenCalled();
    expect(
      await downloadMacCandidate(
        { ...r.binding, candidate: { ...r.binding.candidate, manifestSha256: sha256(bytes) } },
        bytes,
        r.ports,
        signal(),
      ),
    ).toEqual({ outcome: "failed" });
    expect(r.fetch).not.toHaveBeenCalled();
  });
  it("refuses missing native policy and malformed metadata without trusting or downloading", async () => {
    const r = await rig();
    const partial = { ...r.ports, trust: { catalog: r.catalog } } as unknown as MacCandidateDownloadPorts;
    expect(await new MacCandidateSession(partial).offer(r.input, target, signal())).toEqual({ outcome: "refused" });
    expect(
      await r.session.offer(
        { ...r.input, manifestBytes: Buffer.from('{"schemaVersion":1,"schemaVersion":1}') },
        target,
        signal(),
      ),
    ).toEqual({ outcome: "refused" });
    expect(r.catalog).not.toHaveBeenCalled();
    expect(r.fetch).not.toHaveBeenCalled();
  });
  it("binds immutable exact bytes and plans before an asynchronous trust decision, with no preapproval download", async () => {
    const r = await rig();
    const deciding = pending<"trusted">();
    const entered = pending<MacCandidateBinding>();
    r.catalog.mockImplementationOnce(async (...args: unknown[]) => {
      entered.resolve(args[0] as MacCandidateBinding);
      return deciding.promise;
    });
    const mutable = { ...r.input, manifestBytes: Buffer.from(r.bytes) };
    const mutableTarget = { ...target };
    const offered = r.session.offer(mutable, mutableTarget, signal());
    const captured = await entered.promise;
    mutable.manifestBytes.fill(0);
    mutable.channel = "other";
    mutable.recoveryPlanId = "other";
    mutableTarget.instanceId = "other";
    expect(captured.candidate).toEqual(r.binding.candidate);
    expect(Object.isFrozen(captured.manifest.identity)).toBe(true);
    deciding.resolve("trusted");
    expect((await offered).outcome).toBe("available");
    expect(r.fetch).not.toHaveBeenCalled();
    expect(await readdir(r.root)).toEqual([]);
  });
  it("keeps known catalog refusal and unknown trust distinct, including thrown errors", async () => {
    const r = await rig();
    r.catalog
      .mockResolvedValueOnce("refused")
      .mockResolvedValueOnce("unknown")
      .mockRejectedValueOnce(new Error("private-url/token"));
    expect(await r.session.offer(r.input, target, signal())).toEqual({ outcome: "refused" });
    expect(await r.session.offer(r.input, target, signal())).toEqual({ outcome: "unknown" });
    expect(await r.session.offer(r.input, target, signal())).toEqual({ outcome: "unknown" });
    expect(r.fetch).not.toHaveBeenCalled();
  });
  it("rejects changed source/plan substitution while an offer exists", async () => {
    const r = await rig();
    const id = await r.offer();
    expect(
      await r.session.offer({ ...r.input, source: "https://substitute.invalid/", channel: "other" }, target, signal()),
    ).toEqual({ outcome: "busy" });
    expect(r.session.state.offerId).toBe(id);
    expect(r.catalog).toHaveBeenCalledTimes(1);
    await r.session.approve(id);
    expect(r.fetch.mock.calls.every(([url]) => url.startsWith(source))).toBe(true);
  });
  it("requires new process-local approval for a same-version rebuild, and ignores replayed approval IDs", async () => {
    const r = await rig();
    const first = await r.offer();
    expect(r.session.defer(first)).toBe(true);
    const rebuilt = readMacManifest(r.bytes);
    rebuilt.identity.buildId = "gha:0:1:mac-arm64";
    rebuilt.identitySha256 = sha256(Buffer.from(JSON.stringify(rebuilt.identity)));
    const second = await r.session.offer(
      { ...r.input, manifestBytes: Buffer.from(JSON.stringify(rebuilt)) },
      target,
      signal(),
    );
    expect(second.outcome).toBe("available");
    if (second.outcome !== "available") throw new Error("Synthetic rebuild unavailable");
    expect(second.offerId).not.toBe(first);
    expect((await r.session.approve(first)).phase).toBe("available");
    expect((await new MacCandidateSession(r.ports).approve(second.offerId)).phase).toBe("idle");
    expect(r.fetch).not.toHaveBeenCalled();
  });
  it("defers metadata replay decisions to the required catalog policy", async () => {
    const r = await rig();
    const first = await r.offer();
    r.session.defer(first);
    r.catalog.mockResolvedValueOnce("refused");
    expect(await r.session.offer(r.input, target, signal())).toEqual({ outcome: "refused" });
    expect(r.fetch).not.toHaveBeenCalled();
  });
  it("serializes duplicate approval and remains blocked after verification with no activation", async () => {
    const r = await rig();
    const id = await r.offer();
    const delayed = pending<Response>();
    const entered = pending<string>();
    r.fetch.mockImplementationOnce(async (url) => {
      entered.resolve(url);
      return delayed.promise;
    });
    const approving = r.session.approve(id);
    const url = await entered.promise;
    expect((await r.session.approve(id)).phase).toBe("downloading");
    delayed.resolve(response(url, r.files.get(r.manifest.artifacts[0]!.path)!));
    expect(await approving).toEqual({ phase: "waiting", blocker: "candidate", offerId: id });
    expect(r.session.verification).toBe("verified");
    expect(r.inspect).toHaveBeenCalledTimes(1);
    expect(r.fetch).toHaveBeenCalledTimes(r.files.size);
    await r.session.approve(id);
    expect(r.fetch).toHaveBeenCalledTimes(r.files.size);
    for (const [, init] of r.fetch.mock.calls)
      expect(init).toMatchObject({ redirect: "manual", credentials: "omit", cache: "no-store" });
  });
  it("aborts a deferred download and cancels a late response without resurrecting approval or files", async () => {
    const r = await rig();
    const id = await r.offer();
    const delayed = pending<Response>();
    const entered = pending<string>();
    r.fetch.mockImplementationOnce(async (url) => {
      entered.resolve(url);
      return delayed.promise;
    });
    const approving = r.session.approve(id);
    const url = await entered.promise;
    expect(r.session.defer(id)).toBe(true);
    expect((await approving).phase).toBe("deferred");
    expect(await readdir(r.root)).toEqual([]);
    const cancelled = pending<void>();
    delayed.resolve(
      response(
        url,
        new ReadableStream({
          cancel() {
            cancelled.resolve();
          },
        }),
      ),
    );
    await cancelled.promise;
    expect(await readdir(r.root)).toEqual([]);
    expect(r.session.state.phase).toBe("deferred");
    expect(r.inspect).not.toHaveBeenCalled();
  });
  it("waits for an outstanding owned write after defer before returning or deleting the directory", async () => {
    const r = await rig();
    const id = await r.offer();
    const entered = pending<void>();
    const finish = pending<void>();
    filesystemFaults.writeGate = async () => {
      entered.resolve();
      await finish.promise;
    };
    let settled = false;
    const approving = r.session.approve(id).finally(() => {
      settled = true;
    });
    await entered.promise;
    expect(r.session.defer(id)).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(await readdir(r.root)).toHaveLength(1);
    finish.resolve();
    expect((await approving).phase).toBe("deferred");
    expect(await readdir(r.root)).toEqual([]);
    expect(r.fetch).not.toHaveBeenCalled();
  });
  it("distinguishes uncertain cleanup and seals against retry while preserving its owned directory", async () => {
    const r = await rig();
    const id = await r.offer();
    const entered = pending<void>();
    r.fetch.mockImplementationOnce(async () => {
      entered.resolve();
      return new Promise<Response>(() => undefined);
    });
    const approving = r.session.approve(id);
    await entered.promise;
    const [name] = await readdir(r.root);
    filesystemFaults.cleanup.add(join(r.root, name!));
    r.session.defer(id);
    expect((await approving).phase).toBe("deferred");
    expect(r.session.verification).toBe("unknown");
    expect(await readdir(r.root)).toEqual([name]);
    expect(await r.session.offer(r.input, target, signal())).toEqual({ outcome: "unknown" });
    await r.session.approve(id);
    expect(r.fetch).toHaveBeenCalledTimes(1);
  });
  it("discards only its completed download on defer, leaving an unrelated owned file untouched", async () => {
    const r = await rig();
    await mkdir(join(r.root, "unrelated"), { mode: 0o700 });
    const id = await r.offer();
    await r.session.approve(id);
    expect(await readdir(r.root)).toHaveLength(2);
    r.session.defer(id);
    // A cleanup in progress refuses re-offer; completion is observable through the filesystem.
    expect((await r.session.offer(r.input, target, signal())).outcome).toBe("busy");
    await vi.waitFor(async () => {
      expect(await readdir(r.root)).toEqual(["unrelated"]);
    });
  });
  it("retires a disposed offer and requires fresh catalog resolution after revocation", async () => {
    const r = await rig();
    const id = await r.offer();
    await r.session.approve(id);
    expect(r.session.verification).toBe("verified");
    const catalogCalls = r.catalog.mock.calls.length;
    const fetchCalls = r.fetch.mock.calls.length;
    r.session.defer(id);
    await vi.waitFor(async () => {
      expect(await readdir(r.root)).toEqual([]);
    });
    expect(r.session.verification).toBeUndefined();
    r.catalog.mockResolvedValue("refused");
    expect((await r.session.approve(id)).phase).toBe("deferred");
    expect(r.catalog).toHaveBeenCalledTimes(catalogCalls);
    expect(await r.session.offer(r.input, target, signal())).toEqual({ outcome: "refused" });
    expect(r.catalog).toHaveBeenCalledTimes(catalogCalls + 1);
    expect(r.fetch).toHaveBeenCalledTimes(fetchCalls);
    expect(r.inspect).toHaveBeenCalledTimes(1);
    expect(await readdir(r.root)).toEqual([]);
  });
  it("reacquires verified byte ownership only with a fresh offer, approval and native inspection after defer", async () => {
    const r = await rig();
    const first = await r.offer();
    await r.session.approve(first);
    const [oldDirectory] = await readdir(r.root);
    r.session.defer(first);
    await vi.waitFor(async () => {
      expect(await readdir(r.root)).toEqual([]);
    });
    expect(r.session.verification).toBeUndefined();
    expect((await r.session.approve(first)).phase).toBe("deferred");
    const second = await r.offer();
    expect(second).not.toBe(first);
    expect(await r.session.approve(first)).toEqual({ phase: "available", offerId: second });
    expect(await r.session.approve(second)).toEqual({ phase: "waiting", blocker: "candidate", offerId: second });
    expect(r.session.verification).toBe("verified");
    const [newDirectory] = await readdir(r.root);
    expect(newDirectory).toBeTruthy();
    expect(newDirectory).not.toBe(oldDirectory);
    expect(r.catalog).toHaveBeenCalledTimes(6);
    expect(r.fetch).toHaveBeenCalledTimes(2 * r.files.size);
    expect(r.inspect).toHaveBeenCalledTimes(2);
  });
});

describe("bounded owned download and verification", () => {
  it("snapshots standalone download bytes, source, records and storage configuration before awaiting trust", async () => {
    const r = await rig();
    const deciding = pending<"trusted">();
    const entered = pending<MacCandidateBinding>();
    r.catalog.mockImplementationOnce(async (...args: unknown[]) => {
      entered.resolve(args[0] as MacCandidateBinding);
      return deciding.promise;
    });
    const downloading = downloadMacCandidate(r.binding, r.bytes, r.ports, signal());
    const captured = await entered.promise;
    const digest = captured.candidate.manifestSha256;
    r.bytes.fill(0);
    r.manifest.artifacts[0]!.path = "../substitution";
    Object.assign(r.binding, { source: "https://substitute.invalid/" });
    Object.assign(r.binding.candidate, { recoveryPlanId: "substitution" });
    Object.assign(r.ports, { root: "/nonexistent-synthetic-root" });
    r.inspect.mockResolvedValueOnce({
      outcome: "verified",
      manifestSha256: digest,
      copies: [
        { format: "dmg", identityBytes: r.identity, daemonSha256: captured.manifest.identity.daemon.sha256 },
        { format: "zip", identityBytes: r.identity, daemonSha256: captured.manifest.identity.daemon.sha256 },
      ],
    });
    deciding.resolve("trusted");
    const result = await downloading;
    expect(result.outcome).toBe("verified");
    if (result.outcome !== "verified") throw new Error("Synthetic snapshot verification failed");
    expect(result.owned.directory.startsWith(`${r.root}/`)).toBe(true);
    expect(r.fetch.mock.calls.every(([url]) => url.startsWith(source))).toBe(true);
    expect(await result.owned.discard()).toBe("released");
  });
  it("escapes literal percent path components and matches delivery-v1 Unicode checksum ordering", async () => {
    const r = await rig();
    for (const path of ["evidence/%2e%2e/literal.txt", "evidence/\ue000.txt", "evidence/\u{1f600}.txt"]) {
      const content = Buffer.from("synthetic evidence\n");
      r.manifest.evidence.push({ path, sha256: sha256(content), bytes: content.length });
      r.files.set(path, content);
    }
    const bytes = Buffer.from(JSON.stringify(r.manifest));
    const digest = sha256(bytes);
    const entries = [
      ["native-mac-artifact.json", digest],
      ...[...r.manifest.artifacts, ...r.manifest.evidence].map((record) => [record.path, record.sha256]),
    ];
    const sums = entries
      .sort(([a], [b]) => Buffer.compare(Buffer.from(a!), Buffer.from(b!)))
      .map(([path, hash]) => `${hash}  ${path}\n`)
      .join("");
    expect(sums.indexOf("\ue000.txt")).toBeLessThan(sums.indexOf("\u{1f600}.txt"));
    r.files.set("SHA256SUMS", Buffer.from(sums));
    r.inspect.mockResolvedValueOnce({
      outcome: "verified",
      manifestSha256: digest,
      copies: [
        { format: "dmg", identityBytes: r.identity, daemonSha256: r.manifest.identity.daemon.sha256 },
        { format: "zip", identityBytes: r.identity, daemonSha256: r.manifest.identity.daemon.sha256 },
      ],
    });
    const result = await downloadMacCandidate(
      { ...r.binding, candidate: { ...r.binding.candidate, manifestSha256: digest } },
      bytes,
      r.ports,
      signal(),
    );
    expect(result.outcome).toBe("verified");
    if (result.outcome !== "verified") throw new Error("Synthetic Unicode verification failed");
    expect(r.fetch.mock.calls.some(([url]) => url.includes("evidence/%252e%252e/literal.txt"))).toBe(true);
    expect(await readFile(join(result.owned.directory, "evidence/%2e%2e/literal.txt"), "utf8")).toBe(
      "synthetic evidence\n",
    );
    expect(await result.owned.discard()).toBe("released");
  });
  it("verifies exact complete delivery files in a private new directory and releases that directory", async () => {
    const r = await rig();
    const result = await downloadMacCandidate(r.binding, r.bytes, r.ports, signal());
    expect(result.outcome).toBe("verified");
    if (result.outcome !== "verified") throw new Error("Synthetic verification failed");
    expect((await stat(result.owned.directory)).mode & 0o077).toBe(0);
    expect((await stat(join(result.owned.directory, "native-mac-artifact.json"))).mode & 0o077).toBe(0);
    expect(r.catalog).toHaveBeenCalledTimes(2);
    expect(await result.owned.discard()).toBe("released");
    expect(await readdir(r.root)).toEqual([]);
  });
  it.each(["hash", "short", "long", "checksum-inventory", "manifest-substitution"])(
    "rejects %s mismatch and settles cleanup",
    async (kind) => {
      const r = await rig();
      const first = r.manifest.artifacts[0]!.path;
      if (kind === "hash") r.files.set(first, Buffer.alloc(64));
      if (kind === "short") r.files.set(first, Buffer.alloc(63));
      if (kind === "long") r.files.set(first, Buffer.alloc(65));
      if (kind === "checksum-inventory") r.files.set("SHA256SUMS", Buffer.from("unexpected\n"));
      const bytes = kind === "manifest-substitution" ? Buffer.from(`${r.bytes.toString()} `) : r.bytes;
      expect(await downloadMacCandidate(r.binding, bytes, r.ports, signal())).toEqual({ outcome: "failed" });
      expect(await readdir(r.root)).toEqual([]);
      expect(r.inspect).not.toHaveBeenCalled();
    },
  );
  it.each(["redirect-status", "redirected", "wrong-origin", "wrong-path"])(
    "refuses hostile %s without following or authenticating redirects",
    async (kind) => {
      const r = await rig();
      r.fetch.mockImplementationOnce(async (url) => {
        const value = response(
          kind === "wrong-origin" ? "https://attacker.invalid/payload" : kind === "wrong-path" ? `${source}other` : url,
          "payload",
          kind === "redirect-status" ? 302 : 200,
        );
        if (kind === "redirected") Object.defineProperty(value, "redirected", { value: true });
        return value;
      });
      expect(await downloadMacCandidate(r.binding, r.bytes, r.ports, signal())).toEqual({ outcome: "failed" });
      expect(r.fetch).toHaveBeenCalledTimes(1);
      expect(await readdir(r.root)).toEqual([]);
    },
  );
  it("refuses unsafe origin syntax before any download", async () => {
    const r = await rig();
    for (const url of [
      "http://delivery.invalid/",
      "https://user:secret@delivery.invalid/",
      `${source}?token=secret`,
      `${source}#fragment`,
      "https://delivery.invalid/path",
    ])
      expect(macSource(url)).toBeUndefined();
    expect(
      await r.session.offer({ ...r.input, source: "https://user:secret@delivery.invalid/" }, target, signal()),
    ).toEqual({ outcome: "refused" });
    expect(r.catalog).not.toHaveBeenCalled();
  });
  it.each(["artifact-size", "total-size", "invalid-bound"])(
    "refuses %s limits before filesystem/network work",
    async (kind) => {
      const r = await rig();
      const limits =
        kind === "artifact-size"
          ? { ...r.ports.limits, fileBytes: 63 }
          : kind === "total-size"
            ? { ...r.ports.limits, totalBytes: 1 }
            : { ...r.ports.limits, operationMs: Infinity };
      expect(await downloadMacCandidate(r.binding, r.bytes, { ...r.ports, limits }, signal())).toEqual({
        outcome: "failed",
      });
      expect(r.fetch).not.toHaveBeenCalled();
      expect(await readdir(r.root)).toEqual([]);
    },
  );
  it("refuses public or linked storage roots without changing their permissions", async () => {
    const r = await rig();
    const publicRoot = join(r.root, "public");
    await mkdir(publicRoot, { mode: 0o755 });
    // Disposable negative fixture: the executor's restrictive umask masks mkdir's requested mode.
    await chmod(publicRoot, 0o755);
    const linked = join(r.root, "linked");
    await symlink(r.root, linked);
    for (const root of [publicRoot, linked])
      expect(await downloadMacCandidate(r.binding, r.bytes, { ...r.ports, root }, signal())).toEqual({
        outcome: "failed",
      });
    expect((await stat(publicRoot)).mode & 0o077).not.toBe(0);
    expect(r.fetch).not.toHaveBeenCalled();
  });
  it("rejects stream interruption after a partial write and awaits closure/cleanup", async () => {
    const r = await rig();
    r.fetch.mockImplementationOnce(async (url) => {
      let pulls = 0;
      return response(
        url,
        new ReadableStream({
          pull(controller) {
            if (pulls++ === 0) controller.enqueue(new Uint8Array(32));
            else controller.error(new Error("private transport error"));
          },
        }),
      );
    });
    expect(await downloadMacCandidate(r.binding, r.bytes, r.ports, signal())).toEqual({ outcome: "failed" });
    expect(await readdir(r.root)).toEqual([]);
    expect(r.inspect).not.toHaveBeenCalled();
  });
  it("refuses empty stream chunks that could otherwise starve bounds and the operation timer", async () => {
    const r = await rig();
    r.fetch.mockImplementationOnce(async (url) =>
      response(
        url,
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array());
          },
        }),
      ),
    );
    expect(await downloadMacCandidate(r.binding, r.bytes, r.ports, signal())).toEqual({ outcome: "failed" });
    expect(await readdir(r.root)).toEqual([]);
    expect(r.inspect).not.toHaveBeenCalled();
  });
  it("bounds a stalled body read, cancels it, and removes partial files without timer inflation", async () => {
    const r = await rig();
    const entered = pending<void>();
    const cancelled = pending<void>();
    r.fetch.mockImplementationOnce(async (url) =>
      response(
        url,
        new ReadableStream({
          start() {
            entered.resolve();
          },
          cancel() {
            cancelled.resolve();
          },
        }),
      ),
    );
    vi.useFakeTimers();
    const downloading = downloadMacCandidate(
      r.binding,
      r.bytes,
      { ...r.ports, limits: { ...r.ports.limits, operationMs: 50 } },
      signal(),
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(50);
    expect(await downloading).toEqual({ outcome: "failed" });
    await cancelled.promise;
    expect(await readdir(r.root)).toEqual([]);
  });
  it.each(["identity-digest", "external-identity", "daemon", "container", "manifest"])(
    "rejects synthetic native proof with wrong %s binding",
    async (kind) => {
      const r = await rig();
      const proof: Extract<MacNativeInspection, { outcome: "verified" }> = {
        outcome: "verified",
        manifestSha256: r.binding.candidate.manifestSha256,
        copies: [
          { format: "dmg", identityBytes: r.identity, daemonSha256: r.manifest.identity.daemon.sha256 },
          { format: "zip", identityBytes: r.identity, daemonSha256: r.manifest.identity.daemon.sha256 },
        ],
      };
      const copies = proof.copies.map((copy) => ({ ...copy }));
      if (kind === "identity-digest") copies[0]!.identityBytes = Buffer.concat([r.identity, Buffer.from(" ")]);
      if (kind === "external-identity") copies[0]!.identityBytes = Buffer.from("{}");
      if (kind === "daemon") copies[1]!.daemonSha256 = "a".repeat(64);
      if (kind === "container") copies[1]!.format = "dmg";
      r.inspect.mockResolvedValueOnce({
        ...proof,
        manifestSha256: kind === "manifest" ? "a".repeat(64) : proof.manifestSha256,
        copies,
      });
      expect(await downloadMacCandidate(r.binding, r.bytes, r.ports, signal())).toEqual({ outcome: "failed" });
      expect(await readdir(r.root)).toEqual([]);
    },
  );
  it("rechecks catalog trust after download and refuses revocation before publishing verified ownership", async () => {
    const r = await rig();
    r.catalog.mockResolvedValueOnce("trusted").mockResolvedValueOnce("refused");
    expect(await downloadMacCandidate(r.binding, r.bytes, r.ports, signal())).toEqual({ outcome: "failed" });
    expect(r.inspect).toHaveBeenCalledTimes(1);
    expect(await readdir(r.root)).toEqual([]);
  });
  it("seals the candidate session on unknown native verification and reports that distinctly", async () => {
    const r = await rig();
    const id = await r.offer();
    r.inspect.mockResolvedValueOnce({ outcome: "unknown" });
    expect((await r.session.approve(id)).phase).toBe("failed");
    expect(r.session.verification).toBe("unknown");
    expect(await r.session.offer(r.input, target, signal())).toEqual({ outcome: "unknown" });
    await r.session.approve(id);
    expect(r.inspect).toHaveBeenCalledTimes(1);
    expect(await readdir(r.root)).toEqual([]);
  });
  it.each(["undefined", "null", "unrecognized-outcome", "missing-copies", "malformed-copy", "throwing-outcome"])(
    "seals malformed native inspection %s as unknown instead of permitting another offer",
    async (kind) => {
      const r = await rig();
      const id = await r.offer();
      const malformed: unknown =
        kind === "undefined"
          ? undefined
          : kind === "null"
            ? null
            : kind === "unrecognized-outcome"
              ? { outcome: "invalid" }
              : kind === "missing-copies"
                ? { outcome: "verified", manifestSha256: r.binding.candidate.manifestSha256 }
                : kind === "malformed-copy"
                  ? { outcome: "verified", manifestSha256: r.binding.candidate.manifestSha256, copies: [null, null] }
                  : {
                      get outcome() {
                        throw new Error("Synthetic unreadable native result");
                      },
                    };
      r.inspect.mockResolvedValueOnce(malformed as MacNativeInspection);
      expect((await r.session.approve(id)).phase).toBe("failed");
      expect(r.session.verification).toBe("unknown");
      expect(await r.session.offer(r.input, target, signal())).toEqual({ outcome: "unknown" });
      await r.session.approve(id);
      expect(r.inspect).toHaveBeenCalledTimes(1);
      expect(await readdir(r.root)).toEqual([]);
    },
  );
  it("preserves a valid explicit native refusal as a known negative that permits fresh catalog resolution", async () => {
    const r = await rig();
    const id = await r.offer();
    r.inspect.mockResolvedValueOnce({ outcome: "refused" });
    expect((await r.session.approve(id)).phase).toBe("failed");
    expect(r.session.verification).toBe("failed");
    expect((await r.session.offer(r.input, target, signal())).outcome).toBe("available");
    expect(await readdir(r.root)).toEqual([]);
  });
});
