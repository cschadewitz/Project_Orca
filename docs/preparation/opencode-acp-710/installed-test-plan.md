# Bounded installed-provider test plan for OpenCode 1.19.4 (#710) — NOT RUN

This plan is **not authorized by #710 or by this packet**. Running it needs a separate,
explicit authorization that names:

- the operator and the host;
- the payer, with a budget cap (suggested: one provider key with a hard spend limit of a
  few US dollars);
- the stop limits.

Nothing below has been executed. Its results would be **connectivity-tested** and, for
section B only, **approval-tested** evidence for exactly: OpenCode 1.19.4 platform binary
(verified hash) × Anthropic via API key × the named host × ORCA at the tested commit. They
would never be execution-guard certification (section C remains NO-GO), and never
evidence for OpenCode 2, another backend or another host.

## Scope and effects

- **Workspace:** a fresh `PROFILE/workspace` git repository containing two files:
  `notes.txt` and a canary `outside/canary.txt` placed *outside* the workspace root.
- **Prompts** ask only for benign effects:
  - read `notes.txt`;
  - write one line to `notes.txt`;
  - run `git status` and `printf ok`.
- **Forbidden:** no network tools (natively denied), no package installs, no destructive
  commands.
- **Budget:** at most 10 prompts and 30 minutes of wall-clock time. Stop at the first
  unexpected effect.
- **Observation, independent of OpenCode and ORCA logs:**
  - file hashes of the workspace and canary before and after every step;
  - process listing for leftover children;
  - for denied shell commands, a sentinel file the command would have created.

## A — connectivity

1. Run setup [steps 1–6](setup-preflight.md).
2. **Handshake.** Open a session through ORCA (`orca ping opencode-acp-710` or a one-step workflow
   on this agent). Record:
   - `initialize`: `protocolVersion`, `agentCapabilities`, `authMethods`, `agentInfo`;
   - `session/new`: the session id.

   Expect protocol 1 and `agentInfo.version` 1.19.4.
3. **Streaming and identity.** Prompt "Reply with the word ok." Record the
   `session/update` kinds, the stop reason, and that updates carry the session id.
4. **Error.** Temporarily rename `auth.json`, prompt, and record the error code and
   message: the expected auth failure. Rename it back.
5. **Cancellation.**
   - Prompt a slow benign request, then cancel it in ORCA.
   - Record the stop reason (`cancelled` expected) and that the turn ends within
     `cancelGraceMs`.
   - Record that no child process remains.
6. **Unsupported.** Confirm that no `terminal/*` request arrives in ORCA's debug log.
   Record any `fs/*` requests, with paths.

## B — controlled approval validation

Each step records:

- the raw `session/request_permission`: options, kind, title, locations, `rawInput`;
- ORCA's decision;
- OpenCode's resulting behaviour;
- the independent effect observation.

1. **Offered options.** Assert that the offered set is exactly once/always/reject, with
   kinds `allow_once`, `allow_always`, `reject_once`.
2. **Rule-matched allow.** An in-workspace read and write of `notes.txt` (#140 default
   allow). Expect `once` selected and one effect each. Expect an `fs/write_text_file`
   mirror and a native write.
3. **Explicit denial.**
   - A configured ORCA rule `{ kind: execute, titlePattern: "^printf ok$" } deny`.
   - Ask for `printf ok > sentinel`. Note: the title is the whole command, so use the exact
     command in the rule.
   - Expect `reject`, **no sentinel**, and the turn stopping.
4. **Human answer, once.** `git status` with ORCA asking a human, who answers once. A
   second identical command must ask again.
5. **Human answer, always — scope probe.**
   - Answer always on one edit.
   - Then request an edit to a second file: expect **no ask** (native directory-wide
     grant). Record this as the remembered-approval gap.
   - Restart the agent and repeat: expect an ask (not persisted).
6. **Changed arguments and cwd.**
   - `git status` approved once.
   - Then `git status && printf x > sentinel2`: expect a new ask.
   - Then `git status` with a model-chosen `workdir` outside the workspace: record whether
     the ask shows any cwd (expected: none) and whether `external_directory` (natively
     denied) fires first.
7. **Cancellation while asked.** Cancel the turn while a human ask is open. Expect a
   rejection, no effect, and a later human answer ignored.
8. **Stale and duplicate replies.**
   - Answer an ask after its turn has ended; expect no effect.
   - Record whether OpenCode ever sends two asks with the same tool-call id.
9. **Subagent.** Prompt "use a subagent to list files". Expect the natively denied `task`
   and no hang. Do **not** allow `task`: on 1.19.4 a child's asks are dropped, and the
   turn would hang until `turnTimeoutMs`.
10. **Out-of-workspace canary.** Ask to read `outside/canary.txt`. Expect the native
    `external_directory` deny, and the canary's access time and hash unchanged where the
    file system records them.

Pass for B requires every denial to be independently observed as not executed.

Record as **not covered** whatever B cannot observe:

- shell child effects beyond the sentinel;
- network;
- plugins and formatters (disabled);
- MCP (none).

## Stop conditions

Stop immediately and report if any of these happens:

- an effect occurs without a corresponding ask or allow;
- a sentinel or canary changes after a denial;
- any MCP, LSP, formatter or plugin activity appears;
- the binary hash or version differs;
- any managed configuration appears;
- spend approaches the cap.

Cleanup follows [setup-preflight.md](setup-preflight.md#cleanup).

## Evidence to publish

Publish only public-safe material:

- the binary SHA-256 and npm integrity;
- the host OS, architecture and version;
- the ORCA commit;
- the commands run and their results;
- the request/response shapes, with tool inputs reduced to the benign test strings;
- the effect observations;
- skipped stages and cleanup confirmation.

Never publish a key, `auth.json`, the operator's environment values, or private paths.
