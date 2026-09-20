/**
 * `orca://` URLs arriving from outside the app, from all three places an operating system
 * can deliver one, folded into a single queue the renderer reads.
 *
 * The three are not alike and that is the whole of this module:
 *
 * - **a cold start** — the app is not running, so the URL is in `process.argv` on Windows
 *   and Linux, and arrives as an `open-url` event *before* `whenReady` on macOS. Either
 *   way there is no window yet, so it has to be held until one asks;
 * - **`open-url`** — macOS, on a running app;
 * - **`second-instance`** — Windows and Linux, where a second launch is a second process
 *   whose `argv` carries the URL. The single-instance lock is what turns that launch into
 *   an event instead of a second window onto the same store (#165).
 *
 * The queue holds **one** URL, the last: two links delivered before a window exists mean a
 * person clicked twice, and the second is the one they meant. Holding a backlog would open
 * a place they have already left.
 *
 * Electron-free, so the argv parsing and the queue are a plain test; `index.ts` registers
 * the scheme and hangs the two events off this.
 */

/** The scheme this app registers. `orca://run/…`, one object per URL. */
export const ORCA_SCHEME = "orca";

const PREFIX = `${ORCA_SCHEME}://`;

/**
 * The first `orca://` URL in a command line, or undefined.
 *
 * A scan rather than "the last argument": Electron's own switches and, in a development
 * build, the path of the app being run are on that command line too, and on Windows a
 * relaunch can put the URL anywhere after them. Case-insensitive because a scheme is.
 */
export function urlFromArgv(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.toLowerCase().startsWith(PREFIX));
}

/**
 * The arguments `setAsDefaultProtocolClient` needs for a *development* run, where the
 * executable is Electron itself and the app is an argument to it — without them the OS
 * would register plain Electron as the handler for `orca://`. A packaged app is its own
 * executable and needs none of this, which is what the undefined answer says.
 */
export function protocolClientArgs(packaged: boolean, argv: readonly string[]): readonly string[] | undefined {
  if (packaged) return undefined;
  const entry = argv[1];
  return entry === undefined ? undefined : [entry];
}

/**
 * The one URL waiting to be opened, and whoever is listening for the next.
 *
 * `take()` rather than a getter: a deep link is delivered once. A window that reads it on
 * its first paint and then subscribes must not find the same URL again on a reload, or a
 * person who navigated away would be dragged back by a refresh.
 */
export class DeepLinkQueue {
  private waiting: string | undefined;
  private readonly listeners = new Set<(url: string) => void>();

  /** A URL from the OS. Ignored unless it is this app's scheme — anything else is not ours. */
  offer(url: string | undefined): void {
    if (!url || !url.toLowerCase().startsWith(PREFIX)) return;
    if (this.listeners.size === 0) {
      this.waiting = url;
      return;
    }
    for (const listener of [...this.listeners]) listener(url);
  }

  /** What a window opening now should resolve, once. Undefined when there is nothing. */
  take(): string | undefined {
    const url = this.waiting;
    this.waiting = undefined;
    return url;
  }

  /**
   * Hear every URL from here on. Registering does not drain what is waiting — the window
   * reads that synchronously with `take()` before it subscribes, exactly as it reads the
   * connection snapshot before subscribing to changes.
   */
  subscribe(listener: (url: string) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}
