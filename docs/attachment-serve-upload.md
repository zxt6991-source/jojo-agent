# Serve attachment upload

Upload to an existing session with:

```http
POST /api/v1/sessions/:sessionId/attachments?name=report.xlsx
Authorization: Bearer <server-token>
Content-Type: application/octet-stream

<raw bytes>
```

The endpoint follows the existing versioned/session-scoped server routes. Bodies
stream into the shared AttachmentStore with the 512 MiB cap; they are not encoded
as JSON/base64. A Content-Length, if present, is checked against actual bytes.
The server generates previews through the default registry. Preview failure leaves
the raw file usable and returns `previewWarning`.

The 201 response includes `attachment`, a random `receipt`, and `expiresAt`. Receipt
state is bound to principal, session and attachment ID. It lasts one hour in the
current server process; restart invalidates unsubmitted receipts. It may be reused
within that lifetime for submission retries. Existing run idempotency keys retain
their normal behavior. Raw uploaded resources remain on disk after receipt expiry
or cancellation after store commit and are subject to the GC grace period.

Use the receipt in StartRunInput alongside the file block:

```ts
const controller = new AbortController();
const upload = await client.uploadAttachment(session.id, file, file.name, {
  signal: controller.signal,
  onProgress: (loaded, total) => console.log(loaded, total)
});
await session.run({
  providerId: 'provider', model: 'model',
  input: { content: [{ type: 'file', attachment: upload.attachment }] },
  attachmentReceipts: { [upload.attachment.attachmentId]: upload.receipt }
});
```

Core validates both HTTP and WebSocket run starts, ignores client-provided names,
bytes and previews for uploaded files, and restores the server-owned ref. Direct
file references without matching receipts are rejected for new run input. Historical
transcript refs remain durable and need no new receipt for ordinary follow-up turns.
A control lease is still required to start a run. Upload requires runs:start access
and an existing session but does not acquire a control lease.

The SDK accepts Blob/File, sends raw bytes and supports AbortSignal. In a browser,
when onProgress is supplied, XMLHttpRequest reports network upload progress; a fetch
fallback reports completion only (Node or a custom fetch implementation). Upload
progress reaching 100% does not mean extraction/receipt creation has finished.
Connection abort cancels active store/extractor work. Four concurrent uploads and
1,000 live receipts per core limit in-memory request/receipt state.

Server composition passes a custom `server.attachmentStore`, if configured, to both
upload storage and the default LocalAttachmentAccessResolver. A caller that overrides
the resolver must keep it consistent with the chosen store. The current service uses
LocalAttachmentStore by default.

Limits: no standalone browser upload UI, cross-origin/CORS deployment changes,
resumable upload, durable receipts, remote execution staging, or worker-isolated
server extraction in this stage. XML/spreadsheet extraction has the same cooperative
cancellation limitation as the shared registry. Validate browser-specific progress
behavior in the consuming UI before shipping that UI; current transport integration
tests exercise real HTTP uploads via fetch and WebSocket receipt rejection.
