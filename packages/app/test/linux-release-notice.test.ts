import { expect, it, vi } from "vitest";
import {
  compareVersions,
  isDebInstall,
  LinuxReleaseWatch,
  newerRelease,
  parseVersion,
  releasesUrl,
  RELEASES_URL,
  type ReleaseWatchOptions,
} from "../src/main/linux-release-notice.js";

const release = (tag: string, extra: Record<string, unknown> = {}) => {
  const version = tag.replace(/^v/, "");
  return {
    tag_name: tag,
    draft: false,
    prerelease: version.includes("-"),
    assets: [{ name: `ORCA-${version}-linux-amd64.deb` }, { name: `ORCA-${version}-win-x64.exe` }],
    ...extra,
  };
};

it("orders versions by semver precedence", () => {
  const order = ["0.6.9", "0.7.0-rc.1", "0.7.0-rc.2", "0.7.0-rc.10", "0.7.0", "0.7.1", "0.10.0"];
  for (let i = 1; i < order.length; i++) {
    expect(compareVersions(parseVersion(order[i - 1]!)!, parseVersion(order[i]!)!)).toBeLessThan(0);
    expect(compareVersions(parseVersion(order[i]!)!, parseVersion(order[i - 1]!)!)).toBeGreaterThan(0);
  }
  expect(compareVersions(parseVersion("v0.7.0")!, parseVersion("0.7.0")!)).toBe(0);
  expect(parseVersion("latest")).toBeUndefined();
  expect(parseVersion("0.7")).toBeUndefined();
});

it("offers the newest stable release with this machine's package, and nothing when current", () => {
  const list = [release("v0.7.2-rc.1"), release("v0.7.1"), release("v0.7.0"), release("v0.6.0")];
  expect(newerRelease(list, "0.7.0", "x64", {})).toEqual({
    current: "0.7.0",
    version: "0.7.1",
    releaseUrl: "https://github.com/cschadewitz/Project_Orca/releases/tag/v0.7.1",
    installCommand: "sudo apt install ./ORCA-0.7.1-linux-amd64.deb",
  });
  expect(newerRelease(list, "0.7.1", "x64", {})).toBeUndefined();
  expect(newerRelease(list, "0.8.0", "x64", {})).toBeUndefined();
  // An rc install is older than its final.
  expect(newerRelease(list, "0.7.1-rc.2", "x64", {})?.version).toBe("0.7.1");
});

it("offers a prerelease only to installs that opted in, as the Windows feed does", () => {
  const list = [release("v0.7.2-rc.1"), release("v0.7.1")];
  expect(newerRelease(list, "0.7.1", "x64", {})).toBeUndefined();
  expect(newerRelease(list, "0.7.1", "x64", { ORCA_UPDATE_PRERELEASE: "1" })?.version).toBe("0.7.2-rc.1");
  // A release GitHub marks as prerelease counts as one even with a plain tag.
  expect(newerRelease([release("v0.7.2", { prerelease: true })], "0.7.1", "x64", {})).toBeUndefined();
});

it("skips drafts, unparseable tags and releases without a .deb for this architecture", () => {
  expect(newerRelease([release("v0.7.1", { draft: true })], "0.7.0", "x64", {})).toBeUndefined();
  expect(newerRelease([release("v0.7.1", { draft: undefined })], "0.7.0", "x64", {})).toBeUndefined();
  expect(newerRelease([release("nightly")], "0.7.0", "x64", {})).toBeUndefined();
  expect(newerRelease([release("v0.7.1", { assets: [] })], "0.7.0", "x64", {})).toBeUndefined();
  expect(newerRelease([release("v0.7.1")], "0.7.0", "arm64", {})).toBeUndefined();
  expect(newerRelease([release("v0.7.1")], "0.7.0", "ia32", {})).toBeUndefined();
  const arm = release("v0.7.1", { assets: [{ name: "ORCA-0.7.1-linux-arm64.deb" }] });
  expect(newerRelease([arm], "0.7.0", "arm64", {})?.installCommand).toBe(
    "sudo apt install ./ORCA-0.7.1-linux-arm64.deb",
  );
  for (const junk of [null, "x", { message: "rate limited" }, [null, 3, "x"]])
    expect(newerRelease(junk, "0.7.0", "x64", {})).toBeUndefined();
  expect(newerRelease([release("v0.7.1")], "not-a-version", "x64", {})).toBeUndefined();
});

it("recognises only the installed package", () => {
  const dpkg = (path: string) => path === "/var/lib/dpkg/info/orca-desktop.list";
  expect(isDebInstall(true, "linux", "/opt/ORCA/orca-desktop", dpkg)).toBe(true);
  expect(isDebInstall(false, "linux", "/opt/ORCA/orca-desktop", dpkg)).toBe(false);
  expect(isDebInstall(true, "win32", "/opt/ORCA/orca-desktop", dpkg)).toBe(false);
  expect(isDebInstall(true, "linux", "/home/me/ORCA/orca-desktop", dpkg)).toBe(false);
  expect(isDebInstall(true, "linux", "/opt/ORCA/orca-desktop", () => false)).toBe(false);
});

it("accepts only an HTTPS or loopback release URL override", () => {
  expect(releasesUrl({})).toBe(RELEASES_URL);
  expect(releasesUrl({ ORCA_RELEASES_URL: "http://127.0.0.1:8123/releases" })).toBe("http://127.0.0.1:8123/releases");
  expect(releasesUrl({ ORCA_RELEASES_URL: "https://mirror.example/releases" })).toBe("https://mirror.example/releases");
  expect(releasesUrl({ ORCA_RELEASES_URL: "http://mirror.example/releases" })).toBeUndefined();
  expect(releasesUrl({ ORCA_RELEASES_URL: "not a url" })).toBeUndefined();
});

type Fetch = ReleaseWatchOptions["fetch"];
const fakeFetch = (impl: Fetch = () => ok([])) => vi.fn<Fetch>(impl);
function watch(fetch: ReturnType<typeof fakeFetch>, env: NodeJS.ProcessEnv = {}) {
  const changed = vi.fn();
  const timers: { callback: () => void; ms: number }[] = [];
  const w = new LinuxReleaseWatch({
    current: "0.7.0",
    arch: "x64",
    fetch,
    changed,
    env,
    setTimer: (callback, ms) => {
      timers.push({ callback, ms });
      return {};
    },
  });
  return { w, changed, timers };
}
function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}

it("checks after startup and periodically, never blocking start, and reports only changes", async () => {
  const fetch = fakeFetch(() => ok([release("v0.7.1")]));
  const { w, changed, timers } = watch(fetch);
  w.start();
  expect(fetch).not.toHaveBeenCalled();
  expect(timers).toHaveLength(1);
  expect(timers[0]!.ms).toBe(15_000);
  timers[0]!.callback();
  await vi.waitFor(() => expect(timers).toHaveLength(2));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe(RELEASES_URL);
  expect(timers[1]!.ms).toBe(6 * 60 * 60 * 1000);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(w.notice?.version).toBe("0.7.1");
  // Same answer: no new push.
  await w.check();
  expect(changed).toHaveBeenCalledTimes(1);
  // Once current, the notice goes away.
  fetch.mockImplementation(() => ok([release("v0.7.0")]));
  await w.check();
  expect(changed).toHaveBeenLastCalledWith(undefined);
  expect(w.notice).toBeUndefined();
});

it("stays silent and keeps its last answer when offline or refused", async () => {
  const fetch = fakeFetch(() => ok([release("v0.7.1")]));
  const { w, changed } = watch(fetch);
  await w.check();
  expect(changed).toHaveBeenCalledTimes(1);
  fetch.mockImplementation(() => Promise.reject(new TypeError("fetch failed")));
  await expect(w.check()).resolves.toBeUndefined();
  fetch.mockImplementation(() => Promise.resolve({ ok: false, json: () => Promise.reject(new Error("no")) }));
  await w.check();
  fetch.mockImplementation(() => Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError("bad")) }));
  await w.check();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(w.notice?.version).toBe("0.7.1");
});

it("does not check at all when turned off or pointed at an unusable URL", () => {
  for (const env of [{ ORCA_UPDATE_CHECK: "0" }, { ORCA_RELEASES_URL: "http://mirror.example/" }]) {
    const fetch = fakeFetch();
    const { w, timers } = watch(fetch, env);
    w.start();
    expect(timers).toHaveLength(0);
  }
});

it("stops scheduling after stop", async () => {
  const fetch = fakeFetch();
  const { w, timers } = watch(fetch);
  w.start();
  w.stop();
  timers[0]!.callback();
  await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled();
  expect(timers).toHaveLength(1);
});
