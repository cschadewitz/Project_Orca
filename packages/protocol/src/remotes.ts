/**
 * Remote enrollment through the daemon that owns the workspace (#1206, protocol 2.13).
 *
 * `orca remote enroll` (#883) writes the workspace's enrollment files itself, so in a workspace
 * the desktop app set up in first-run its first-run fence refuses it: only the daemon the app
 * launched is admitted to write there. These two methods are that admitted route. The daemon
 * serving the workspace pins the remote's host keys and proves (or has the remote issue) the
 * credential, under the same enrollment lock and with the same checks as the CLI, and refuses
 * when it no longer holds the workspace's first-run writer fence.
 *
 * - `remotes.list` (`config.read`): the active configuration's remotes, each with what its
 *   enrollment record says. Never a token, never a credential's secret half.
 * - `remotes.enroll` (`config.write`, `config.read`): enroll one of them. A mutation, written to
 *   the audit log with the remote's id and nothing else from the params.
 *
 * New method names in `hello.methods`: a 2.12 client never calls them, and the app offers its
 * Remote daemons section only to a daemon that lists them. A `--read-only` daemon lists neither.
 */
import { z } from "zod";

export const REMOTES_LIST_METHOD = "remotes.list";
export const REMOTES_ENROLL_METHOD = "remotes.enroll";

export const RemotesListParamsSchema = z.object({}).strict();
export type RemotesListParams = z.infer<typeof RemotesListParamsSchema>;

/** A fingerprint as `ssh-keygen -l` prints it. The daemon normalizes and checks it again. */
const Fingerprint = z.string().trim().min(1).max(100);

/** What a remote's enrollment record says, as far as the daemon could read it. */
export const RemoteEnrollmentViewSchema = z.discriminatedUnion("state", [
  /** No record: nothing is pinned for delegation and no credential is sent. */
  z.object({ state: z.literal("none") }).strict(),
  /** A record is on file, but it cannot be read or is for another remote: enroll again. */
  z.object({ state: z.literal("unreadable") }).strict(),
  z
    .object({
      state: z.literal("enrolled"),
      /** The remote's workspace and the principal its credential answers for. */
      workspaceId: z.string(),
      principalId: z.string(),
      /** The credential's public id, never its secret. */
      credentialId: z.string(),
      enrolledAt: z.string(),
      /** Whether the remote issued the credential during enrollment. */
      issued: z.boolean(),
      /**
       * Whether the configured route (destination, port, jump host) is the one the record was
       * enrolled over. A changed route is refused at delegation until it is enrolled again.
       */
      routeCurrent: z.boolean(),
    })
    .strict(),
]);
export type RemoteEnrollmentView = z.infer<typeof RemoteEnrollmentViewSchema>;

export const RemoteViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** `user@host` as configured. */
    destination: z.string(),
    sshPort: z.number().int().optional(),
    /** The jump host's destination, when the route has one: its key is pinned too. */
    jump: z.string().optional(),
    /** The workflows this configuration's agents delegate to the remote, sorted. */
    workflows: z.array(z.string()),
    /** The fingerprints pinned for the server and, with a jump host, for it. */
    pinned: z.array(z.string()),
    jumpPinned: z.array(z.string()),
    /** Whether a credential file is saved at the configured path (never its contents). */
    credentialSaved: z.boolean(),
    enrollment: RemoteEnrollmentViewSchema,
  })
  .strict();
export type RemoteView = z.infer<typeof RemoteViewSchema>;

export const RemotesListResultSchema = z
  .object({
    remotes: z.array(RemoteViewSchema),
    /**
     * Whether this daemon can have the remote issue the credential during enrollment. False
     * on Windows, which cannot order the files it writes across a power loss: there enrollment
     * takes a credential issued on the remote (`orca auth issue <name> --preset client`).
     */
    canIssue: z.boolean(),
  })
  .strict();
export type RemotesListResult = z.infer<typeof RemotesListResultSchema>;

export const RemotesEnrollParamsSchema = z
  .object({
    /** The `remotes[].id` to enroll. Named `id` so the audit record names it. */
    id: z.string().min(1).max(200),
    /** The server's fingerprints, from a source already trusted. Needed while nothing is pinned. */
    hostKeys: z.array(Fingerprint).max(8).default([]),
    /** The same for the jump host. */
    jumpHostKeys: z.array(Fingerprint).max(8).default([]),
    /**
     * A credential the remote issued (`orca auth issue <name> --preset client --json`, as the
     * bare token or that JSON). Saved at the remote's configured credential path, readable only
     * by this user, then proved. Without one, the remote issues it over the verified ssh.
     */
    credential: z.string().max(4096).optional(),
    /** Have the remote issue a new credential even when the one issued earlier still serves. */
    rotate: z.boolean().optional(),
  })
  .strict()
  .refine((p) => !(p.credential !== undefined && p.rotate), {
    message: "rotate asks the remote to issue a credential; it cannot be combined with a saved one",
    path: ["rotate"],
  });
export type RemotesEnrollParams = z.input<typeof RemotesEnrollParamsSchema>;

export const RemotesEnrollResultSchema = z
  .object({
    remote: RemoteViewSchema,
    /** Things left to tidy by hand, such as a stale credential that could not be revoked. */
    warnings: z.array(z.string()),
  })
  .strict();
export type RemotesEnrollResult = z.infer<typeof RemotesEnrollResultSchema>;
