/**
 * electron-builder afterPack: runs once per platform and architecture, after the unpacked
 * app exists and before any target (deb, tar.gz, AppImage, nsis, …) is built from it.
 */
import { stripSharedWrite } from "./linux-file-modes.js";
import verifyPackagedDiagnostics from "./verify-diagnostics-native.js";

export default function afterPack(context) {
  if (context.electronPlatformName === "linux") stripSharedWrite(context.appOutDir);
  return verifyPackagedDiagnostics(context);
}
