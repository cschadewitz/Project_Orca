/**
 * #1207: a configured remote's CLI keeps the meaning it had before desktop installs shipped
 * `orca-cli`. A workspace config's `remotes[]` entry that omits `serverCommand` was written
 * against a server whose CLI answers to `orca`, and enrollment, its credential listing and
 * revocation all go on reaching that, never a guessed other name.
 */
import { describe, expect, it } from "vitest";
import { RemoteDaemonSpecSchema } from "@orca/core";
import { LEGACY_SERVER_COMMAND } from "@orca/protocol/remote-access";
import { remoteCliCommand } from "../src/delegation/enrollment.js";

const remote = (fields: Record<string, unknown> = {}) =>
  RemoteDaemonSpecSchema.parse({ id: "build-box", destination: "ci@build-box", ...fields });

describe("a configured remote's server command", () => {
  it("is orca when the config omits it, as an older remote's config does", () => {
    expect(LEGACY_SERVER_COMMAND).toBe("orca"); // rename-keep: an omitted command keeps naming the old CLI
    expect(remoteCliCommand(remote(), "auth", "list", "--json")).toEqual(["orca", "auth", "list", "--json"]); // rename-keep: an omitted command keeps naming the old CLI
    expect(remoteCliCommand(remote(), "auth", "revoke", "--json")).toEqual(["orca", "auth", "revoke", "--json"]); // rename-keep: an omitted command keeps naming the old CLI
  });

  it("is exactly what the config names, orca-cli or a full path, with its workspace config", () => {
    expect(remoteCliCommand(remote({ serverCommand: "orca-cli" }), "auth", "issue", "p")).toEqual([
      "orca-cli",
      "auth",
      "issue",
      "p",
    ]);
    expect(
      remoteCliCommand(
        remote({ serverCommand: "/srv/orca/orca", serverConfig: "/srv/orca/orca.config.yaml" }),
        "auth",
        "list",
      ),
    ).toEqual(["/srv/orca/orca", "auth", "list", "--config", "/srv/orca/orca.config.yaml"]);
  });
});
