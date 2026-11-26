/**
 * Carry a signed server bundle to a host that cannot fetch it (#1234), Node-only like
 * `server-setup`: a tailnet host with no internet access, or one blocked from GitHub or Sigstore.
 *
 * The client is a courier, not a verifier the host trusts: it fetches exactly what the host would
 * have fetched (the release's three bundle files, the pinned cosign for the host, and Sigstore's
 * trusted root), checks what it can (the release record's digests, cosign's pinned digest, the
 * trusted root's digest from Sigstore's TUF targets), caches them, and sends them over the
 * profile's pinned ssh into a scratch directory. `orca-server-setup.py --bundle <dir>` then
 * verifies the signature on the host as it always does, with the pushed cosign (checked against
 * the same pin) and the pushed trusted root (`tools/deploy/orca-release.py`, `PUSHED_TRUSTED_ROOT`).
 *
 * The trusted root is the one thing the host takes on the client's word: the TUF metadata that
 * names it is read over TLS but its signatures are not checked here. That is no more than the
 * same client could do with the ssh login it pushes through, which already runs anything as that
 * account; it is still recorded in the setup's steps as pushed.
 *
 * Behind the incubating `tailnet-hosts` flag: nothing calls it while the flag is off.
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Must match `BUNDLE_REPOSITORY` in tools/deploy/orca-release.py (a test reads it). */
export const BUNDLE_REPOSITORY = "cschadewitz/Project_Orca";
/** Must match `COSIGN_VERSION` and `COSIGN_SHA256` in tools/deploy/orca-release.py. */
export const COSIGN_VERSION = "v3.1.4";
export const COSIGN_PINS: Readonly<Record<string, { name: string; sha256: string }>> = {
  x86_64: { name: "cosign-linux-amd64", sha256: "424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa" },
  aarch64: { name: "cosign-linux-arm64", sha256: "ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2" },
};
/** Must match `PUSHED_TRUSTED_ROOT` in tools/deploy/orca-release.py. */
export const TRUSTED_ROOT_FILE = "trusted_root.json";
/** Sigstore's public-good TUF repository, which cosign itself reads. */
export const SIGSTORE_TUF = "https://tuf-repo-cdn.sigstore.dev";

const VERSION = /^\d+\.\d+\.\d+(?:-(?:rc|beta|alpha)\.\d+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RECORD = /<!-- orca-server-run: [0-9]+ sha256:([0-9a-f]{64}) sha256:([0-9a-f]{64}) sha256:([0-9a-f]{64}) -->/g;

const LIMITS = {
  json: 4 << 20,
  archive: 512 << 20,
  small: 4 << 20,
  cosign: 256 << 20,
  trustedRoot: 1 << 20,
};

/** One file to carry: where it is cached here, and what it must hash to there. */
export interface CourierFile {
  /** The file name in the host's scratch directory (one remote word). */
  name: string;
  path: string;
  sha256: string;
  size: number;
}

export interface CourierPackage {
  version: string;
  /** The three bundle files, then cosign, then the trusted root. */
  files: CourierFile[];
}

/** HTTPS GET bounded to `limit` bytes. A test passes its own. */
export type CourierFetch = (url: string, limit: number, accept?: string) => Promise<Buffer>;

/** Thrown for anything that makes the package unusable: nothing is carried. */
export class CourierRefused extends Error {
  override readonly name = "CourierRefused";
}

/** The release's three server bundle file names (`bundle_names` in orca-release.py). */
export function bundleFileNames(version: string): [archive: string, manifest: string, signature: string] {
  const stem = `orca-server-${version}-linux-x64`;
  return [`${stem}.tar.xz`, `${stem}.manifest.json`, `${stem}.manifest.json.sigstore.json`];
}

export const httpsFetch: CourierFetch = async (url, limit, accept) => {
  if (!url.startsWith("https://")) throw new CourierRefused("Downloads must use HTTPS");
  const response = await fetch(url, {
    headers: { "user-agent": "orca-courier", ...(accept ? { accept } : {}) },
    redirect: "follow",
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.url.startsWith("https://")) throw new CourierRefused("Download redirected away from HTTPS");
  if (!response.ok || !response.body) throw new CourierRefused(`Download failed (${response.status}): ${url}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) throw new CourierRefused(`Download exceeds ${limit} bytes: ${url}`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > limit) throw new CourierRefused(`Download exceeds ${limit} bytes: ${url}`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function json(data: Buffer, what: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(data.toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Refused below.
  }
  throw new CourierRefused(`${what} is not a JSON object`);
}

const at = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    value,
  );

/**
 * A cached file, reused only when it still hashes to `digest`; otherwise fetched, checked and
 * written in place by rename, so a partial download is never mistaken for a cached one.
 */
async function cached(
  dir: string,
  name: string,
  digest: string,
  download: () => Promise<Buffer>,
): Promise<CourierFile> {
  if (!SHA256.test(digest)) throw new CourierRefused(`No digest to check ${name} against`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  if (existsSync(path) && (await fileSha256(path)) === digest)
    return { name, path, sha256: digest, size: statSync(path).size };
  const data = await download();
  if (sha256(data) !== digest) throw new CourierRefused(`Downloaded ${name} is not the recorded file`);
  const partial = `${path}.${process.pid}.partial`;
  rmSync(partial, { force: true });
  writeFileSync(partial, data, { mode: 0o600 });
  renameSync(partial, path);
  return { name, path, sha256: digest, size: data.length };
}

/**
 * The three bundle files of release vVERSION, by its API record: the same checks as the host's
 * `fetch_bundle` (a published release of exactly that version, one complete bundle record, every
 * asset matching its recorded digest).
 */
async function bundleFiles(version: string, cacheDir: string, get: CourierFetch): Promise<CourierFile[]> {
  const names = bundleFileNames(version);
  const record = json(
    await get(
      `https://api.github.com/repos/${BUNDLE_REPOSITORY}/releases/tags/v${version}`,
      LIMITS.json,
      "application/vnd.github+json",
    ),
    "The release record",
  );
  if (record.draft === true || record.prerelease !== version.includes("-") || record.tag_name !== `v${version}`)
    throw new CourierRefused("Target is not a published release of that version");
  const body = typeof record.body === "string" ? record.body : "";
  const records = [...body.matchAll(RECORD)];
  if (records.length !== 1 || body.split("orca-server-run").length !== 2)
    throw new CourierRefused(`Release v${version} has no complete server bundle yet; retry later`);
  const recorded = records[0]!.slice(1, 4);
  const assets = new Map(
    (Array.isArray(record.assets) ? record.assets : [])
      .map((asset) => asset as Record<string, unknown>)
      .map((asset) => [asset.name, asset] as const),
  );
  const dir = join(cacheDir, "bundles", `v${version}`);
  const files: CourierFile[] = [];
  for (const [index, name] of names.entries()) {
    const asset = assets.get(name);
    const url = asset?.browser_download_url;
    if (typeof url !== "string" || asset?.digest !== `sha256:${recorded[index]}`)
      throw new CourierRefused(`Release v${version}'s ${name} is missing or not the recorded one; retry later`);
    files.push(await cached(dir, name, recorded[index]!, () => get(url, index === 0 ? LIMITS.archive : LIMITS.small)));
  }
  return files;
}

/** The pinned cosign for the host's machine type (`uname -m`). */
async function cosignFile(machine: string, cacheDir: string, get: CourierFetch): Promise<CourierFile> {
  const pin = COSIGN_PINS[machine];
  if (!pin) throw new CourierRefused(`No pinned cosign for ${machine}`);
  return cached(join(cacheDir, `cosign-${COSIGN_VERSION}`), pin.name, pin.sha256, () =>
    get(`https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/${pin.name}`, LIMITS.cosign),
  );
}

/**
 * Sigstore's current trusted root, found the way a TUF client finds it (timestamp, then the
 * snapshot it names, then the targets that snapshot names, then the target by its digest), and
 * checked against the length and digest the targets list. Always fetched fresh: it rotates.
 */
async function trustedRootFile(cacheDir: string, get: CourierFetch): Promise<CourierFile> {
  const version = (value: unknown, what: string): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
      throw new CourierRefused(`Sigstore's ${what} has no version`);
    return value;
  };
  const timestamp = json(await get(`${SIGSTORE_TUF}/timestamp.json`, LIMITS.json), "Sigstore's timestamp");
  const snapshotVersion = version(at(timestamp, "signed", "meta", "snapshot.json", "version"), "timestamp");
  const snapshot = json(
    await get(`${SIGSTORE_TUF}/${snapshotVersion}.snapshot.json`, LIMITS.json),
    "Sigstore's snapshot",
  );
  const targetsVersion = version(at(snapshot, "signed", "meta", "targets.json", "version"), "snapshot");
  const targets = json(await get(`${SIGSTORE_TUF}/${targetsVersion}.targets.json`, LIMITS.json), "Sigstore's targets");
  const target = at(targets, "signed", "targets", TRUSTED_ROOT_FILE);
  const digest = at(target, "hashes", "sha256");
  const length = at(target, "length");
  if (typeof digest !== "string" || !SHA256.test(digest) || typeof length !== "number" || length > LIMITS.trustedRoot)
    throw new CourierRefused("Sigstore's targets do not describe a trusted root");
  const file = await cached(join(cacheDir, "sigstore"), TRUSTED_ROOT_FILE, digest, async () => {
    const data = await get(`${SIGSTORE_TUF}/targets/${digest}.${TRUSTED_ROOT_FILE}`, LIMITS.trustedRoot);
    if (data.length !== length) throw new CourierRefused("Sigstore's trusted root is not the listed length");
    return data;
  });
  const media = at(json(readFileSync(file.path), "Sigstore's trusted root"), "mediaType");
  if (typeof media !== "string" || !media.startsWith("application/vnd.dev.sigstore.trustedroot"))
    throw new CourierRefused("Sigstore's trusted root is not a trusted root");
  return file;
}

export interface PrepareCourierOptions {
  version: string;
  /** The host's `uname -m`. The server bundle is linux-x64 only, so `x86_64`. */
  machine?: string;
  /** Where the files are cached on this computer, e.g. the app's data folder. */
  cacheDir: string;
  fetch?: CourierFetch;
}

/** Everything a host with no internet access needs to be set up or updated to `version`. */
export async function prepareCourier(options: PrepareCourierOptions): Promise<CourierPackage> {
  if (!VERSION.test(options.version)) throw new CourierRefused(`Not a release version: ${options.version}`);
  const machine = options.machine ?? "x86_64";
  if (machine !== "x86_64") throw new CourierRefused("The server bundle is linux-x64 only");
  const get = options.fetch ?? httpsFetch;
  const bundle = await bundleFiles(options.version, options.cacheDir, get);
  const cosign = await cosignFile(machine, options.cacheDir, get);
  const root = await trustedRootFile(options.cacheDir, get);
  return { version: options.version, files: [...bundle, cosign, root] };
}

/** A scratch directory `mktemp -d` printed on the host: `/tmp/tmp.XXXXXXXXXX` or under `$TMPDIR`. */
const SCRATCH = /^\/[A-Za-z0-9._/-]{1,200}$/;

/** What `push` needs from an open, pinned tunnel (`SshTunnel.exec` and `SshTunnel.upload`). */
export interface CourierTransport {
  exec(command: readonly string[], timeoutMs?: number): Promise<{ code: number; stdout: string }>;
  upload(path: string, remotePath: string, timeoutMs?: number): Promise<void>;
}

/** A large archive over a slow tailnet path: minutes, not seconds. */
export const PUSH_TIMEOUT_MS = 30 * 60_000;

/**
 * Send the package into a new scratch directory on the host and check every file arrived intact
 * there (`sha256sum`). Returns the directory, for `orca-server-setup.py --bundle`. The host's own
 * signature check comes after, in the setup.
 */
export async function pushCourier(transport: CourierTransport, pkg: CourierPackage): Promise<string> {
  const made = await transport.exec(["mktemp", "-d"]);
  const dir = made.stdout.trim();
  if (made.code !== 0 || !SCRATCH.test(dir) || dir.split("/").includes(".."))
    throw new CourierRefused("Could not make a scratch directory on the server");
  try {
    for (const file of pkg.files) await transport.upload(file.path, `${dir}/${file.name}`, PUSH_TIMEOUT_MS);
    const sums = await transport.exec(["sha256sum", "--", ...pkg.files.map((file) => `${dir}/${file.name}`)]);
    const found = new Map(
      sums.stdout
        .split("\n")
        .map((line) => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim()))
        .filter((match) => match !== null)
        .map((match) => [match[2]!, match[1]!] as const),
    );
    for (const file of pkg.files)
      if (found.get(`${dir}/${file.name}`) !== file.sha256)
        throw new CourierRefused(`${file.name} did not arrive intact on the server`);
    return dir;
  } catch (error) {
    await dropCourier(transport, dir);
    throw error;
  }
}

/** Remove a scratch directory `pushCourier` made. Best effort: it is under the host's temp dir. */
export async function dropCourier(transport: CourierTransport, dir: string): Promise<void> {
  if (!SCRATCH.test(dir) || dir.split("/").includes("..")) return;
  try {
    await transport.exec(["rm", "-r", "-f", "--", dir]);
  } catch {
    // Left for the host's temp cleanup.
  }
}
