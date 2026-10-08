/** Cross-platform checks of rendered deployment boundaries, without host access or secrets. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT01, renderAgent01 } from "../deploy/private-mcp-service/render-agent01.js";

const directive = (text, name) => text.split("\n").filter((line) => line.startsWith(`${name}=`));

describe("agent-01 supervision proposal", () => {
  it("pins the current daemon separately from the untouched retained MCP launcher", () => {
    const daemon = renderAgent01("orca-daemon.service");
    const tunnel = renderAgent01("tunnel-profile.yaml");
    expect(directive(daemon, "ExecStart")).toEqual([
      `ExecStart=/usr/bin/env -i HOME=/home/casey PATH=${AGENT01.REVIEWED_PATH} LANG=C TMPDIR=/srv/dev/orca-temp-cal ${AGENT01.NODE} /home/casey/.local/share/orca-runtime/49efcc7236ac127c952bb1f7a50fc6ef72f7df84/packages/cli/dist/main.js --config /home/casey/.orca-codex-work/orca.yaml serve --host 127.0.0.1 --port 33871`,
    ]);
    expect(tunnel).toContain(`command: ${AGENT01.NODE} /home/casey/.orca-codex-work/mcp-client.cjs`);
    expect(tunnel).not.toMatch(/launch-mcp\.js|--credential-store|--token-file|49efcc7/);
    // The opt-in does not edit or relax the guarded PR446 profile.
    const guarded = readFileSync("tools/deploy/private-mcp-service/service-profile.json.template", "utf8");
    expect(JSON.parse(guarded).runtime.commit).toBe("3702da5b38dc449280c2837366615de741e9c45c");
    expect(JSON.parse(guarded).target.instanceId).toBe("@INSTANCE_UUID@");
    expect(JSON.parse(guarded).credentialId).toBe("@CREDENTIAL_ID@");
  });

  it("bounds restart and shutdown, preserves hardening, and has no stop propagation edge", () => {
    for (const name of ["orca-daemon.service", "orca-tunnel.service"]) {
      const unit = renderAgent01(name);
      for (const line of [
        "StartLimitIntervalSec=5min",
        "StartLimitBurst=6",
        "Restart=on-failure",
        "RestartSec=5s",
        "TimeoutStopSec=30s",
        "KillSignal=SIGTERM",
        "KillMode=control-group",
        "SendSIGKILL=yes",
        "UMask=0077",
        "NoNewPrivileges=yes",
        "PrivateTmp=yes",
        "WantedBy=default.target",
        "WorkingDirectory=/home/casey/.orca-codex-work",
      ])
        expect(unit.split("\n")).toContain(line);
      expect(unit).not.toMatch(
        /^(Requires|BindsTo|PartOf|PropagatesStopTo|StopPropagatedFrom|ExecStop|User|EnvironmentFile)=/m,
      );
      expect(directive(unit, "ExecStart")).toHaveLength(1);
      expect(directive(unit, "ExecStart")[0]).toContain(
        `-i HOME=/home/casey PATH=${AGENT01.REVIEWED_PATH} LANG=C TMPDIR=/srv/dev/orca-temp-cal `,
      );
    }
    expect(renderAgent01("orca-tunnel.service")).toContain("Wants=orca-daemon.service\n");
    expect(renderAgent01("orca-tunnel.service")).toContain("After=orca-daemon.service network-online.target\n");
    expect(renderAgent01("orca-daemon.service")).not.toContain("orca-tunnel");
  });

  it("renders one loopback transport with a file reference and no unresolved placeholders", () => {
    const yaml = renderAgent01("tunnel-profile.yaml");
    expect(yaml).toContain("api_key: file:/home/casey/.orca-codex-work/supervision/tunnel-runtime.key");
    expect(yaml).toContain("tunnel_id: tunnel_6ac0b657e5d88191a442de4978b38ea9");
    expect(yaml).toContain("listen_addr: 127.0.0.1:33872");
    expect(yaml.match(/- channel: main/g)).toHaveLength(1);
    expect(yaml).not.toMatch(/server_urls:|harpoon:|env:|orca1[.]/);
    for (const name of ["orca-daemon.service", "orca-tunnel.service", "tunnel-profile.yaml"]) {
      expect(renderAgent01(name)).not.toMatch(/@[A-Z_]+@|\r/);
    }
    expect(() => renderAgent01("../../cal-codex-work.json")).toThrow("Unknown agent-01 artifact");
    expect(() => renderAgent01("toString")).toThrow("Unknown agent-01 artifact");
  });

  it("CLI renders exactly one artifact and ignores ambient configuration overrides", () => {
    const cli = "tools/deploy/private-mcp-service/render-agent01.js";
    const result = spawnSync(process.execPath, [cli, "orca-daemon.service"], {
      encoding: "utf8",
      env: { ...process.env, ORCA_CONFIG: "wrong-config", TMPDIR: "wrong-temp", MCP_COMMAND: "wrong-command" },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(renderAgent01("orca-daemon.service"));
    const invalid = spawnSync(process.execPath, [cli, "orca-daemon.service", "extra"], { encoding: "utf8" });
    expect(invalid.status).toBe(64);
    expect(invalid.stdout).toBe("");
  });
});
