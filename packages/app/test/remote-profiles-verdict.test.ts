/**
 * What counts as a daemon accepting a credential (#875 review 4), against real daemons: only
 * credential-authenticated discovery does. A daemon that does not authenticate its callers
 * answers `hello` while ignoring the token, and must never confirm one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openAuthDirectory, startDaemon, type DaemonHandle } from "@orca/daemon";
import { helloVerdict } from "../src/main/remote-profiles.js";

const resolver = {
  run: async () => undefined,
  inputRun: async () => undefined,
  artifactRun: async () => undefined,
  claimRun: async () => undefined,
  workflowExists: () => false,
};

describe("a credential is accepted only on credential-authenticated proof", () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  const setup = async (mode: "token" | "loopback") => {
    const dir = mkdtempSync(join(tmpdir(), "orca-verdict-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const auth = openAuthDirectory(join(dir, "auth"));
    const workspaceId = randomUUID();
    const daemon: DaemonHandle = await startDaemon({
      orcaVersion: "verdict",
      workspaceId,
      capabilities: ["runs.read", "runs.subscribe"],
      source: { subscribe: () => () => {}, eventsRange: async () => [] },
      // What `orca serve` mounts: the operator reads, discovery among them.
      operatorSources: { events: {} as never },
      auth:
        mode === "token"
          ? { mode: "token", credentials: auth.credentials, ownership: auth.ownership, resolver }
          : { mode: "loopback-unauthenticated" },
    });
    cleanup.push(() => daemon.close());
    const ask = (token: string, principal?: string) =>
      helloVerdict(() => connect(daemon.port, "127.0.0.1"), daemon.url, token, principal);
    return { auth, workspaceId, ask };
  };

  it("accepts a credential the daemon authenticated, for its principal and workspace", async () => {
    const { auth, workspaceId, ask } = await setup("token");
    const { token, credential } = await auth.credentials.issue({ principal: "desktop-lab", preset: "client" });
    await expect(ask(token, "desktop-lab")).resolves.toEqual({ verdict: "accepted", workspaceId });
    // Issued to another principal than the one expected: not this installation's credential.
    await expect(ask(token, "desktop-other")).resolves.toEqual({ verdict: "unproven" });
    await auth.credentials.revoke(credential.id);
    await expect(ask(token, "desktop-lab")).resolves.toEqual({ verdict: "refused" });
    await expect(ask("orca1.unknown0000.secretsecretsecret", "desktop-lab")).resolves.toEqual({
      verdict: "refused",
    });
  });

  it("never accepts a credential on a daemon that does not authenticate callers (open loopback)", async () => {
    const { ask } = await setup("loopback");
    // It answers hello, and names its workspace, whatever the token: proof of nothing.
    const verdict = await ask("orca1.anything000.secretsecretsecret", "desktop-lab");
    expect(verdict).toEqual({ verdict: "unproven" });
  });

  it("cannot be asked without a daemon", async () => {
    const verdict = await helloVerdict(
      () => connect(1, "127.0.0.1"),
      "http://127.0.0.1:1",
      "orca1.anything000.secretsecretsecret",
    );
    expect(verdict).toEqual({ verdict: "unknown" });
  });
});
