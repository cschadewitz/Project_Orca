// A hook whose dependency prints on stdout before the hook answers "allow" (#704).
import { answer } from "../../../src/bin/hook-output-guard.js";
// eslint-disable-next-line no-console -- the stray output under test
console.log("a dependency talking");
void answer({ exitCode: 0, stdout: "", stderr: "" });
