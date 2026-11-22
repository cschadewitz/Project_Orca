/** What `orca serve` reports about the managed server updater that launched it (#879). */
import { describe, expect, it } from "vitest";
import { managedDeployment } from "../src/managed-deployment.js";

const env = (extra: Record<string, string> = {}) => ({
  ORCA_DEPLOYMENT_ADAPTER: "/opt/orca/orca-release.py",
  ORCA_DEPLOYMENT_MANIFEST: "/etc/orca/deployment.json",
  ...extra,
});

describe("managedDeployment", () => {
  it("reports the launching updater, with its ring when it names one", () => {
    expect(managedDeployment(env())).toEqual({
      kind: "managed",
      adapter: "/opt/orca/orca-release.py",
      manifest: "/etc/orca/deployment.json",
    });
    expect(managedDeployment(env({ ORCA_DEPLOYMENT_RING: "stable" }))).toMatchObject({ ring: "stable" });
  });

  it("reports nothing for a daemon launched any other way, or with paths it would not run", () => {
    expect(managedDeployment({})).toBeUndefined();
    expect(managedDeployment({ ORCA_DEPLOYMENT_ADAPTER: "/opt/orca/orca-release.py" })).toBeUndefined();
    for (const bad of [
      { ORCA_DEPLOYMENT_ADAPTER: "orca-release.py" },
      { ORCA_DEPLOYMENT_ADAPTER: "/opt/orca/../tmp/x.py" },
      { ORCA_DEPLOYMENT_MANIFEST: "/etc/orca/deploy ment.json" },
      { ORCA_DEPLOYMENT_MANIFEST: "/etc/orca/$(reboot)" },
      { ORCA_DEPLOYMENT_RING: "nightly" },
    ])
      expect(managedDeployment(env(bad))).toBeUndefined();
  });
});
