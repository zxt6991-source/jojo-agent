# Attachment Access

Execution-specific attachment access, independent of provider serialization.

Hosts explicitly configure `attachmentAccess` on `createJojoRuntime` or the public
`RuntimeEnvironment`. Desktop and Server currently use:

```ts
import { LocalAttachmentAccessResolver } from '@desktop-agent/attachment-access/local';

const attachmentAccess = new LocalAttachmentAccessResolver(store);
```

The default package entry exports only the access contract and request projection
helper; it does not load the local store. Container or remote hosts can implement
`AttachmentAccessResolver` to return a path visible to their tools. Actual mounts,
copies, remote staging and access authorization remain the host's responsibility.
`readonly` describes the access supplied by the resolver; the local store provides
files without write permission bits. It is not an operating-system sandbox.

The runtime calls `resolveModelAttachments` before each model request, including
follow-up and resumed requests. Resolution is deduplicated by attachment ID within
that request, never cached across executions. The resolver receives session ID,
working directory, execution ID (when available), and the run cancellation signal.
Resolvers must observe cancellation during asynchronous projection work.

Only `ModelAttachmentDescriptor` is sent to the provider. Execution paths are never
written back to message history or attachment metadata. Serialization uses each
message block's own preview, preserving distinct previews of the same resource.

Missing resolvers and failed projections produce `unavailable` descriptors while
retaining previews. Stream-only access is represented as unavailable for the model
until a tool bridge exists; streams are not eagerly opened or buffered. No fallback
looks up a local host path. Local resolution trusts the stored metadata by attachment
ID, not a filename or path supplied in a message.

This stage supplies the local implementation and extension contract. It does not
implement container mounts, SSH staging, remote upload, or a stream-to-tool bridge.

## Docker read-only bind mounts

```ts
import { ContainerAttachmentAccessResolver } from '@desktop-agent/attachment-access/container';
const attachmentAccess = new ContainerAttachmentAccessResolver(store, { containerId: 'worker-1' });
// Pass attachmentAccess to createJojoRuntime for the runtime whose tools execute in worker-1.
```

The host must already have mounted the attachment store read-only in the container.
This resolver executes Docker CLI commands as argument arrays (no shell), inspects
running state and mounts, selects an actual read-only bind mapping, rejects mappings
shadowed by nested mounts, and runs `test -f`, `test -r`, and `sha256sum` inside the
container. It compares the latter to a freshly verified Store digest before returning
the execution path. Missing utilities, mismatched bytes or Docker failures return
unavailable. The returned name is taken from Store metadata, never from the message.

Default commands have a 15-second timeout, bounded output and AbortSignal. A custom
`command` adapter can use a host-managed Docker connection; it must preserve error,
argument and cancellation semantics. The target tools must use the same container
and execution user as these Docker exec probes. A container mounted read-only can
still observe host-side changes; hosts must preserve Store immutability while tools
execute. Verification is repeated per request and costs a local and container hash.

This does not create containers/mounts, copy files, or perform SSH staging. Tests use
an injected command adapter to exercise actual Store files and inspect/probe results.
A Docker installation is required for real container integration verification.
