/** Setup owners and logical publication waits retain bounded evidence without changing failure or cleanup. */
import { access } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { afterEach, expect, it, vi } from "vitest";
import { ProductionFixture, type Peer } from "./mcp-operator-production-fixture.js";

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  ["daemon.boot", false],
  ["credential.issue", false],
  ["daemon.boot", true],
  ["credential.issue", true],
] as const)(
  "publishes rejected %s evidence before actual setup cleanup (publication throws=%s)",
  async (stage, publicationThrows) => {
    const error = new Error("SYNTHETIC_PRIVATE_SETUP_FAILURE");
    const publication = vi.spyOn(console, "error").mockImplementation(() => {
      if (publicationThrows) throw new Error("Synthetic publication refusal");
    });
    if (stage === "daemon.boot") {
      vi.spyOn(ProductionFixture.prototype, "boot").mockImplementation(function (this: ProductionFixture) {
        return this.progress.measure(stage, async () => {
          throw error;
        });
      });
    } else {
      vi.spyOn(ProductionFixture.prototype, "issue").mockImplementation(function (this: ProductionFixture) {
        return this.progress.measure(stage, async () => {
          throw error;
        });
      });
    }
    let dir = "";
    let publicationsAtCleanup = 0;
    const close = vi.spyOn(ProductionFixture.prototype, "close");
    close.mockImplementation(function (this: ProductionFixture) {
      dir = this.dir;
      publicationsAtCleanup = publication.mock.calls.length;
      close.mockRestore();
      return this.close();
    });
    await expect(ProductionFixture.create()).rejects.toBe(error);
    expect(publicationsAtCleanup).toBe(1);
    expect(publication).toHaveBeenCalledTimes(1);
    const evidence = JSON.parse(publication.mock.calls[0]![1] as string) as {
      recent: { stage: string; outcome: string }[];
    };
    expect(evidence.recent).toContainEqual({ stage, elapsedMs: expect.any(Number), outcome: "rejected" });
    expect(JSON.stringify(evidence)).not.toContain("SYNTHETIC_PRIVATE");
    await expect(access(dir)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("exposes a pending setup owner for timeout evidence and emits once before setup-owned cleanup", async () => {
  const entered = deferred<ProductionFixture>();
  const resume = deferred<void>();
  const error = new Error("Synthetic setup interruption");
  const publication = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(ProductionFixture.prototype, "boot").mockImplementation(function (this: ProductionFixture) {
    return this.progress.measure("daemon.boot", async () => {
      entered.resolve(this);
      await resume.promise;
      throw error;
    });
  });
  let acquired: ProductionFixture | undefined;
  const setup = ProductionFixture.create((owner) => {
    acquired = owner;
  });
  const outcome = setup.catch((failure: unknown) => failure);
  try {
    const owner = await entered.promise;
    expect(acquired).toBe(owner);
    expect(publication).not.toHaveBeenCalled();
    owner.reportFailure();
    const snapshot = JSON.parse(publication.mock.calls[0]![1] as string) as {
      active: { stage: string; elapsedMs: number }[];
    };
    expect(snapshot.active).toContainEqual({ stage: "daemon.boot", elapsedMs: expect.any(Number) });
    await access(owner.dir);
    resume.resolve(undefined);
    expect(await outcome).toBe(error);
    // create's rejection path shares publication with the timeout hook.
    expect(publication).toHaveBeenCalledTimes(1);
    await expect(access(owner.dir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    resume.resolve(undefined);
    await outcome;
  }
});

const peer = (): Peer => ({
  client: new Client({ name: "wait-evidence-test", version: "test" }),
  token: "synthetic-peer",
  transport: "stdio",
  endpoint: "http://127.0.0.1:0",
  target: { workspaceId: "synthetic-workspace", instanceId: "synthetic-instance" },
});

it.each(["input", "boundary", "status"] as const)(
  "records the whole %s observation while a read is held and after its original rejection",
  async (wait) => {
    const f = new ProductionFixture();
    const owner = peer();
    const entered = deferred<void>();
    const resume = deferred<void>();
    const error = new Error("SYNTHETIC_PRIVATE_OBSERVATION_FAILURE");
    let clock = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const held = async () => {
      entered.resolve(undefined);
      await resume.promise;
      throw error;
    };
    const events = vi.spyOn(f, "observedEvents").mockImplementation(held);
    const page = vi.spyOn(f, "page").mockImplementation(held);
    vi.spyOn(f, "readyStatus").mockResolvedValue(undefined);
    const reading =
      wait === "input"
        ? f.readyInput(owner, "synthetic-run")
        : wait === "boundary"
          ? f.boundary(owner, "synthetic-run")
          : f.status(owner, "synthetic-run", "succeeded");
    // Attach rejection handling before any assertion can release the held read.
    const outcome = reading.catch((failure: unknown) => failure);
    try {
      await entered.promise;
      clock = 145;
      const stage = wait === "status" ? "wait.succeeded" : `wait.${wait}`;
      expect(f.progress.snapshot().active).toContainEqual({ stage, elapsedMs: 45 });
      resume.resolve(undefined);
      expect(await outcome).toBe(error);
      expect(f.progress.snapshot().recent).toContainEqual({ stage, elapsedMs: 45, outcome: "rejected" });
      expect(f.progress.snapshot().active).toEqual([]);
      if (wait === "input") expect(events).toHaveBeenCalledExactlyOnceWith(owner, "synthetic-run");
      else expect(page).toHaveBeenCalledExactlyOnceWith(owner, "runs", { runId: "synthetic-run" });
      expect(JSON.stringify(f.progress.snapshot())).not.toContain("SYNTHETIC_PRIVATE");
    } finally {
      resume.resolve(undefined);
      await outcome;
    }
  },
);
