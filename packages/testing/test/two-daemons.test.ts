/**
 * The two-daemon fixture's smoke test (#885 phase 1): two real `orca serve` processes, each
 * with its own store, port and token, answer an authenticated `hello` and nothing else; one
 * of them is the N-1 daemon an N app falls back to (#880); and, where sshd is installed, one
 * daemon is reached through an SSH port forward the way a remote machine's would be.
 *
 * Needs `pnpm run build` (it runs the compiled CLI); CI builds before it tests.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIENT_PROTOCOL, HELLO_METHOD, HelloResultSchema, PROTOCOL_VERSION } from "@orca/protocol";
import { loopbackSshd, rpc, startTwoDaemons, type LoopbackSshd, type TwoDaemons } from "@orca/testing/two-daemons";
import { repoRoot } from "@orca/testing/child-bundle";

let pair: TwoDaemons;
beforeAll(async () => {
  pair = await startTwoDaemons();
}, 60_000);
afterAll(async () => {
  await pair?.close();
});

const hello = (client: string) => ({ client, protocol: CLIENT_PROTOCOL });
const result = (answer: Awaited<ReturnType<typeof rpc>>) => {
  if (!answer.ok) throw new Error(`${answer.error.code}: ${answer.error.message}`);
  return HelloResultSchema.parse(answer.result);
};

describe("two daemons", () => {
  it("each answers an authenticated hello from its own store", async () => {
    const a = result(await pair.a.call(HELLO_METHOD, hello("two-daemons/a")));
    const b = result(await pair.b.call(HELLO_METHOD, hello("two-daemons/b")));
    expect(a.protocol).toEqual(PROTOCOL_VERSION);
    expect(b.protocol).toEqual(PROTOCOL_VERSION);
    expect(a.storeDir).toBe(join(pair.a.dir, ".orca"));
    expect(b.storeDir).toBe(join(pair.b.dir, ".orca"));
    expect(pair.a.port).not.toBe(pair.b.port);
    // Two installations, not one seen twice.
    expect(a.identity?.workspaceId).toBeDefined();
    expect(a.identity?.workspaceId).not.toBe(b.identity?.workspaceId);
  });

  it("refuses a caller without a token, and each daemon's token on the other", async () => {
    expect(pair.a.token).not.toBe(pair.b.token);
    for (const [daemon, other] of [
      [pair.a, pair.b],
      [pair.b, pair.a],
    ] as const) {
      expect(await daemon.call(HELLO_METHOD, hello("anonymous"), null)).toMatchObject({ ok: false });
      expect(await daemon.call(HELLO_METHOD, hello("wrong-daemon"), other.token)).toMatchObject({
        ok: false,
        error: { code: expect.stringMatching(/^AUTH_/) },
      });
    }
  });

  it("is the N-1 daemon an N app falls back to", async () => {
    const next = { major: PROTOCOL_VERSION.major + 1, minor: 0 };
    const fallback = result(
      await pair.b.call(HELLO_METHOD, { client: "orca-app/n", protocol: next, fallback: CLIENT_PROTOCOL }),
    );
    expect(fallback.protocol).toEqual(PROTOCOL_VERSION);
    // Without the fallback, the next major is refused with the protocol message.
    expect(await pair.b.call(HELLO_METHOD, { client: "orca-app/n", protocol: next })).toMatchObject({
      ok: false,
      error: { code: "NOT_SUPPORTED" },
    });
  });

  it("still answers the hello a shipped v0.7.0 app sends", async () => {
    const recorded = JSON.parse(
      await readFile(join(repoRoot, "packages/app/test/fixtures/protocol-2.0-hello.json"), "utf8"),
    ) as { request: { params: unknown } };
    expect(result(await pair.a.call(HELLO_METHOD, recorded.request.params)).protocol).toEqual(PROTOCOL_VERSION);
  });

  it("stops one daemon without the other noticing", async () => {
    const { startTestDaemon } = await import("@orca/testing/two-daemons");
    const third = await startTestDaemon({ name: "c" });
    await third.close();
    await expect(third.call(HELLO_METHOD, hello("gone"))).rejects.toThrow();
    expect(result(await pair.a.call(HELLO_METHOD, hello("still-here"))).protocol).toEqual(PROTOCOL_VERSION);
  });
});

describe("a daemon behind a loopback sshd", () => {
  let sshd: LoopbackSshd | undefined;
  beforeAll(async () => {
    sshd = await loopbackSshd();
  }, 30_000);
  afterAll(async () => {
    await sshd?.close();
  });

  it("answers hello through an SSH port forward with its own token", async (context) => {
    if (!sshd) return context.skip("no /usr/sbin/sshd; set ORCA_REQUIRE_SSHD=1 to require it");
    const local = await sshd.forward(pair.b.port);
    const through = `http://127.0.0.1:${local}`;
    const answer = result(await rpc(through, HELLO_METHOD, hello("over-ssh"), pair.b.token));
    expect(answer.storeDir).toBe(join(pair.b.dir, ".orca"));
    // The tunnel carries bytes, not trust: a's token is still refused by b.
    expect(await rpc(through, HELLO_METHOD, hello("over-ssh"), pair.a.token)).toMatchObject({ ok: false });
  });
});
