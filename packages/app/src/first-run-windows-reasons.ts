/** What the Windows folder check's specific refusals say (#1217). No imports, so the screen's tests can use it too. */
const folder = (project: boolean) => (project ? "The project folder" : "The app workspace folder");

/** A folder in the selected chain grants another account write, delete or attribute rights. */
export const untrustedWriterReason = (project: boolean) =>
  `${folder(project)}, or a folder above it, can be changed or deleted by another account. Remove that account's write access in the folder's Security settings, or choose a folder inside your user folder.`;

/** The selected folder's owner is another account. */
export const notOwnerReason = (project: boolean) =>
  `${folder(project)} is owned by another account. Choose a folder your account owns.`;
