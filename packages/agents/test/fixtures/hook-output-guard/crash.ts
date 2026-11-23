// A hook that throws before it answers (#704).
import "../../../src/bin/hook-output-guard.js";
throw new Error("boom");
