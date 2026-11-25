/**
 * Release notices for the Linux `.deb` (#888). The package has no updater, so this only
 * reads the public release list and says when a newer release has a `.deb` for this
 * machine. It never downloads or installs anything: the person follows the link and runs
 * the `apt` command themselves.
 *
 * The same ring rule as the Windows updater (`acceptsVersion`): a prerelease is offered
 * only with ORCA_UPDATE_PRERELEASE=1, and only a version above the installed one counts.
 * A failed or offline check is silent and never delays startup. ORCA_UPDATE_CHECK=0 turns
 * the check off. Electron-free so the tests drive it with a fake fetch and clock.
 */
import { existsSync } from "node:fs";
import type { LinuxUpdateNotice } from "../linux-update-contract.js";

const REPOSITORY = "cschadewitz/Project_Orca";
const PACKAGE_PREFIX = "ORCA";
/**
 * The Orrery rename bridge (v0.8.1): after the rename the releases are published by the renamed
 * repository, and their packages carry the new product name. For one release both are read: the
 * repositories in this order, the first that answers, and either package name.
 */
// rename-keep-start: both names, so an install on either side of the rename sees the next release
const REPOSITORIES = [...new Set([REPOSITORY, "cschadewitz/Project_Orca", "cschadewitz/Orrery"])];
const PACKAGE_PREFIXES = [...new Set([PACKAGE_PREFIX, "ORCA", "Orrery"])];
// rename-keep-end
const releasesApi = (repository: string) => `https://api.github.com/repos/${repository}/releases?per_page=30`;
export const RELEASES_URL = releasesApi(REPOSITORY);
export const RELEASES_URLS = REPOSITORIES.map(releasesApi);
export const releasePage = (tag: string, repository = REPOSITORY) =>
  `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
/** Where the package installs its binary (electron-builder.yml) and its dpkg file list. */
const DEB_EXECUTABLE = "/opt/ORCA/orca-desktop";
const DEB_FILE_LIST = "/var/lib/dpkg/info/orca-desktop.list";

/** Debian architecture names for the `.deb` artifacts, by `process.arch`. */
const DEB_ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };

/** Only an installed `orca-desktop` package: the tarball and AppImage have no `apt` path. */
export function isDebInstall(
  packaged: boolean,
  platform: string,
  execPath: string,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return packaged && platform === "linux" && execPath === DEB_EXECUTABLE && exists(DEB_FILE_LIST);
}

interface Version {
  core: [number, number, number];
  pre: string[];
}
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text);
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4]?.split(".") ?? [] };
}
/** Semver precedence, build metadata excluded (release tags carry none). */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! - b.core[i]!;
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function debAsset(version: string, arch: string): string | undefined {
  return debAssets(version, arch)[0];
}

/** Every name this machine's `.deb` may have (the rename bridge), the current one first. */
export function debAssets(version: string, arch: string): string[] {
  const debArch = DEB_ARCH[arch];
  return debArch ? PACKAGE_PREFIXES.map((prefix) => `${prefix}-${version}-linux-${debArch}.deb`) : [];
}

/**
 * The newest acceptable release above `current` with a `.deb` for `arch`, from the GitHub
 * release list. Drafts, unparseable tags and releases without this machine's package are
 * skipped, so the notice never points at something that cannot be installed.
 */
export function newerRelease(
  releases: unknown,
  current: string,
  arch: string,
  env: NodeJS.ProcessEnv = process.env,
  repository: string = REPOSITORY,
): LinuxUpdateNotice | undefined {
  const installed = parseVersion(current);
  if (!installed || !Array.isArray(releases)) return undefined;
  let best: { version: Version; text: string; tag: string; asset: string } | undefined;
  for (const release of releases as unknown[]) {
    if (!release || typeof release !== "object") continue;
    const { tag_name: tag, draft, prerelease, assets } = release as Record<string, unknown>;
    if (typeof tag !== "string" || draft !== false) continue;
    const version = parseVersion(tag);
    if (!version) continue;
    const text = tag.replace(/^v/, "");
    const pre = version.pre.length > 0 || prerelease === true;
    // The rule `acceptsVersion` applies to the Windows feed.
    if (pre && env.ORCA_UPDATE_PRERELEASE !== "1") continue;
    if (compareVersions(version, installed) <= 0) continue;
    if (!Array.isArray(assets)) continue;
    const names = new Set(
      assets.map((item: unknown) => (item && typeof item === "object" ? (item as { name?: unknown }).name : undefined)),
    );
    const asset = debAssets(text, arch).find((name) => names.has(name));
    if (!asset) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { version, text, tag, asset };
  }
  if (!best) return undefined;
  return {
    current,
    version: best.text,
    releaseUrl: releasePage(best.tag, repository),
    installCommand: `sudo apt install ./${best.asset}`,
  };
}

/** The release lists to ask, in order: the first that answers is the answer (the rename bridge). */
export function releasesUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.ORCA_RELEASES_URL) {
    const override = releasesUrl(env);
    return override ? [override] : [];
  }
  return RELEASES_URLS;
}

/** A test may point the check at a local server; a real override must still be HTTPS. */
export function releasesUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.ORCA_RELEASES_URL;
  if (!override) return RELEASES_URL;
  try {
    const url = new URL(override);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url.href;
  } catch {
    // An unusable override turns the check off rather than falling back to the network.
  }
  return undefined;
}

export interface ReleaseWatchOptions {
  current: string;
  arch: string;
  fetch: (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal; redirect: "error" },
  ) => Promise<{
    ok: boolean;
    json(): Promise<unknown>;
  }>;
  changed: (notice: LinuxUpdateNotice | undefined) => void;
  env?: NodeJS.ProcessEnv;
  /** First check after startup has settled, then periodically. */
  firstDelayMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
  setTimer?: (callback: () => void, ms: number) => { unref?(): void };
}

export const FIRST_CHECK_MS = 15_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class LinuxReleaseWatch {
  notice: LinuxUpdateNotice | undefined;
  private running = false;
  private stopped = false;
  constructor(private options: ReleaseWatchOptions) {}

  /** Schedules the checks and returns at once: nothing here is awaited at startup. */
  start(): void {
    const env = this.options.env ?? process.env;
    if (env.ORCA_UPDATE_CHECK === "0" || !releasesUrl(env)) return;
    this.schedule(this.options.firstDelayMs ?? FIRST_CHECK_MS);
  }

  stop(): void {
    this.stopped = true;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    const run = () => void this.check().finally(() => this.schedule(this.options.intervalMs ?? CHECK_INTERVAL_MS));
    // Unref'd: a pending check never keeps the app alive.
    if (this.options.setTimer) this.options.setTimer(run, ms).unref?.();
    else setTimeout(run, ms).unref();
  }

  /** One check. Every failure keeps the last answer and says nothing. */
  async check(): Promise<void> {
    const env = this.options.env ?? process.env;
    const urls = releasesUrls(env);
    if (this.running || this.stopped || !urls.length) return;
    this.running = true;
    try {
      let response: Awaited<ReturnType<ReleaseWatchOptions["fetch"]>> | undefined;
      let index = 0;
      // The first repository that answers (the rename bridge). Before the rename the new one
      // does not answer; after it the old one redirects, which fails like any other refusal.
      for (; index < urls.length && !response; index++) {
        try {
          const answer = await this.options.fetch(urls[index]!, {
            headers: { Accept: "application/vnd.github+json", "User-Agent": "ORCA-desktop" },
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
            // The HTTPS-or-loopback rule holds for the URL asked, so no hop may move it
            // elsewhere: a redirect fails the check, silently, like any other failure.
            redirect: "error",
          });
          if (answer.ok) response = answer;
        } catch {
          // Try the next repository; when none answers, the check is silent.
        }
      }
      if (!response) return;
      const body: unknown = await response.json();
      // Only a release list is an answer. Any other shape is a malformed check, which keeps
      // the last answer; an empty list is a real answer and clears it.
      if (!Array.isArray(body)) return;
      const repository = env.ORCA_RELEASES_URL ? REPOSITORY : REPOSITORIES[index - 1]!;
      const notice = newerRelease(body, this.options.current, this.options.arch, env, repository);
      if (this.stopped) return;
      if (JSON.stringify(notice) !== JSON.stringify(this.notice)) {
        this.notice = notice;
        this.options.changed(notice);
      }
    } catch {
      // Offline, refused, timed out or malformed: silent by design (#888).
    } finally {
      this.running = false;
    }
  }
}
