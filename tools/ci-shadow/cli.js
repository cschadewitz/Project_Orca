/** Print a shadow plan or reject a stale artifact; never set workflow skip/gate outputs. */
import { readFileSync } from "node:fs";
import { createPlan, validatePlan } from "./selector.js";

try {
  const args = process.argv.slice(2);
  const mode = args.shift();
  if (!["plan", "validate"].includes(mode) || args.length % 2) throw new Error("invalid_arguments");
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (
      !["--repo", "--base", "--head", "--candidate", "--artifact", "--force-full"].includes(args[index]) ||
      options[args[index]] !== undefined
    )
      throw new Error("invalid_arguments");
    options[args[index]] = args[index + 1];
  }
  if (
    ["--repo", "--base", "--head", "--candidate"].some((key) => !options[key]) ||
    (options["--force-full"] !== undefined && !["true", "false"].includes(options["--force-full"])) ||
    (mode === "validate" && !options["--artifact"]) ||
    (mode === "plan" && options["--artifact"])
  )
    throw new Error("invalid_arguments");
  const input = {
    repo: options["--repo"],
    base: options["--base"],
    head: options["--head"],
    candidate: options["--candidate"],
    forceFull: options["--force-full"] === "true",
  };
  const plan =
    mode === "plan" ? createPlan(input) : validatePlan(JSON.parse(readFileSync(options["--artifact"], "utf8")), input);
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
} catch (error) {
  // No partial artifact on error. A later consumer must fail or recompute a verified full plan.
  process.stderr.write(`Shadow selection failed: ${error instanceof Error ? error.message : "unknown_error"}\n`);
  process.exitCode = 1;
}
