/** Limit an explicitly requested manual build; release calls always build every platform. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function desktopMatrix(eventName, platform = "all") {
  if (!["all", "windows"].includes(platform)) throw new Error("Unsupported desktop platform selection");
  if (platform !== "all" && eventName !== "workflow_dispatch")
    throw new Error("Reduced desktop matrix requires a manual dispatch");
  const include = [
    {
      os: ["self-hosted", "linux", "x64", "homelab"],
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
  return { include: platform === "all" ? include : include.filter((target) => target.name === platform) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(desktopMatrix(process.env.DESKTOP_EVENT_NAME, process.env.DESKTOP_PLATFORM || "all")));
}
