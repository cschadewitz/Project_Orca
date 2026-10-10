/** Trusted plugin entrypoint shares ordinary serve's closed-bootstrap refusal.
 * These cases refuse before config loading, protected writes or server startup. */
import { afterEach, expect, it, vi } from "vitest";
import type { CommandContext } from "../src/commands/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each(["incomplete", "ordinary-serve", "unauthenticated"])(
  "installed plugin composition cannot bypass %s closed-launch guard",
  async (mode) => {
    vi.resetModules();
    vi.stubEnv("ORCA_UPDATE_LAUNCH", "synthetic-closed-launch");
    vi.stubEnv("ORCA_UPDATE_ATTEMPT", mode === "incomplete" ? "" : "synthetic-attempt");
    const { serveWithInstalledPluginRelease } = await import("../src/commands/index.js");
    const ctx: CommandContext = {
      cwd: process.cwd(),
      flags: mode === "unauthenticated" ? { "unauthenticated-loopback": true } : {},
      positionals: [],
      out: vi.fn(),
      err: vi.fn(),
    };
    await expect(
      serveWithInstalledPluginRelease(ctx, {
        root: process.cwd(),
        manifestPath: "synthetic-unused-release.json",
        manifestSha256: "a".repeat(64),
      }),
    ).rejects.toThrow(
      mode === "unauthenticated"
        ? "Installed plugin serve requires authenticated trusted composition"
        : "Closed replacement bootstrap requires authenticated read-only validation",
    );
    expect(ctx.out).not.toHaveBeenCalled();
    expect(ctx.err).not.toHaveBeenCalled();
  },
);
