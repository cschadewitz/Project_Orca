- **engine/daemon:** Integrate Request admission, configuration generations and live
  permission callbacks under protocol 1.10. CLI/ACP submissions use explicit current
  authority. Runtime recovery and performance findings from #397 still require final
  verification; this integration does not establish credential-rotation recovery.
- **app:** Integrate authenticated daemon switching, persistent workspace/boot identity
  and connection epochs, plus connected live-permission invalidation. The #397 review's
  connection UI findings remain subject to the corresponding app fixes.
