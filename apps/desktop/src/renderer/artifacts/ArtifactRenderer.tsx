import React from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { artifactRenderer, type ArtifactDescriptor } from '@desktop-agent/contracts';

export function safeArtifactHtml(content: string): string {
  const html = DOMPurify.sanitize(content, { WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form'] });
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'">${html}`;
}
type Props = { artifact: ArtifactDescriptor; text: string; imageUrl: string };
const renderers: Record<string, React.ComponentType<Props>> = {
  html: ({ artifact, text }) => <iframe title={`预览 ${artifact.name}`} sandbox="" referrerPolicy="no-referrer" srcDoc={safeArtifactHtml(text)} />,
  markdown: ({ artifact, text }) => <iframe title={`预览 ${artifact.name}`} sandbox="" referrerPolicy="no-referrer" srcDoc={safeArtifactHtml(marked.parse(text, { async: false }) as string)} />,
  image: ({ artifact, imageUrl }) => <img className="artifact-image" src={imageUrl} alt={artifact.name} />,
  text: ({ text }) => <pre className="artifact-text">{text}</pre>,
  'download-only': ({ artifact }) => <p>{artifact.mimeType} · 可下载原始文件后打开。</p>
};
export function ArtifactRenderer(props: Props) {
  const Renderer = renderers[artifactRenderer(props.artifact)]!;
  return <Renderer {...props} />;
}
