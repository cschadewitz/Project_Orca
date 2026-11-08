/** Real disposable composition. Test supervisor identities/profile are explicit assumptions.
 * OS reads are independently intercepted by this test; external syscall acceptance is separate.
 */
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fileStores } from "@orca/store";
import { runControlledOwnedReadTest } from "./controlled-owned-read-producer.js";
import { bootstrap, supervisor } from "./controlled-owned-read-fixture.js";

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

it.each(["reviewer", "proof", "standing-proof", "actor"] as const)(
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
        if (fault === "proof" || fault === "standing-proof") {
          const saved = (await stores.events.readTypes("controlled", ["agent.permission"]))[0]!;
          const payload = (await stores.execution.getPayload(
            "controlled",
            saved.executionPayloadRef!,
            "agent.permission",
          )) as { entry: { persistenceReview: { sourceRefs: string[] }; standingReview: { sourceRefs: string[] } } };
          const path = join(
            storeDir,
            "private-execution",
            `${encodeURIComponent((fault === "proof" ? payload.entry.persistenceReview : payload.entry.standingReview).sourceRefs[0]!)}.payload.json`,
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

it("pins supervisor interval and callable capabilities before Save", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  const original = c.options.phase.bind(c.options);
  c.options.phase = (name, work) =>
    original(name, async () => {
      await work();
      if (name === "save") {
        Object.assign(c.options, {
          offset: 3,
          length: 5,
          content: "replacement input",
          assertCurrent: () => {
            throw new Error("replacement callback");
          },
        });
      }
    });
  await runControlledOwnedReadTest(c.base, "connected", c.options);
  expect(c.observed.map(({ offset, length, bytes }) => ({ offset, length, bytes }))).toEqual([
    { offset: 2, length: 4, bytes: "spos" },
    { offset: 2, length: 4, bytes: "spos" },
  ]);
}, 30000);
