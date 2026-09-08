import React from 'react';
import type { ArtifactDescriptor } from '@desktop-agent/contracts';

/** A file entry only: previews are owned by the workspace's right pane. */
export function ArtifactCard({ artifact, onOpen }: { artifact: ArtifactDescriptor; onOpen?: (id: string) => void }) {
  return <button type="button" className="artifact-card" data-artifact-id={artifact.id}
    aria-label={`打开文档：${artifact.name}`} onClick={() => onOpen?.(artifact.id)}>
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M5 2.5h6l4 4v11H5z"/><path d="M11 2.5v4h4M7.5 10h5M7.5 13h5"/></svg>
    <span>{artifact.name}</span><span className="artifact-entry-arrow" aria-hidden="true">↗</span>
  </button>;
}
