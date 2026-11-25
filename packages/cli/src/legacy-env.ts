/**
 * Adopts the environment variables from before the rename to Orrery (`adoptLegacyEnv`), for
 * one release. A side-effect module, imported first by `main.ts`: modules it imports read the
 * environment while they load (`update-bootstrap.ts` reads the update launch variables), so a
 * call inside `main()` would come too late.
 */
import { adoptLegacyEnv } from "@orca/core";

adoptLegacyEnv();
