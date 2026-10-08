/** Publish sanitized real full-suite/retry reports; never change the CI verdict. */
import { join } from "node:path";
import { atomicJSON, normalizeVitest, readJSON, validateIdentity } from "./evidence.js";

const root = process.cwd();
const temp = process.env.RUNNER_TEMP;
const identity = validateIdentity(readJSON(join(temp, "ci-shadow-identity.json")));
const lane = (name) => {
  try {
    return normalizeVitest(readJSON(join(temp, name), 32 * 1024 * 1024), root);
  } catch {
    return null;
  } // Missing/partial/malformed result remains unknown in the consumer.
};
atomicJSON(join(temp, "ci-shadow-evidence", "evidence.json"), {
  artifact: "orca-ci-full-evidence",
  schemaVersion: 1,
  identity,
  suite: lane("full-suite.json"),
  retry: lane("retry-acceptance.json"),
});
