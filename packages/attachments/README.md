# Local Attachment Store

The store accepts local files and raw byte streams. New resources use v2: independent
UUID attachment references share immutable objects addressed by SHA256.

```ts
const ref = await store.saveStream({
  name: 'report.bin',
  stream: readable, // AsyncIterable<Uint8Array>; Node Readable is supported
  expectedBytes: contentLength, // optional; checked against actual bytes
  signal
});
await store.verify(ref.attachmentId);
const input = await store.openFile(ref.attachmentId, { strict: true, signal });
```

Layout:

```text
v2/objects/<first-two-hex>/<sha256-hex>
v2/refs/<attachment-id>/metadata.json
v2/refs/<attachment-id>/original/<sanitized-name>
```

Metadata uses `schemaVersion: 2` and `digest: sha256:<hex>`. Message references carry
an optional digest, preserving compatibility with old sessions. Names and previews
belong to references; object bytes are shared through read-only hard links.

The default root is `~/.jojo/attachments/v2`, with read fallback to the sibling v1
store. Explicit roots (including `JOJO_ATTACHMENT_ROOT`) read both new `refs/` and
old `files/` within that root. A second constructor argument can specify a separate
legacy root. Existing v1 files and metadata are never rewritten. Unsupported metadata
versions are rejected rather than silently interpreted as old data.

`saveFile({ path, name?, signal? })` opens a regular file without following a final
symlink, verifies the opened inode against lstat, and delegates to `saveStream`.
It reads from that handle in 64 KiB chunks instead of reopening the source path.
This protects against path replacement but does not snapshot concurrent in-place
writes to the same inode; length changes are detected, same-length edits are not.

Streaming uses backpressure and hashes copied chunks of at most 64 KiB, then writes
those same chunks. The store never collects a whole resource in memory. Producers
should generate bounded chunks and not mutate yielded bytes while in flight. Both
declared and actual lengths are limited to 512 MiB; empty files are supported.

Bytes and metadata are staged, fsynced and closed before publication. A hard link
atomically publishes the digest object without overwriting an existing object,
including across concurrent processes. Existing objects are rehashed before reuse;
corrupt or writable objects are rejected. The complete reference is then atomically
renamed into place. Successful final rename is the commit point.

Caught failures remove staging. Once a digest object is published, rollback never
deletes it: another process may already be using it. An object left without a ref
is an orphan for future GC. Cleanup failures are reported explicitly. Abrupt process
termination can leave staging/orphans; directory-entry durability across power
failure is not guaranteed.

`getPath()` checks metadata, file size and that the named original is the same inode
as its digest object. `verify()` and strict `openFile()` additionally rehash bytes.
For v1 references without an expected digest, verify returns a computed digest with
`verified: false`; there is no historical hash to compare against. Strict verification
is performed before opening the returned stream and is not an adversarial filesystem
snapshot. Immutable storage remains a host responsibility.

Errors expose `ATTACHMENT_STORE_FAILED`, `ATTACHMENT_TOO_LARGE`,
`ATTACHMENT_CANCELLED`, or `ATTACHMENT_CORRUPTED`. Abort stops disk writes and destroys
Node input streams. Generic iterators receive `return()`; the store stops waiting if
`next()` cannot finish. Such producers must cooperate with cancellation to release
external resources. GC, HTTP transport and UI progress belong to later stages.

## Offline lifecycle / GC

`scanAttachmentReferences(sources)` reads all nested JSONL records and the runtime
SQLite `sessions`, `entries`, and `operations` JSON columns, including branches and
recovery state. Supply all live stores and any backups that must retain attachments.
Unrelated SQLite databases must not be supplied. Missing sources, malformed JSON,
unsupported database schemas and unsafe symlinks abort scanning.

`collectAttachmentGarbage()` supports v1 and v2 roots with a default seven-day grace
period. It validates all references before deletion, marks by attachment ID, removes
old unmarked refs, then removes old objects with no remaining hard links. Shared
objects and staging/external hard links are protected. Size statistics count object
bytes, not repeated reference sizes. `.pending-*` staging directories are retained;
automatic crash-staging recovery is not implemented in this stage.

Use the CLI with explicit roots and complete reference sources:

```bash
jojo attachments stats --root /data/attachments/v1 /data/attachments/v2 \
  --source /data/sessions /data/runtime/agent-runtime.sqlite
jojo attachments gc --root /data/attachments/v1 /data/attachments/v2 \
  --source /data/sessions /data/runtime/agent-runtime.sqlite --grace-days 7
# After stopping every process writing these stores:
jojo attachments gc --root /data/attachments/v1 /data/attachments/v2 \
  --source /data/sessions /data/runtime/agent-runtime.sqlite --apply --offline
```

Only include existing roots. Desktop normally uses `<dataDirectory>/sessions` and
`<dataDirectory>/runtime/agent-runtime.sqlite`; Serve uses `<dataDir>/runtime.sqlite`.
Custom profiles or backups may add more sources. The CLI deliberately does not
infer that one profile's sources cover the global attachment store.

Stats and GC are dry runs by default. `--offline` is an explicit caller guarantee,
not automatic process detection or a distributed lock. Applying GC while other
processes write sessions/attachments is unsupported. File identity is rechecked
before deletion, but this cannot replace stopping writers. If a filesystem deletion
fails during sweep, the operation fails and can be rerun; sweep is not transactional.
