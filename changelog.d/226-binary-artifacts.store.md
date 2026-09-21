An artifact's body is now bytes rather than a UTF-8 string, so a PNG, a PDF or any other
binary an agent produces round-trips through the store intact. **No field was added to
`artifacts/index.jsonl` and no blob has to be rewritten:** a blob is still a file named by
the sha-256 of its content, and hashing a string in Node hashes its UTF-8 bytes, so every
blob an existing `.orca` store holds is already the same file under the same name. An index
written by an earlier ORCA loads unchanged.

One value written into the index does change meaning. `size` is now the body's length in
**bytes**; it was its length in characters, which was the same number only for pure ASCII.
Nothing computes with it — it is what the artifact panel shows and what `artifacts.get`
quotes when it declines to carry a body — so an old row's `size` is read as it was written
and is at most slightly low on prose with an em dash in it. New rows are exact.
