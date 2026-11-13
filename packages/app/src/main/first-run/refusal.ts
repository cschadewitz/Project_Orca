/** Why setup refused, in words written for the person. The IPC boundary shows these as they are and replaces anything else. */
export class FirstRunRefusal extends Error {
  override name = "FirstRunRefusal";
}

export const PRESERVED = "Existing files were preserved.";

/**
 * A curated reason for an operating system or Git failure that reached setup unannotated. Only the error's code and
 * the command that failed are read, never its message, so no raw path or tool output reaches the screen.
 */
export function failureReason(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  const cmd = "cmd" in error ? (error as { cmd?: unknown }).cmd : undefined;
  if (typeof cmd === "string" && /^"?git(\.exe)?"? /.test(cmd)) {
    if (code === "ENOENT")
      return "Git was not found. Install Git and make sure it is on the PATH this app starts with, then choose again.";
    if ("killed" in error && (error as { killed?: unknown }).killed)
      return "Git took too long to read the selected project. Check the project folder, then choose again.";
    return "Git could not read the selected project folder. Check that it is a Git checkout your account can read, then choose again.";
  }
  if (code === "EACCES" || code === "EPERM")
    return "Your account cannot read and write a selected folder. Check its permissions, then choose again.";
  if (code === "ENOENT")
    return "A selected folder or one of its setup files no longer exists. Choose the directories again.";
  if (code === "EBUSY") return "A selected folder or setup file is in use by another program. Close it, then retry.";
  if (code === "ENOSPC") return "The app workspace drive is full. Free some space, then retry.";
  if (code === "EROFS") return "The app workspace is on a read-only drive. Choose a writable folder.";
  return undefined;
}
