import React, { useState } from 'react';

export function ArtifactResizeHandle({ chatWidth, onResize }: { chatWidth: number; onResize: (width: number) => void }) {
  const [dragging, setDragging] = useState(false);
  const resizeAt = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.closest('.workspace-content')?.getBoundingClientRect();
    if (!bounds?.width) return;
    const percentage = (event.clientX - bounds.left) / bounds.width * 100;
    onResize(percentage < 3 ? 0 : Math.min(80, Math.max(0, percentage)));
  };
  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  };
  return <>
    {dragging && <div className="artifact-resize-shield" />}
    <div className={`artifact-resize-handle ${dragging ? 'dragging' : ''}`} role="separator" tabIndex={0}
      aria-label="调整文档预览宽度" aria-orientation="vertical" aria-valuemin={20} aria-valuemax={100}
      aria-valuenow={Math.round(100 - chatWidth)} aria-valuetext={`文档占 ${Math.round(100 - chatWidth)}%`}
      title="拖动调整宽度；双击恢复分栏"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
      }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeAt(event); }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => setDragging(false)}
      onDoubleClick={() => onResize(44)}
      onKeyDown={(event) => {
        const next = event.key === 'ArrowLeft' ? Math.max(0, chatWidth - 5)
          : event.key === 'ArrowRight' ? Math.min(80, chatWidth + 5)
          : event.key === 'End' ? 0 : event.key === 'Home' ? 80 : undefined;
        if (next !== undefined) { event.preventDefault(); onResize(next); }
      }} />
  </>;
}
