/** Limit an explicitly requested manual build; release calls always build every platform. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLinuxRunner, TYLER } from "./linux-runner.js";

export function desktopMatrix(eventName, platform = "all", linuxRunner = TYLER) {
  if (!["all", "windows", "windows-linux"].includes(platform))
    throw new Error("Unsupported desktop platform selection");
  if (!isLinuxRunner(linuxRunner)) throw new Error("Unsupported desktop Linux runner");
  if (platform !== "all" && eventName !== "workflow_dispatch")
    throw new Error("Reduced desktop matrix requires a manual dispatch");
  const include = [
    {
      os: linuxRunner,
      name: "linux",
      cache_path: "~/.cache/electron\n~/.cache/electron-builder\n",
    },
    {
      os: "macos-latest",
      name: "macos",
      cache_path: "~/Library/Caches/electron\n~/Library/Caches/electron-builder\n",
    },
    {
      os: "windows-latest",
      name: "windows",
      cache_path: "~\\AppData\\Local\\electron\\Cache\n~\\AppData\\Local\\electron-builder\\Cache\n",
    },
  ];
  if (platform === "all") return { include };
  const selectedNames = platform === "windows-linux" ? ["windows", "linux"] : [platform];
  return { include: include.filter((target) => selectedNames.includes(target.name)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const linuxRunner = process.env.DESKTOP_LINUX_RUNNER ? JSON.parse(process.env.DESKTOP_LINUX_RUNNER) : TYLER;
  console.log(
    JSON.stringify(desktopMatrix(process.env.DESKTOP_EVENT_NAME, process.env.DESKTOP_PLATFORM || "all", linuxRunner)),
  );
}
