- **daemon:** Require raw configuration read authority for every Save/validation receipt.
  Recheck credentials and grants after reads and before configuration or permission-sidecar
  replacement and generation activation; remove staged files on refusal. Apply continues
  to require configuration write authority alone and returns no raw editor bytes.
