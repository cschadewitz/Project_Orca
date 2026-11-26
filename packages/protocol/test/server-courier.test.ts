/**
 * The client as courier for a host with no internet access (#1234): fetching exactly what the
 * host would have, checking every digest it can, caching, and pushing into a scratch directory.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLE_REPOSITORY,
  bundleFileNames,
  COSIGN_PINS,
  COSIGN_VERSION,
  CourierRefused,
  prepareCourier,
  pushCourier,
  SIGSTORE_TUF,
  TRUSTED_ROOT_FILE,
  type CourierFetch,
  type CourierTransport,
} from "../src/server-courier.js";
import { setupCommand } from "../src/server-setup.js";

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-courier-"));
  dirs.push(dir);
  return dir;
};

const VERSION = "0.9.0";
const [archive, manifest, signature] = bundleFileNames(VERSION);
const files: Record<string, Buffer> = {
  [archive]: Buffer.from("archive bytes"),
  [manifest]: Buffer.from('{"manifest":true}'),
  [signature]: Buffer.from('{"signature":true}'),
};
const trustedRoot = Buffer.from(
  JSON.stringify({ mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1" }),
);
const cosign = Buffer.from("cosign binary");

/** A fake internet: the release record, its assets, cosign and Sigstore's TUF, with counts. */
function internet(overrides: { record?: Record<string, unknown>; cosign?: Buffer; root?: Buffer } = {}) {
  const calls: string[] = [];
  const digests = [archive, manifest, signature].map((name) => sha(files[name]!));
  const record = {
    draft: false,
    prerelease: false,
    tag_name: `v${VERSION}`,
    body: `notes\n<!-- orca-server-run: 42 sha256:${digests[0]} sha256:${digests[1]} sha256:${digests[2]} -->`,
    assets: Object.entries(files).map(([name, data]) => ({
      name,
      digest: `sha256:${sha(data)}`,
      browser_download_url: `https://github.com/${BUNDLE_REPOSITORY}/releases/download/v${VERSION}/${name}`,
    })),
    ...overrides.record,
  };
  const root = overrides.root ?? trustedRoot;
  const routes = new Map<string, Buffer>([
    [
      `https://api.github.com/repos/${BUNDLE_REPOSITORY}/releases/tags/v${VERSION}`,
      Buffer.from(JSON.stringify(record)),
    ],
    ...Object.entries(files).map(
      ([name, data]) =>
        [`https://github.com/${BUNDLE_REPOSITORY}/releases/download/v${VERSION}/${name}`, data] as [string, Buffer],
    ),
    [
      `https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64`,
      overrides.cosign ?? cosign,
    ],
    [
      `${SIGSTORE_TUF}/timestamp.json`,
      Buffer.from(JSON.stringify({ signed: { meta: { "snapshot.json": { version: 7 } } } })),
    ],
    [
      `${SIGSTORE_TUF}/7.snapshot.json`,
      Buffer.from(JSON.stringify({ signed: { meta: { "targets.json": { version: 3 } } } })),
    ],
    [
      `${SIGSTORE_TUF}/3.targets.json`,
      Buffer.from(
        JSON.stringify({
          signed: {
            targets: { [TRUSTED_ROOT_FILE]: { length: trustedRoot.length, hashes: { sha256: sha(trustedRoot) } } },
          },
        }),
      ),
    ],
    [`${SIGSTORE_TUF}/targets/${sha(trustedRoot)}.${TRUSTED_ROOT_FILE}`, root],
  ]);
  const get: CourierFetch = (url, limit) => {
    calls.push(url);
    const data = routes.get(url);
    if (!data) return Promise.reject(new Error(`404 ${url}`));
    if (data.length > limit) return Promise.reject(new CourierRefused("too big"));
    return Promise.resolve(data);
  };
  return { get, calls };
}

describe("the courier's pins", () => {
  it("match the host's adapter exactly", () => {
    const adapter = readFileSync(new URL("../../../tools/deploy/orca-release.py", import.meta.url), "utf8");
    expect(adapter).toContain(`BUNDLE_REPOSITORY = "${BUNDLE_REPOSITORY}"`);
    expect(adapter).toContain(`COSIGN_VERSION = "${COSIGN_VERSION}"`);
    expect(adapter).toContain(`PUSHED_TRUSTED_ROOT = "${TRUSTED_ROOT_FILE}"`);
    for (const [machine, pin] of Object.entries(COSIGN_PINS))
      expect(adapter).toContain(`"${machine}": ("${pin.name}", "${pin.sha256}")`);
  });
});

describe("prepareCourier", () => {
  // The fake cosign cannot match the real pin, so the cosign step is checked on its own below.
  const withPin = async <T>(run: () => Promise<T>): Promise<T> => {
    const real = { ...COSIGN_PINS.x86_64! };
    (COSIGN_PINS as Record<string, { name: string; sha256: string }>).x86_64 = { name: real.name, sha256: sha(cosign) };
    try {
      return await run();
    } finally {
      (COSIGN_PINS as Record<string, { name: string; sha256: string }>).x86_64 = real;
    }
  };

  it("gathers the bundle, cosign and the trusted root, and reuses the cache", async () => {
    const cacheDir = tmp();
    const net = internet();
    const pkg = await withPin(() => prepareCourier({ version: VERSION, cacheDir, fetch: net.get }));
    expect(pkg.files.map((file) => file.name)).toEqual([
      archive,
      manifest,
      signature,
      "cosign-linux-amd64",
      TRUSTED_ROOT_FILE,
    ]);
    for (const file of pkg.files) expect(sha(readFileSync(file.path))).toBe(file.sha256);
    const first = net.calls.length;
    await withPin(() => prepareCourier({ version: VERSION, cacheDir, fetch: net.get }));
    // Only the record and Sigstore's metadata again: every file came from the cache.
    expect(net.calls.slice(first).filter((url) => url.includes("/releases/download/"))).toEqual([]);
  });

  it("refuses a cosign that is not the pinned one", async () => {
    const net = internet();
    await expect(prepareCourier({ version: VERSION, cacheDir: tmp(), fetch: net.get })).rejects.toThrow(
      /cosign-linux-amd64 is not the recorded file/,
    );
  });

  it("replaces a cached file that no longer matches", async () => {
    const cacheDir = tmp();
    const net = internet();
    const pkg = await withPin(() => prepareCourier({ version: VERSION, cacheDir, fetch: net.get }));
    writeFileSync(pkg.files[0]!.path, "tampered");
    const again = await withPin(() => prepareCourier({ version: VERSION, cacheDir, fetch: net.get }));
    expect(readFileSync(again.files[0]!.path)).toEqual(files[archive]);
  });

  it.each([
    ["a draft", { draft: true }, /not a published release/],
    ["a prerelease flag that disagrees", { prerelease: true }, /not a published release/],
    ["another tag", { tag_name: "v0.9.1" }, /not a published release/],
    ["no bundle record yet", { body: "notes" }, /no complete server bundle/],
    ["an asset that is not the recorded one", { assets: [] }, /missing or not the recorded one/],
  ])("refuses %s", async (_, record, message) => {
    await expect(
      withPin(() => prepareCourier({ version: VERSION, cacheDir: tmp(), fetch: internet({ record }).get })),
    ).rejects.toThrow(message);
  });

  it("refuses a trusted root that is not the one Sigstore's targets list", async () => {
    await expect(
      withPin(() =>
        prepareCourier({ version: VERSION, cacheDir: tmp(), fetch: internet({ root: Buffer.from("{}") }).get }),
      ),
    ).rejects.toThrow(/not the listed length|trusted_root.json is not the recorded file/);
  });

  it("refuses anything but a linux-x64 host and a release version", async () => {
    await expect(prepareCourier({ version: VERSION, machine: "aarch64", cacheDir: tmp() })).rejects.toThrow(
      /linux-x64/,
    );
    await expect(prepareCourier({ version: "latest", cacheDir: tmp() })).rejects.toThrow(/Not a release version/);
  });
});

describe("pushCourier", () => {
  function host(options: { corrupt?: string; mktemp?: string } = {}) {
    const commands: string[][] = [];
    const uploads: [string, string][] = [];
    const remote = new Map<string, Buffer>();
    const transport: CourierTransport = {
      exec: (command) => {
        commands.push([...command]);
        if (command[0] === "mktemp")
          return Promise.resolve({ code: 0, stdout: `${options.mktemp ?? "/tmp/tmp.Ab12Cd"}\n` });
        if (command[0] === "sha256sum")
          return Promise.resolve({
            code: 0,
            stdout: command
              .slice(2)
              .map((path) => `${sha(remote.get(path) ?? "")}  ${path}`)
              .join("\n"),
          });
        return Promise.resolve({ code: 0, stdout: "" });
      },
      upload: (path, remotePath) => {
        uploads.push([path, remotePath]);
        remote.set(remotePath, remotePath.endsWith(options.corrupt ?? "\0") ? Buffer.from("x") : readFileSync(path));
        return Promise.resolve();
      },
    };
    return { transport, commands, uploads };
  }
  const pkg = () => {
    const dir = tmp();
    return {
      version: VERSION,
      files: ["a.tar.xz", TRUSTED_ROOT_FILE].map((name) => {
        writeFileSync(join(dir, name), name);
        return { name, path: join(dir, name), sha256: sha(name), size: name.length };
      }),
    };
  };

  it("pushes every file into a fresh scratch directory and checks each arrived intact", async () => {
    const { transport, commands, uploads } = host();
    await expect(pushCourier(transport, pkg())).resolves.toBe("/tmp/tmp.Ab12Cd");
    expect(uploads.map(([, remote]) => remote)).toEqual([
      "/tmp/tmp.Ab12Cd/a.tar.xz",
      `/tmp/tmp.Ab12Cd/${TRUSTED_ROOT_FILE}`,
    ]);
    expect(commands[0]).toEqual(["mktemp", "-d"]);
    expect(commands[1]![0]).toBe("sha256sum");
  });

  it("refuses and cleans up when a file arrives changed", async () => {
    const { transport, commands } = host({ corrupt: "a.tar.xz" });
    await expect(pushCourier(transport, pkg())).rejects.toThrow(/a.tar.xz did not arrive intact/);
    expect(commands.at(-1)).toEqual(["rm", "-r", "-f", "--", "/tmp/tmp.Ab12Cd"]);
  });

  it("refuses a scratch directory it cannot use as one remote word", async () => {
    const { transport, uploads } = host({ mktemp: "/tmp/a b" });
    await expect(pushCourier(transport, pkg())).rejects.toThrow(/scratch directory/);
    expect(uploads).toEqual([]);
  });
});

describe("setupCommand with a pushed bundle", () => {
  const confirmed = { account: "casey", root: "/home/casey/.local/share/orca-server", current: null };
  it("passes the scratch directory as --bundle, and refuses anything else", () => {
    expect(setupCommand(VERSION, 6722, confirmed, "/tmp/tmp.Ab12Cd").slice(-2)).toEqual([
      "--bundle",
      "/tmp/tmp.Ab12Cd",
    ]);
    expect(setupCommand(VERSION, 6722, confirmed)).not.toContain("--bundle");
    expect(() => setupCommand(VERSION, 6722, confirmed, "/tmp/../etc")).toThrow(/bundle directory/);
    expect(() => setupCommand(VERSION, 6722, confirmed, "relative")).toThrow(/bundle directory/);
  });
});
