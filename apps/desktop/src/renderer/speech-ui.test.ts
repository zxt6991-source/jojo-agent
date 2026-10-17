import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopApi } from '@desktop-agent/contracts';
import { VoiceComposer } from './VoiceComposer';
import { SpeechActivationPanel, SpeechDiagnosticsSummary, SpeechSettingsPage, SpeechVoicePresetEditor, speechPresetTrialLabel } from './SpeechSettings';
import { activeSpeechPlayback, getSpeechContinuation } from './useSpeech';
import { ChatTranscript } from './ConversationViews';
import { buildConversationSnapshot } from './conversation';
vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

const capture = { state: 'idle' as const, durationMs: 0, rms: 0, error: '', start: async () => undefined, stop: () => undefined, cancel: () => undefined };

describe('speech product UI', () => {
  it('defaults to review and exposes explicit click or hold controls', () => {
    const html = renderToStaticMarkup(React.createElement(VoiceComposer, { capture, enabled: true, inputMode: 'review', onInputMode: () => undefined, onSettings: () => undefined }));
    expect(html).toContain('转写后校正'); expect(html).toContain('按住说话');
    expect(html).toContain('value="review" selected=""');
    expect(html).not.toContain('取消');
  });
  it('shows provider connection before recording, timing, stop and errors', () => {
    const connecting = renderToStaticMarkup(React.createElement(VoiceComposer, { capture: { ...capture, state: 'connecting' }, enabled: true, inputMode: 'review', onInputMode: () => undefined, onSettings: () => undefined }));
    expect(connecting).toContain('尚未录音');
    const recording = renderToStaticMarkup(React.createElement(VoiceComposer, { capture: { ...capture, state: 'recording', durationMs: 12_500, rms: 0.2 }, enabled: true, inputMode: 'review', onInputMode: () => undefined, onSettings: () => undefined }));
    expect(recording).toContain('12 / 60 秒'); expect(recording).toContain('结束录音'); expect(recording).toContain('取消');
    const failed = renderToStaticMarkup(React.createElement(VoiceComposer, { capture: { ...capture, error: '权限拒绝，请重录。' }, enabled: true, inputMode: 'review', onInputMode: () => undefined, onSettings: () => undefined }));
    expect(failed).toContain('role="alert"'); expect(failed).toContain('权限拒绝');
  });
  it('holds editable controls until the saved settings snapshot arrives', () => {
    const html = renderToStaticMarkup(React.createElement(SpeechSettingsPage, { api: {} as DesktopApi, onSaved: () => undefined }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('正在读取语音设置');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('保存语音设置');
  });
  it('explains why the composer opens settings and offers activation after both saved tests pass', () => {
    const props = { enabled: false, dirty: false, asrVerified: false, ttsVerified: false, busy: false, onEnable: () => undefined };
    const render = (patch: Partial<typeof props> = {}) => renderToStaticMarkup(React.createElement(SpeechActivationPanel, { ...props, ...patch }));
    expect(render()).toContain('语音尚未启用');
    expect(render()).toContain('待完成：转写测试、试听测试');
    expect(render()).toMatch(/<button[^>]+disabled=""[^>]*>启用语音并保存/u);
    expect(render({ asrVerified: true })).toContain('待完成：试听测试');
    expect(render({ ttsVerified: true })).toContain('待完成：转写测试');
    const ready = { asrVerified: true, ttsVerified: true };
    expect(render(ready)).toContain('转写和试听均已通过');
    expect(render(ready)).not.toMatch(/<button[^>]+disabled=""/u);
    expect(render({ ...ready, dirty: true })).toContain('请先保存当前修改');
    expect(render({ ...ready, dirty: true })).toMatch(/<button[^>]+disabled=""/u);
    expect(render({ ...ready, busy: true })).toMatch(/<button[^>]+disabled=""/u);
    expect(render({ enabled: true })).toBe('');
  });
  it('requires saved configuration before testing an independent voice preset', () => {
    const props = { preset: { id: 'work', name: '工作提醒', speakerId: 'Tingting', speechRate: 0 }, index: 0, dirty: true, busy: false, trialLabel: '本次试听已完成', onChange: () => undefined, onRemove: () => undefined, onTest: () => undefined };
    const dirty = renderToStaticMarkup(React.createElement(SpeechVoicePresetEditor, props));
    expect(dirty).toContain('先保存语音设置，再试听此预设');
    expect(dirty).toMatch(/<button[^>]+disabled=""[^>]*>试听此预设/u);
    expect(dirty).not.toContain('本次试听已完成');
    const saved = renderToStaticMarkup(React.createElement(SpeechVoicePresetEditor, { ...props, dirty: false, trialLabel: '尚未试听此预设' }));
    expect(saved).toContain('尚未试听此预设');
    expect(saved).not.toMatch(/<button[^>]+disabled=""[^>]*>试听此预设/u);
  });
  it('does not treat a queued, suppressed or stale preset trial as verified playback', () => {
    const trial = { signature: 'saved-v1', playbackId: 'preview-1' };
    expect(speechPresetTrialLabel(trial, 'saved-v1', [])).toBe('正在准备试听…');
    expect(speechPresetTrialLabel(trial, 'saved-v1', [{ playbackId: 'preview-1', generation: 1, state: 'suppressed' }])).toContain('尚未验证声音');
    expect(speechPresetTrialLabel(trial, 'saved-v1', [{ playbackId: 'preview-1', generation: 1, state: 'played' }])).toBe('本次试听已完成');
    expect(speechPresetTrialLabel(trial, 'saved-v2', [{ playbackId: 'preview-1', generation: 1, state: 'played' }])).toContain('尚未试听');
    expect(speechPresetTrialLabel({ signature: 'saved-v1', error: 'speaker_unavailable' }, 'saved-v1', [])).toContain('试听失败');
  });
  it('describes installed system voices and allows saved preset listening', () => {
    const html = renderToStaticMarkup(React.createElement(SpeechVoicePresetEditor, {
      preset: { id: 'local', name: '本地提醒', speakerId: 'default', speechRate: 0 }, index: 0,
      dirty: false, busy: false, trialLabel: '尚未验证',
      onChange: () => undefined, onRemove: () => undefined, onTest: () => undefined
    }));
    expect(html).toContain('系统声音名称');
    expect(html).not.toMatch(/<button[^>]+disabled=""[^>]*>试听此预设/u);
  });
  it('distinguishes unavailable diagnostics from zero use and explains request timing limits', () => {
    const empty = renderToStaticMarkup(React.createElement(SpeechDiagnosticsSummary, { diagnostics: undefined, refreshing: false, onRefresh: () => undefined }));
    expect(empty).toContain('统计暂不可用');
    expect(empty).not.toContain('语音识别请求');
    const timing = { requests: 0, completed: 0, failed: 0, cancelled: 0, meanMs: 0, p95Ms: 0, samples: 0 };
    const available = renderToStaticMarkup(React.createElement(SpeechDiagnosticsSummary, { diagnostics: { startedAt: '2026-10-15T00:00:00.000Z', asr: { ...timing, audioMs: 0 }, tts: { ...timing, requestedChars: 0, audioBytes: 0, cacheHits: 0 } }, refreshing: false, onRefresh: () => undefined }));
    expect(available).toContain('0 次');
    expect(available).toContain('尚无请求耗时样本');
    expect(available).toContain('耗时包含录音与本地处理时间');
    expect(available).toContain('不代表首音播放延迟');
    expect(available).not.toContain('计费');
  });
  it('only exposes read aloud for completed assistant messages, never live drafts or tools', () => {
    const messages = [{ id: 'assistant-done', role: 'assistant' as const, createdAt: '2026-01-01T00:00:00.000Z', content: [{ type: 'text' as const, text: '已完成的回复。' }] }];
    const snapshot = buildConversationSnapshot({ messages, compactions: [], liveSteps: [{ text: '还在生成。', tools: [] }], running: true });
    const html = renderToStaticMarkup(React.createElement(ChatTranscript, { snapshot, running: true, turnStartedAt: null, onReadMessage: () => undefined }));
    expect((html.match(/aria-label="朗读助手回复"/gu) ?? []).length).toBe(1);
  });
  it('scopes active playback to its owning session and excludes terminal states', () => {
    const playbacks = [{ playbackId: 'a', generation: 1, sessionId: 's1', state: 'playing' as const }, { playbackId: 'b', generation: 2, sessionId: 's2', state: 'playing' as const }, { playbackId: 'c', generation: 3, sessionId: 's1', state: 'played' as const }];
    expect(activeSpeechPlayback(playbacks, 's1')?.playbackId).toBe('a');
    expect(activeSpeechPlayback(playbacks, 'missing')).toBeUndefined();
  });
  it('offers the next segment only after the latest segment of that message actually played', () => {
    const played = { playbackId: 'one', generation: 1, sessionId: 's', messageId: 'm', state: 'played' as const, nextOffset: 600 };
    expect(getSpeechContinuation([played], 's', 'm')).toBe(600);
    expect(getSpeechContinuation([played], 'other', 'm')).toBeUndefined();
    expect(getSpeechContinuation([played, { ...played, playbackId: 'two', state: 'interrupted' }], 's', 'm')).toBeUndefined();
    expect(getSpeechContinuation([played, { ...played, playbackId: 'two', state: 'playing', nextOffset: 1200 }], 's', 'm')).toBeUndefined();
    expect(getSpeechContinuation([played, { playbackId: 'two', generation: 2, sessionId: 's', messageId: 'm', state: 'played' }], 's', 'm')).toBeUndefined();
  });
  it('shows continuation beside completed assistant text while retaining the explicit restart action', () => {
    const snapshot = buildConversationSnapshot({ messages: [{ id: 'm', role: 'assistant', createdAt: '2026-01-01T00:00:00.000Z', content: [{ type: 'text', text: '完整长回复。' }] }], compactions: [], liveSteps: [], running: false });
    const html = renderToStaticMarkup(React.createElement(ChatTranscript, { snapshot, running: false, turnStartedAt: null,
      onReadMessage: () => undefined, onContinueMessage: () => undefined, speechContinuation: id => id === 'm' ? 600 : undefined }));
    expect(html).toContain('aria-label="继续朗读助手回复"'); expect(html).toContain('aria-label="朗读助手回复"');
  });
});
