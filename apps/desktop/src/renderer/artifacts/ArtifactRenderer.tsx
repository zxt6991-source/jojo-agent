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
  markdown: ({ artifact, text }) => <iframe title={`预览 ${artifact.name}`} sandbox="" referrerPolicy="no-referrer" srcDoc={safeArtifactHtml(`<style>body{margin:0;padding:28px;font:14px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#30343b;overflow-wrap:anywhere}h1,h2,h3{line-height:1.4;color:#17191d}h1{font-size:24px}h2{font-size:20px;margin-top:1.6em}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{padding:9px 12px;border-bottom:1px solid #e5e7eb;text-align:left}th{background:#f7f8fa}pre{padding:16px;background:#f7f8fa;overflow:auto;border-radius:8px}code{font-size:0.9em}blockquote{margin-left:0;padding-left:16px;border-left:3px solid #e5e7eb;color:#6b7280}img{max-width:100%}a{color:#476a9e}</style>${marked.parse(text, { async: false })}`)} />,
  image: ({ artifact, imageUrl }) => <img className="artifact-image" src={imageUrl} alt={artifact.name} />,
  text: ({ text }) => <pre className="artifact-text">{text}</pre>,
  'download-only': ({ artifact }) => <p>{artifact.mimeType} · 可下载原始文件后打开。</p>
};
export function ArtifactRenderer(props: Props) {
  const Renderer = renderers[artifactRenderer(props.artifact)]!;
  return <Renderer {...props} />;
}
