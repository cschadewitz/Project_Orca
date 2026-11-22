/** The fixture-side guard against kernel-fence port collisions under parallel workers (#807, #819). */
import { cp, mkdir, mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { createServer, connect, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fenceDirectory } from "@orca/protocol/first-run-fence";
import {
  autobindRange,
  clearOfAutobind,
  copyToFenceDirectory,
  fencePorts,
  selectFenceDirectory,
} from "./fixtures/fence-ports.js";

const bases: string[] = [];
afterEach(async () => {
  for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true });
});
const base = async () => {
  const path = await mkdtemp(join(process.cwd(), "orca-fence-ports-"));
  bases.push(path);
  return path;
};
const linuxIt = it.skipIf(process.platform !== "linux");

linuxIt("an outgoing loopback connection takes its local port from the autobind range", async () => {
  // The failure mode itself: any worker's client socket can sit on a hashed fence slot there.
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = connect((server.address() as AddressInfo).port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => client.once("connect", resolve).once("error", reject));
    const [low, high] = autobindRange();
    expect(client.localPort).toBeGreaterThanOrEqual(low);
    expect(client.localPort).toBeLessThanOrEqual(high);
    client.destroy();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

linuxIt("most hashed fence slots overlap the autobind range, so unselected fixtures can collide", () => {
  const [low, high] = autobindRange();
  // Slot ranges start at 20000 + 8k for k < 5000: count those touching [low, high].
  let overlapping = 0;
  for (let k = 0; k < 5000; k++) {
    const start = 20000 + 8 * k;
    if (start + 7 >= low && start <= high) overlapping++;
  }
  expect(overlapping / 5000).toBeGreaterThan(0.5);
});

it("selects an empty directory whose slots, under every alias, avoid the autobind range", async () => {
  const root = await base();
  const path = join(root, "home", "ORCA");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const alias = join(root, "renamed", "ORCA");
  await selectFenceDirectory(path, [alias]);
  const identity = fenceDirectory(path);
  expect(clearOfAutobind(identity, [path, alias])).toBe(true);
  const [low, high] = autobindRange();
  for (const port of [...fencePorts(identity), ...fencePorts({ ...identity, path: alias })])
    expect(port < low || port > high).toBe(true);
  // Rejected directories never outlive selection.
  expect(await readdir(join(root, "home"))).toEqual(["ORCA"]);
});

it("copies a directory to a new inode clear of the autobind range, keeping its bytes", async () => {
  const root = await base();
  const source = join(root, "before");
  await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, "window.json"), '{"version":1}', { mode: 0o600 });
  const path = join(root, "control");
  await copyToFenceDirectory(source, path, (from, to) => cp(from, to, { recursive: true }));
  expect(clearOfAutobind(fenceDirectory(path))).toBe(true);
  expect(fenceDirectory(path).ino).not.toBe(fenceDirectory(source).ino);
  expect(await readFile(join(path, "window.json"), "utf8")).toBe('{"version":1}');
  expect((await readdir(root)).sort()).toEqual(["before", "control"]);
});
