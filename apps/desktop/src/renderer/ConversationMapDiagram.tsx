import React, { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';

let renderer: Promise<typeof import('mermaid')['default']> | undefined;
let diagramSequence = 0;
function loadRenderer() {
  renderer ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, maxTextSize: 100_000, theme: 'neutral', htmlLabels: false, flowchart: { htmlLabels: false, useMaxWidth: true } });
    return mermaid;
  });
  return renderer;
}

/** Only deterministic JSON-derived diagrams enter here; SVG is sanitized again before insertion. */
export function ConversationMapDiagram({ code, label, testId }: { code: string; label: string; testId: string }) {
  const [output, setOutput] = useState<{ code: string; svg: string }>();
  const [failedCode, setFailedCode] = useState<string>();
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    const id = `conversation-map-diagram-${++diagramSequence}`;
    // Mermaid's temporary render surface stays local and is removed when this effect is disposed.
    const surface = document.createElement('div');
    container.current?.append(surface);
    void loadRenderer().then(async (mermaid) => {
      if (cancelled) return;
      const { svg } = await mermaid.render(id, code, surface);
      if (cancelled) return;
      const sanitized = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'image', 'a'], FORBID_ATTR: ['href', 'xlink:href'] });
      setOutput({ code, svg: sanitized });
    }).catch(() => { if (!cancelled) setFailedCode(code); }).finally(() => surface.remove());
    return () => { cancelled = true; surface.remove(); };
  }, [code]);
  return <div className="conversation-map-diagram" data-testid={testId}>
    <div ref={container} className="conversation-map-render-surface" aria-hidden="true" />
    {output?.code === code ? <div role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: output.svg }} />
      : <p role="status">{failedCode === code ? '图形暂时无法显示，请使用下方完整列表。' : '正在绘制图形…'}</p>}
  </div>;
}
