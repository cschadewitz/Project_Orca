/**
 * Agent sign-ins on a managed server, each bound to the window that started it (#1236).
 *
 * One sign-in may wait per agent on a machine. Its prompt (the page's host and the code to enter)
 * goes only to the window that asked; the page itself stays here and is opened only when that
 * same window asks. The sign-in is cancelled when that window navigates, crashes or closes, and
 * its page is forgotten when it ends. An attempt only ever clears what is its own.
 */
import type { HostAgentLoginPrompt } from "@orca/protocol/server-agents";
import { ConnectionRefusal } from "./connection-target.js";

/** What main shows the renderer about a waiting sign-in: never the page's URL. */
export interface AgentSignInPrompt {
  profileId: string;
  agent: string;
  host?: string;
  code?: string;
}

/** The parts of a WebContents a sign-in needs. */
export interface SignInSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, view: AgentSignInPrompt): void;
  once(event: SenderEnd, listener: () => void): unknown;
  removeListener(event: SenderEnd, listener: () => void): unknown;
}

/** When the window that started a sign-in no longer shows it. */
type SenderEnd = "destroyed" | "did-navigate" | "render-process-gone";
const ENDS: readonly SenderEnd[] = ["destroyed", "did-navigate", "render-process-gone"];

export const AGENT_SIGN_IN_CHANNEL = "orca:profiles.agentSignIn";

interface Attempt {
  sender: SignInSender;
  url?: string;
  controller: AbortController;
}

export class AgentSignIns {
  private readonly attempts = new Map<string, Attempt>();

  /**
   * Run one sign-in for `sender`. Refused while another for the same agent on the same machine is
   * waiting. `signIn` gets where to report the prompt and a signal that ends it.
   */
  async run(
    sender: SignInSender,
    profileId: string,
    agent: string,
    signIn: (onPrompt: (prompt: HostAgentLoginPrompt) => void, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const key = `${profileId} ${agent}`;
    if (this.attempts.has(key))
      throw new ConnectionRefusal("A sign-in for this agent on this machine is already waiting.");
    if (sender.isDestroyed()) throw new ConnectionRefusal("The window that asked has closed.");
    const attempt: Attempt = { sender, controller: new AbortController() };
    this.attempts.set(key, attempt);
    const end = () => attempt.controller.abort();
    for (const event of ENDS) sender.once(event, end);
    try {
      await signIn((prompt) => {
        if (this.attempts.get(key) !== attempt || attempt.controller.signal.aborted || sender.isDestroyed()) return;
        let host: string | undefined;
        if (prompt.url) {
          attempt.url = prompt.url;
          host = new URL(prompt.url).host;
        }
        sender.send(AGENT_SIGN_IN_CHANNEL, {
          profileId,
          agent,
          ...(host ? { host } : {}),
          ...(prompt.code ? { code: prompt.code } : {}),
        });
      }, attempt.controller.signal);
    } finally {
      for (const event of ENDS) sender.removeListener(event, end);
      if (this.attempts.get(key) === attempt) this.attempts.delete(key);
    }
  }

  /** The page of the sign-in `sender` started, while it waits. Never another window's. */
  url(sender: SignInSender, profileId: string, agent: string): string {
    const attempt = this.attempts.get(`${profileId} ${agent}`);
    if (!attempt?.url || attempt.sender.id !== sender.id || attempt.controller.signal.aborted)
      throw new ConnectionRefusal("That agent's sign-in is not waiting for you.");
    return attempt.url;
  }

  /** Quit: end every sign-in. */
  close(): void {
    for (const attempt of this.attempts.values()) attempt.controller.abort();
  }
}
