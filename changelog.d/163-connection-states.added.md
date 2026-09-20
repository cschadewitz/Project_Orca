- **app:** the five connection states, decided once. A state machine in the main process
  (`src/main/connection-state.ts`) folds the WebSocket's own state, the bundled daemon's
  exit and the `hello` handshake into `live`, `reconnecting`, `disconnected` or `mismatch`,
  and pushes it to every window over a new `connection` bridge namespace. Leaving `live` is
  silent for five seconds, so a blip that resolves in 400ms changes nothing on screen; after
  that the status bar changes and a 2px stale rule appears under the chrome. The connection
  indicator has moved from the title bar to the status bar and carries the event cursor. A
  daemon that comes back speaking a protocol the app cannot type-check blocks once, with
  both versions, and leaves a persistent bar behind. The app also derives "can write, or why
  not" from the state plus the daemon's `runs.control` capability — absent means writes are
  unavailable and says so calmly, which is every daemon today.
