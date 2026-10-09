# Byte-backed diagnostics preview

`preparePreview` returns metadata and a fresh handle, never a complete report string.
Main retains the validated, frozen UTF-8 report in its shared binary arena. The
1 MiB complete-report ceiling, canonical privacy grammar, consent, boot/age fences
and exact Save digest remain unchanged. Production capture stays disabled.

One sequential `readPreviewBlock(handle, offset)` may be outstanding. The block
contains at most 16,384 bytes and ends at an existing newline. It reuses an
independent 16,384-byte backing store with zeroed padding: returning an arena subarray would expose/copy the whole
5 MiB arena. The next offset is admitted only after `releasePreviewBlock` erases
the prior main copy. Reads require current document/target/preview authority;
erasure acknowledgements can cross a revoked target epoch only from the same
verified current window document. Stale handles cannot dispose successor content.

Main assigns monotonic revisions to status snapshots and binds the successful
descriptor to its latest revision. Preload and renderer reject older pushed status
after accepting a descriptor. A delayed Off or closed-preview snapshot cannot
retire a successor; newer revocation still erases in-flight copies immediately.

Main admits 1,048,576 bytes for the renderer owner and 49,152 bytes for three
transport copies before returning the descriptor. These are controlled ownership
reservations, not a zero-copy claim or a bound on engine/native internals. IPC and
contextBridge both copy. Preload retains and erases its isolated-world copy after
renderer acknowledgement, and fences replies pending during revocation. Renderer
copies each block into one bounded UTF-8 owner, decodes with fatal UTF-8 handling,
erases its incoming copy and yields between bounded batches through one reusable
MessageChannel. Background timer throttling cannot stall this cooperative task
queue. The complete report
is rendered in one focusable, labelled `pre` with all blocks in document order;
offscreen layout uses the existing content-visibility rules. No omitted text,
pagination or preview reconstruction is used for Save.

The picker is refused until every byte is acknowledged. Renderer exposes the
preview and picker only after loading the complete owner. Save stages the original
main bytes, independent of the renderer's decoded view. Close, Off, expiry,
source/target invalidation and unmount clear byte and text references. Preload and
renderer zero each retired owned ArrayBuffer before `transferToFixedLength(0)`
detaches it and retires its backing storage. This is an ordinary ownership disposal
operation, not a GC request. A runtime without that primitive retains the zeroed
fallback until collection; its resource gate still requires actual measurement.
Disposal
acknowledgement waits for pending renderer reads and DOM removal. Main keeps the
retired renderer/transport allowance until that acknowledgement or verified
document/process disposal. Already admitted Save work retains its frozen payload
until actual settlement. Erasure and reference disposal do not claim synchronous
physical collection of retired JS strings, ArrayBuffers or engine storage.

Managed/external/native readings must still include transport and decoder costs,
preload storage and DOM/embedder allocations. The gates remain 8 MiB continuous
controlled binary admission, 32 MiB combined process increment and strict 4 ms
responsiveness. Device, accessibility, independent-review and paired-load evidence
must identify its exact implementation head; source tests alone cannot close them.
