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
