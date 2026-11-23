// A hook where something leaves with exit 0 before the hook answers (#704).
import "../../../src/bin/hook-output-guard.js";
process.exit(0);
