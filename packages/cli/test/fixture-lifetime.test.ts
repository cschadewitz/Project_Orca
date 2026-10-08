/** Barrier-controlled interruption regressions keep temporary roots until every writer settles. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FixtureLifetime } from "./fixture-lifetime.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it("owns a resource acquired after interrupted setup, before removing its root", async () => {
  const lifetime = new FixtureLifetime();
  const acquired = barrier();
  const resume = barrier();
  const order: string[] = [];
  lifetime.root(async () => {
    order.push("remove");
  });
  const setup = lifetime.run(async () => {
    acquired.release();
    await resume.promise;
    lifetime.own(async () => {
      order.push("close");
    });
    order.push("acquired");
  });
  await acquired.promise;
  const closing = lifetime.close();
  await expect(
    lifetime.run(async () => {
      order.push("late write");
    }),
  ).rejects.toThrow("Fixture is closing");
  expect(order).toEqual([]);
  resume.release();
  await setup;
  await closing;
  expect(order).toEqual(["acquired", "close", "remove"]);
  await lifetime.close();
  expect(order).toHaveLength(3);
});

it("settles a pending real write before resource close and a single recursive removal", async () => {
  const lifetime = new FixtureLifetime();
  const dir = await mkdtemp(join(tmpdir(), "orca-fixture-lifetime-"));
  const entered = barrier();
  const finish = barrier();
  let removed = false;
  lifetime.root(async () => {
    await rm(dir, { recursive: true });
    removed = true;
  });
  lifetime.own(async () => {
    expect(await readFile(join(dir, "receipt"), "utf8")).toBe("original");
  });
  const write = lifetime.run(async () => {
    entered.release();
    await finish.promise;
    await writeFile(join(dir, "receipt"), "original");
  });
  try {
    await entered.promise;
    const closing = lifetime.close();
    await Promise.resolve();
    expect(removed).toBe(false);
    finish.release();
    await write;
    await closing;
    expect(removed).toBe(true);
  } finally {
    finish.release();
    await write;
    await rm(dir, { recursive: true, force: true });
  }
});

it("settles rejected work and closes independent resources while retaining roots on shutdown failure", async () => {
  const lifetime = new FixtureLifetime();
  const order: string[] = [];
  lifetime.root(async () => {
    order.push("remove");
  });
  lifetime.own(async () => {
    order.push("independent close");
  });
  lifetime.own(async () => {
    throw new Error("cessation unavailable");
  });
  await expect(
    lifetime.run(async () => {
      throw new Error("original failure");
    }),
  ).rejects.toThrow("original failure");
  await expect(lifetime.close()).rejects.toThrow("roots retained");
  expect(order).toEqual(["independent close"]);
});
