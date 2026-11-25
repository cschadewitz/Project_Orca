// A stand-in for gh, curl and az in tools/test/rename-cutover.test.js. Answers from the world in
// $MOCK_WORLD (JSON) and appends every call to $MOCK_CALLS, one JSON array per line.
//   world.gh["GET repos/o/r"]       -> body (object) or {"$status": 1} for not found
//   world.cf["GET /zones?name=x"]   -> Cloudflare response body
//   world.http["GET https://x/"]    -> {code, location, headers}
//   world.az["ad app list"]          -> stdout text (the longest matching argument prefix wins)
import { appendFileSync, readFileSync } from "node:fs";

const [tool, ...args] = process.argv.slice(2);
appendFileSync(process.env.MOCK_CALLS, `${JSON.stringify([tool, ...args])}\n`);
const world = JSON.parse(readFileSync(process.env.MOCK_WORLD, "utf8"));
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

if (tool === "gh") {
  if (args[0] !== "api") process.exit(0);
  const method = flag("-X") ?? "GET";
  const path = args
    .slice(1)
    .find((a, i, all) => !a.startsWith("-") && all[i - 1] !== "-X" && all[i - 1] !== "-f" && all[i - 1] !== "--input");
  const answer = world.gh?.[`${method} ${path}`];
  if (method !== "GET") process.exit(0);
  if (answer === undefined || answer?.$status) process.exit(1);
  process.stdout.write(JSON.stringify(answer));
} else if (tool === "curl") {
  const method = flag("-X") ?? "GET";
  const url = args.find((a) => /^https?:/.test(a));
  const base = process.env.CLOUDFLARE_API_BASE;
  if (base && url.startsWith(base)) {
    const key = `${method} ${url.slice(base.length)}`;
    const answer =
      world.cf?.[key] ??
      (method === "GET"
        ? { success: false, errors: [{ code: 10003 }] }
        : { success: true, result: { id: `new-${key}` } });
    process.stdout.write(JSON.stringify(answer));
  } else {
    const answer = world.http?.[`${method} ${url}`] ?? { code: 0 };
    if (args.includes("-D")) process.stdout.write(answer.headers ?? "");
    const format = flag("-w");
    if (format)
      process.stdout.write(
        format
          .replace("%{http_code}", String(answer.code).padStart(3, "0"))
          .replace("%{redirect_url}", answer.location ?? ""),
      );
  }
} else if (tool === "az") {
  const joined = args.join(" ");
  const keys = Object.keys(world.az ?? {})
    .filter((key) => joined.startsWith(key))
    .sort((a, b) => b.length - a.length);
  if (keys.length) process.stdout.write(world.az[keys[0]]);
}
