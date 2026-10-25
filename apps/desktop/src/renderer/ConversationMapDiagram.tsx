import React, { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import './ConversationMapDiagram.css';

let renderer: Promise<typeof import('mermaid')['default']> | undefined;
let diagramSequence = 0;
function loadRenderer() {
  renderer ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, maxTextSize: 100_000, theme: 'neutral', htmlLabels: false, flowchart: { htmlLabels: false, useMaxWidth: true, wrappingWidth: 320 } });
    return mermaid;
  });
  return renderer;
}

type DiagramOutput = { code: string; svg: string; width: number; height: number };
type ViewportSize = { width: number; height: number };
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;

function diagramOutput(code: string, svg: string): DiagramOutput {
  const sanitized = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'image', 'a'], FORBID_ATTR: ['href', 'xlink:href'] });
  const parsed = new DOMParser().parseFromString(sanitized, 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.localName !== 'svg') throw new Error('Invalid diagram');
  const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/u).map(Number);
  const dimension = (index: number, name: string, fallback: number): number => {
    const value = box?.[index] ?? Number(root.getAttribute(name));
    return value && Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return { code, svg: sanitized, width: dimension(2, 'width', 800), height: dimension(3, 'height', 400) };
}

function useViewportSize(ref: React.RefObject<HTMLDivElement | null>): ViewportSize {
  const [size, setSize] = useState<ViewportSize>({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** Only deterministic JSON-derived diagrams enter here; SVG is sanitized again before insertion. */
export function ConversationMapDiagram({ code, label, testId, expandable = false, title = '关键历程' }: {
  code: string; label: string; testId: string; expandable?: boolean; title?: string;
}) {
  const [output, setOutput] = useState<DiagramOutput>();
  const [failedCode, setFailedCode] = useState<string>();
  const [expandedCode, setExpandedCode] = useState<string>();
  const [zoom, setZoom] = useState<'fit' | number>(1);
  const container = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const previewSize = useViewportSize(preview);
  const viewportSize = useViewportSize(viewport);
  const current = output?.code === code ? output : undefined;
  // Resize/zoom should update the wrapper, not replace the entire SVG subtree.
  const svgMarkup = useMemo(() => ({ __html: current?.svg ?? '' }), [current?.svg]);
  const expanded = Boolean(expandable && current && expandedCode === code);
  const previewScale = current && previewSize.width ? Math.min(1, previewSize.width / current.width) : 1;
  const fittedScale = current && viewportSize.width && viewportSize.height
    ? Math.max(MIN_ZOOM, Math.min(1, (viewportSize.width - 48) / current.width, (viewportSize.height - 48) / current.height)) : 1;
  const scale = zoom === 'fit' ? fittedScale : zoom;

  function openReader(trigger: HTMLElement) {
    if (!current) return;
    returnFocus.current = trigger;
    // Open at a readable font size; fitting a long timeline can make every label tiny.
    setZoom(1);
    setExpandedCode(code);
  }

  useEffect(() => {
    if (!expanded) return;
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    viewport.current?.scrollTo(0, 0);
    return () => {
      element.close();
      const target = returnFocus.current?.isConnected ? returnFocus.current : openButton.current;
      target?.focus({ preventScroll: true });
    };
  }, [expanded]);

  useEffect(() => { setExpandedCode(undefined); }, [code]);
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
      setOutput(diagramOutput(code, svg));
    }).catch(() => { if (!cancelled) setFailedCode(code); }).finally(() => surface.remove());
    return () => { cancelled = true; surface.remove(); };
  }, [code]);
  const previewDiagram = current && !expanded ? <div className="conversation-map-svg" role="img" aria-label={label}
    style={{ width: current.width * previewScale, height: current.height * previewScale }} dangerouslySetInnerHTML={svgMarkup} /> : undefined;

  return <div className={`conversation-map-diagram${expandable ? ' conversation-map-diagram-expandable' : ''}`} data-testid={testId}>
    <div ref={container} className="conversation-map-render-surface" aria-hidden="true" />
    {expandable && <div className="conversation-map-diagram-toolbar"><span>点击图形放大阅读</span><button ref={openButton} type="button" disabled={!current} onClick={event => openReader(event.currentTarget)}>全屏阅读</button></div>}
    <div ref={preview} className="conversation-map-diagram-preview">
      {current ? expandable ? <button type="button" className="conversation-map-diagram-open" aria-label={`${title}，全屏阅读`} onClick={event => openReader(event.currentTarget)}>
        {previewDiagram ?? <span className="conversation-map-reader-placeholder">正在全屏阅读</span>}
      </button> : previewDiagram : <p role="status">{failedCode === code ? '图形暂时无法显示，请使用下方完整列表。' : '正在绘制图形…'}</p>}
    </div>
    <dialog ref={dialog} className="conversation-map-reader" aria-label={title} onCancel={event => { event.preventDefault(); setExpandedCode(undefined); }}>
      <header className="conversation-map-reader-header"><div><h2>{title}</h2><p>滚动阅读完整历程 · Esc 退出</p></div><button type="button" autoFocus aria-label="关闭全屏阅读" onClick={() => setExpandedCode(undefined)}>关闭</button></header>
      <div className="conversation-map-reader-controls" role="group" aria-label="图形缩放">
        <button type="button" aria-label="缩小" disabled={scale <= MIN_ZOOM} onClick={() => setZoom(Math.max(MIN_ZOOM, Math.round((scale - 0.1) * 100) / 100))}>−</button>
        <output aria-live="polite" aria-label="缩放比例">{Math.round(scale * 100)}%</output>
        <button type="button" aria-label="放大" disabled={scale >= MAX_ZOOM} onClick={() => setZoom(Math.min(MAX_ZOOM, Math.round((scale + 0.1) * 100) / 100))}>＋</button>
        <button type="button" aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}>适合窗口</button>
        <button type="button" aria-pressed={zoom === 1} onClick={() => setZoom(1)}>原始大小</button>
      </div>
      <div ref={viewport} className="conversation-map-reader-viewport" tabIndex={0} aria-label="历程图阅读区">
        {expanded && current && <div className="conversation-map-reader-stage" style={{ width: Math.max(viewportSize.width, current.width * scale + 48), height: Math.max(viewportSize.height, current.height * scale + 48) }}>
          <div className="conversation-map-svg" role="img" aria-label={label} style={{ width: current.width * scale, height: current.height * scale }} dangerouslySetInnerHTML={svgMarkup} />
        </div>}
      </div>
    </dialog>
  </div>;
}
