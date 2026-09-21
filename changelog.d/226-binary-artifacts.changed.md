- **store:** `ArtifactStore.put` takes a `string` or a `Uint8Array`, and `bytes(id)` reads a
  body back byte for byte. `content(id)` still returns UTF-8 text and is unchanged for every
  caller ORCA has today.
- **engine:** an artifact's `size` is its length in bytes, not in characters.
- **daemon:** `artifacts.get` still declines a binary body — it is the JSON-RPC wire that
  will not carry 200 MB, not the store any more — and the size and media type it names in
  `omitted.detail` are now the real ones.
