/**
 * `remotes.list` / `remotes.enroll` (#1206) without a remote: what they answer and what they
 * refuse before anything is written or sent. The enrollment itself, over a real ssh to a real
 * worker daemon from a first-run app workspace, is `packages/cli/test/remote-enroll-app-workspace-1206.test.ts`.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteDaemonSpecSchema, type OrcaConfig } from "@orca/core";
import { RemotesEnrollParamsSchema } from "@orca/protocol";
import { remotesModel, type RemotesSource } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function source(overrides: Partial<RemotesSource> = {}): RemotesSource & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "orca-remotes-model-"));
  dirs.push(dir);
  const config = {
    remotes: [
      RemoteDaemonSpecSchema.parse({ id: "build-box", destination: "ci@build.example" }),
      RemoteDaemonSpecSchema.parse({
        id: "far-box",
        name: "Far box",
        destination: "ci@far.example",
        jump: { destination: "gate@bastion.example" },
      }),
    ],
    agents: [
      { id: "b", type: "orca-daemon", profile: "build-box", workflow: "build" },
      { id: "c", type: "orca-daemon", profile: "build-box", workflow: "build" },
      { id: "d", type: "orca-daemon", profile: "build-box", workflow: "assemble" },
    ],
  } as unknown as Pick<OrcaConfig, "remotes" | "agents">;
  return {
    dir,
    configDir: dir,
    config: () => config,
    receiptsDir: join(dir, ".orca", "delegations"),
    principal: async () => "delegate-test",
    admitted: () => true,
    // Any connection attempt is a failure of these tests: nothing here should get that far.
    tunnel: () => {
      throw new Error("no tunnel may be opened");
    },
    ...overrides,
  };
}

describe("remotes model (#1206)", () => {
  it("lists the active configuration's remotes with their delegated workflows, none enrolled", () => {
    const s = source();
    const listed = remotesModel(s).list();
    expect(listed.remotes).toEqual([
      {
        id: "build-box",
        name: "build-box",
        destination: "ci@build.example",
        workflows: ["assemble", "build"],
        pinned: [],
        jumpPinned: [],
        credentialSaved: false,
        enrollment: { state: "none" },
      },
      {
        id: "far-box",
        name: "Far box",
        destination: "ci@far.example",
        jump: "gate@bastion.example",
        workflows: [],
        pinned: [],
        jumpPinned: [],
        credentialSaved: false,
        enrollment: { state: "none" },
      },
    ]);
    expect(listed.canIssue).toBe(process.platform !== "win32");
  });

  it("refuses to enroll while the daemon does not hold the workspace's writer fence, and writes nothing", async () => {
    const s = source({ admitted: () => false });
    await expect(
      remotesModel(s).enroll({ id: "build-box", hostKeys: [`SHA256:${"A".repeat(43)}`] }),
    ).rejects.toMatchObject({ code: "DELEGATION_REFUSED", message: expect.stringContaining("writer fence") });
    await expect(
      remotesModel(s).enroll({ id: "build-box", credential: "orca1.abcdefghijkl." + "a".repeat(43) }),
    ).rejects.toMatchObject({ code: "DELEGATION_REFUSED" });
    expect(readdirSync(s.dir)).toEqual([]);
  });

  it("refuses a remote the active configuration does not name", async () => {
    await expect(remotesModel(source()).enroll({ id: "elsewhere" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("elsewhere"),
    });
  });

  it("refuses a pasted text that holds no ORCA credential, and saves nothing", async () => {
    const s = source();
    await expect(
      remotesModel(s).enroll({ id: "build-box", credential: "password123", hostKeys: [] }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(existsSync(join(s.dir, "auth"))).toBe(false);
  });

  it("refuses without a host key while nothing is pinned, before opening a tunnel", async () => {
    const s = source();
    const credential = `orca1.abcdefghijkl.${"a".repeat(43)}`;
    await expect(remotesModel(s).enroll({ id: "build-box", hostKeys: [], credential })).rejects.toMatchObject({
      code: "DELEGATION_REFUSED",
      message: expect.stringContaining("no pinned host key"),
    });
    expect(existsSync(join(s.dir, "auth", "remotes", "build-box.json"))).toBe(false);
  });

  it("does not combine a pasted credential with issuing a new one", () => {
    expect(RemotesEnrollParamsSchema.safeParse({ id: "build-box", credential: "x", rotate: true }).success).toBe(false);
    expect(RemotesEnrollParamsSchema.parse({ id: "build-box" })).toEqual({
      id: "build-box",
      hostKeys: [],
      jumpHostKeys: [],
    });
  });
});
