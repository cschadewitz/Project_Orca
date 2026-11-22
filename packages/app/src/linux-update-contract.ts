/**
 * The Linux `.deb` has no updater (#888): main checks the public releases and the renderer
 * shows a notice. The renderer never supplies a URL or a command; it can only ask main to
 * open the release page or copy the install command main built.
 */
export interface LinuxUpdateNotice {
  current: string;
  version: string;
  /** The release page, built by main from the version's tag. */
  releaseUrl: string;
  /** The `apt` command for this machine's architecture, run after downloading the `.deb`. */
  installCommand: string;
}
export type LinuxUpdateAction = "open" | "copy";

/**
 * "Restart to finish update" for the `.deb` (#905): dpkg reports `installed`, another version
 * than the running `current`, so `apt` upgraded the package beneath this app. Restarting hands
 * the store to the installed version, as the Windows updater does, then starts it.
 */
export interface LinuxRestartState {
  phase: "ready" | "restarting" | "error";
  current: string;
  installed: string;
  message?: string;
}
