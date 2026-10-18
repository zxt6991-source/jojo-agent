import React, { useEffect, useId, useRef, useState } from 'react';
import type { CaptureView } from './useSpeech';

type VoiceCapture = CaptureView & { start: () => Promise<void>; stop: () => void; cancel: () => void };
type CaptureInteraction = 'toggle' | 'hold';

export function VoiceCaptureButton({ capture, enabled, onSettings, disabled = false, interaction = 'toggle', iconOnly = true, idleLabel = '说话' }: {
  capture: VoiceCapture; enabled: boolean; onSettings: () => void; disabled?: boolean;
  interaction?: CaptureInteraction; iconOnly?: boolean; idleLabel?: string;
}) {
  const current = useRef(capture); current.current = capture;
  const holding = useRef(false);
  const active = capture.state === 'recording' || capture.state === 'connecting';
  const recognizing = capture.state === 'recognizing';
  const unavailable = disabled || recognizing;
  const label = active ? '停止录音' : enabled ? '开始录音' : '设置语音';
  const beginHold = () => {
    if (!enabled || unavailable || interaction !== 'hold' || active || holding.current) return;
    holding.current = true;
    void capture.start();
  };
  const endHold = (cancel = false) => {
    if (!holding.current) return;
    holding.current = false;
    // Releasing while the service is connecting must also stop the pending capture.
    if (current.current.state === 'recording') {
      if (cancel) current.current.cancel(); else current.current.stop();
    } else if (current.current.state === 'connecting' || current.current.state === 'idle') current.current.cancel();
  };
  useEffect(() => () => { if (holding.current) current.current.cancel(); }, []);
  return <button type="button"
    className={`voice-mic${iconOnly ? ' voice-mic-icon' : ''}${capture.state === 'recording' ? ' is-recording' : ''}${capture.state === 'connecting' ? ' is-connecting' : ''}${recognizing ? ' is-recognizing' : ''}`}
    aria-label={recognizing ? '正在转写' : label} aria-pressed={active} aria-busy={capture.state === 'connecting' || recognizing}
    title={recognizing ? '正在转写…' : active ? '停止录音' : !enabled ? '设置语音' : interaction === 'hold' ? '按住说话，松开结束' : '开始录音'}
    disabled={unavailable}
    onClick={() => { if (!enabled) onSettings(); else if (interaction === 'toggle') { if (active) capture.stop(); else void capture.start(); } }}
    onPointerDown={event => {
      if (event.button !== 0 || !enabled || unavailable || interaction !== 'hold' || active) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      beginHold();
    }}
    onPointerUp={() => endHold()} onPointerCancel={() => endHold(true)} onLostPointerCapture={() => endHold(true)}
    onKeyDown={event => {
      if (event.key === 'Escape' && active) { event.preventDefault(); holding.current = false; capture.cancel(); }
      else if (enabled && interaction === 'hold' && !event.repeat && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault(); beginHold();
      }
    }}
    onKeyUp={event => { if (interaction === 'hold' && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); endHold(); } }}
    onBlur={() => endHold(true)}
  ><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8" /></svg>
    {!iconOnly && <span>{capture.state === 'connecting' ? '连接中…' : capture.state === 'recording' ? '停止' : recognizing ? '转写中…' : idleLabel}</span>}
  </button>;
}

/** Keep continuous-mode discovery in the toolbar until explicitly started. */
export function VoiceInputOptions({ disabled, canStartConversation, onStartConversation, onSettings }: {
  disabled: boolean; canStartConversation: boolean; onStartConversation(): void; onSettings(): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    if (disabled) { setOpen(false); return; }
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, disabled]);
  const choose = (action: () => void) => { setOpen(false); trigger.current?.focus(); action(); };
  return <div className="voice-input-options" ref={root}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      if (!open) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
        return;
      }
      event.preventDefault();
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    }}>
    <button type="button" className="voice-options-toggle" ref={trigger} aria-label="语音选项" title="语音选项" aria-haspopup="menu" aria-expanded={open && !disabled} aria-controls={id} disabled={disabled} onClick={() => setOpen(value => !value)}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {open && !disabled && <div className="voice-options-menu" ref={menu} id={id} role="menu" aria-label="语音选项">
      <button type="button" role="menuitem" tabIndex={-1} disabled={!canStartConversation} onClick={() => choose(onStartConversation)}>开始连续对话</button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => choose(onSettings)}>语音设置</button>
    </div>}
  </div>;
}

export function VoiceCaptureStatus({ capture }: { capture: VoiceCapture }) {
  const busy = capture.state === 'recording' || capture.state === 'connecting' || capture.state === 'recognizing';
  return <>
    {busy && <div className="voice-recording-status" role="status" aria-live="polite">
      <div className="voice-waveform" aria-hidden="true">{Array.from({ length: 15 }, (_, index) => <i key={index} style={{ height: `${4 + Math.min(32, capture.rms * 160 * (0.45 + Math.sin(index * 1.7) ** 2))}px` }} />)}</div>
      <span>{capture.state === 'connecting' ? '正在连接语音服务，尚未录音' : capture.state === 'recognizing' ? '正在识别最终文字…' : '可以说话'} · {Math.floor(capture.durationMs / 1000)} / 60 秒</span>
      {capture.state === 'recording' && <button type="button" onClick={capture.stop}>结束录音</button>}
      <button type="button" className="voice-cancel" onClick={capture.cancel}>取消</button>
    </div>}
    {capture.state === 'recording' && capture.text && <div className="speech-test-transcript" role="status" aria-live="polite"><span>实时转写 · {capture.text}</span></div>}
    {capture.error && <div className="voice-error" role="alert">{capture.error}</div>}
  </>;
}

export function VoiceComposer({ capture, enabled, inputMode, onInputMode, onSettings, disabled = false, showInputMode = true, idleLabel, children }: {
  capture: VoiceCapture;
  enabled: boolean; inputMode: 'review' | 'auto_send'; onInputMode: (mode: 'review' | 'auto_send') => void;
  onSettings: () => void; disabled?: boolean; showInputMode?: boolean; idleLabel?: string; children?: React.ReactNode;
}) {
  const [interaction, setInteraction] = useState<CaptureInteraction>('toggle');
  const busy = capture.state === 'recording' || capture.state === 'connecting' || capture.state === 'recognizing';
  return <div className={`voice-composer ${busy ? 'voice-active' : ''}`}>
    <div className="voice-controls">
      <VoiceCaptureButton capture={capture} enabled={enabled} onSettings={onSettings} disabled={disabled} interaction={interaction} iconOnly={false} {...(idleLabel ? { idleLabel } : {})} />
      {enabled && <><select aria-label="录音操作方式" value={interaction} disabled={busy || disabled} onChange={event => setInteraction(event.target.value as CaptureInteraction)}><option value="toggle">点击开始 / 停止</option><option value="hold">按住说话</option></select>
        {showInputMode && <select aria-label="语音提交方式" value={inputMode} disabled={busy || disabled} onChange={event => onInputMode(event.target.value as typeof inputMode)}><option value="review">转写后校正</option><option value="auto_send">转写后自动发送</option></select>}</>}
      {children}
    </div>
    <VoiceCaptureStatus capture={capture} />
  </div>;
}
