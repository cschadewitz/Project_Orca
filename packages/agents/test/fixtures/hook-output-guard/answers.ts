// A hook that answers and nothing else (#704).
import { answer } from "../../../src/bin/hook-output-guard.js";
void answer({ exitCode: 0, stdout: process.argv[2] ?? "", stderr: "" });
