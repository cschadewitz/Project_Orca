// A hook where something writes to stdout directly before the hook answers "allow" (#704).
import { answer } from "../../../src/bin/hook-output-guard.js";
process.stdout.write("garbage");
answer({ exitCode: 0, stdout: "", stderr: "" });
