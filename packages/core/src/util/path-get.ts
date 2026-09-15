/** Safe dotted-path lookup used by templates and expressions: `a.b[0].c`. */
export function pathGet(root: unknown, path: string): unknown {
  if (path === "" || path === ".") return root;
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((p) => p.length > 0);
  let cur: unknown = root;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    if (part === "__proto__" || part === "constructor" || part === "prototype") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
