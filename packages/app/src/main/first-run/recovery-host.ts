/** Fixed OS observations for explicit same-machine reboot recovery; never logs host identifiers. */
import { execFileSync } from "node:child_process";
import { readFileSync, statfsSync } from "node:fs";
import { hash, rebootSchema, refuse, type RebootIdentity } from "./ownership.js";

const system = (file: string, args: string[]) =>
  execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    env: {},
  }).trim();
export function readRecoveryHost(): RebootIdentity {
  try {
    if (process.platform === "linux") {
      const machine = readFileSync("/etc/machine-id", "utf8").trim();
      if (!/^[a-f0-9]{32}$/.test(machine) || /^0+$/.test(machine)) return refuse();
      return rebootSchema.parse({
        platform: "linux",
        hostHash: hash(machine),
        bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      });
    }
    if (process.platform === "darwin") {
      const platform = system("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
      const host = /"IOPlatformUUID"\s*=\s*"([0-9a-f-]{36})"/i.exec(platform)?.[1];
      if (!host || !rebootSchema.shape.bootId.safeParse(host.toLowerCase()).success) return refuse();
      return rebootSchema.parse({
        platform: "darwin",
        hostHash: hash(host.toLowerCase()),
        bootId: system("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]).toLowerCase(),
      });
    }
  } catch {
    return refuse();
  }
  return refuse();
}
/** Network/removable/unknown filesystems cannot establish local old-writer quiescence. */
export function assertRecoveryLocalVolume(path: string): void {
  try {
    if (process.platform === "linux") {
      // Durable local ext-family, XFS and Btrfs only. No NFS, FUSE, overlay or tmpfs recovery claim.
      if (![0xef53, 0x58465342, 0x9123683e].includes(statfsSync(path).type)) return refuse();
      return;
    }
    if (process.platform === "darwin") {
      const info = system("/usr/sbin/diskutil", ["info", "-plist", path]);
      if (
        !/<key>Internal<\/key>\s*<true\s*\/>/.test(info) ||
        !/<key>FilesystemType<\/key>\s*<string>apfs<\/string>/.test(info)
      )
        return refuse();
      return;
    }
  } catch {
    return refuse();
  }
  return refuse();
}
