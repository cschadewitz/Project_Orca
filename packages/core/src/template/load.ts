/** Load prompt templates from markdown files matched by config glob patterns. */
import { readFile } from "node:fs/promises";
import { expandPatterns } from "../util/glob.js";
import { parsePromptTemplate, TemplateRegistry } from "./registry.js";

/** Load every template matched by `patterns` (relative ones resolved against `baseDir`) into a registry. */
export async function loadTemplates(patterns: string[], baseDir: string): Promise<TemplateRegistry> {
  const reg = new TemplateRegistry();
  for (const f of await expandPatterns(patterns, baseDir))
    reg.register(parsePromptTemplate(await readFile(f, "utf8"), f));
  return reg;
}
