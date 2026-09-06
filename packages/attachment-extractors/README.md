# Attachment Extractors

Node-only preview extraction, independent of Desktop and AttachmentStore. The host
supplies metadata and a fresh byte stream; raw attachment persistence remains the
host's responsibility.

```ts
const registry = createDefaultAttachmentExtractorRegistry();
registry.register(customExtractor); // Higher priority wins; ties use registration order.
const preview = await registry.extract({
  metadata: ref,
  openStream: () => store.openFile(ref.attachmentId),
  getPath: () => store.getPath(ref.attachmentId),
  signal
});
```

Built-ins: `text`, `html`, `pdf`, `spreadsheet`. Extension matching is case-insensitive
and falls back to the filename. Unknown formats, empty previews and resources over
20 MiB return `undefined`. Built-in readers enforce the actual stream byte limit,
and registry output is capped at 50,000 characters. Desktop additionally enforces
the per-message preview budget.

Failures reject with `AttachmentExtractionError` and a stable `code`:
`ATTACHMENT_EXTRACT_FAILED`, `ATTACHMENT_EXTRACT_TIMEOUT`, or `ATTACHMENT_CANCELLED`.
The host must catch these independently of storage failure and retain the stored
attachment. The registry does not mutate metadata or write resource files.

The default timeout is 30 seconds and can be configured via the factory or registry
constructor. Cancellation closes built-in input streams and destroys PDF loading
tasks. Plugins must observe the supplied signal and release their own resources.
The timeout is cooperative: synchronous third-party parser work cannot be forcibly
interrupted on the same event loop. Desktop retains its existing outer worker
termination limit; strict per-extractor CPU isolation is a future enhancement.

`pdfjs-dist` stays external in Electron bundles, so Desktop retains it as a runtime
dependency for its worker, font, CMap and WASM assets. Other parser dependencies
belong to this package; Desktop uses `xlsx` only to create test fixtures.

## DOCX / PPTX text previews

The default registry now includes `docx` and `pptx`. Both use a shared, bounded
OOXML ZIP reader (`yauzl`) and XML parser (`@xmldom/xmldom` 0.9.12 or newer).
This implements the roadmap's text-only scope directly, without Mammoth or Office
rendering dependencies. DOCX extracts paragraphs, headings/list text and table-cell
text in document order. Formatting, list numbering, headers/footers, notes and
embedded media are omitted. PPTX resolves slide order through `presentation.xml`
and its relationships, preserving slide labels and paragraph text. Notes, charts,
images/OCR, animations and layout are not rendered; reading order within each slide
follows XML order, not visual coordinates.

Only selected XML parts are inflated in memory; nothing is extracted to disk and
external relationships are not fetched. Limits: 5,000 ZIP entries, 4 MiB per XML
part, 16 MiB selected XML total, 128 XML nesting levels, 200,000 traversed XML nodes,
and 200 slides. The existing 20 MiB compressed input and 50,000-character output
limits still apply. Slide/output limits produce truncated previews; archive/XML
limits reject the preview and leave the stored attachment available. DTD/entity
declarations, duplicate archive entries and external slide relationships are rejected.
Encrypted Office files do not receive previews. XML parsing remains synchronous
and uses the registry's cooperative cancellation plus Desktop's worker boundary.

## Archive manifests

`archive-manifest` supports ZIP and basic uncompressed TAR/USTAR. Previews list names,
entry types and declared uncompressed byte sizes in archive order. Paths retain their
directory structure; control characters are escaped. No members are written to disk
or added to model context. ZIP payloads are never inflated: only central-directory
metadata is read, so this preview does not validate member CRCs or contents.

Limits remain 20 MiB input, 50,000 output characters and 1,000 listed entries.
Reaching the entry/text limit produces a truncated manifest, not a claim that the
remaining archive was validated. Malformed/traversal paths and broken TAR headers or
padding bounds reject the preview while preserving the raw resource. TAR checks
header checksums and skips member byte ranges. Links are listed but never followed.

PAX/GNU extension records, sparse TAR, compressed TAR (.tar.gz/.tgz/.xz), RAR and 7z
are not supported by this first implementation. Encrypted ZIP members can be listed
from unencrypted directory metadata; their contents are not decrypted or inspected.

### SQLite schema previews

The default registry supports `.sqlite`, `.sqlite3`, and `.db` files with a SQLite 3 header. It copies the bounded input into a private temporary directory and opens that copy read-only in a terminable worker (5 second deadline). The worker lists at most 100 tables and 200 columns per table, with the shared 50,000 character output limit. It disables extension loading and trusted schema, skips views and virtual-table column evaluation, and never queries application rows or runs `COUNT(*)`.

Row estimates use existing sqlite_stat1 statistics (at most 1,001 entries), which may be stale or incomplete; tables without usable statistics show unknown. No ANALYZE is run. Provide a standalone SQLite snapshot: external WAL/journal sidecars are not imported. Encrypted databases are unsupported. Temporary files are removed after worker termination on success, error, cancellation, or timeout.
