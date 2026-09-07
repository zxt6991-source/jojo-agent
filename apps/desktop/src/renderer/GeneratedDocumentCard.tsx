import React from 'react';
import type { GeneratedDocument } from '@desktop-agent/contracts';
import { ArtifactCard } from './artifacts/ArtifactCard';
/** Compatibility entry point; all rendering now uses the artifact registry. */
export function GeneratedDocumentCard({ document }: { document: GeneratedDocument }) {
  return <ArtifactCard artifact={{ id: document.name, name: document.name, kind: 'html', mimeType: 'text/html',
    source: 'create_document', storage: { type: 'conversation', content: document.content }, version: 1 }} />;
}
