- **daemon:** Closing a daemon now waits for dispatched RPC method handlers after
  closing HTTP and WebSocket transports. A caller disconnect still does not cancel
  an admitted operation; shutdown no longer reports settlement while its handler
  can still write.
