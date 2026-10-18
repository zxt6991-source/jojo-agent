import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SpeechProviderError, SpeechSettingsSchema, createLocalSpeechSettings, type Message, type SpeechProvider, type SpeechEvent } from '@desktop-agent/contracts';
import { SqliteVoiceCommitLedger } from '@desktop-agent/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopSpeechRuntime } from './speech-runtime.js';
import { DesktopVoiceTasks, VoiceRunBusyError, type DesktopVoiceTasksOptions, type VoiceCaptureHandle } from './voice-tasks.js';

class Port extends EventEmitter {
  sent: unknown[] = []; closed = false;
  postMessage(value: unknown) { this.sent.push(value); }
  close() { this.closed = true; this.emit('close'); }
  send(value: unknown) { this.emit('message', { data: value }); }
}
const handle: VoiceCaptureHandle = { captureId: 'capture-a', voiceTurnId: 'turn-a', generation: 1, sessionId: 'session-a', purpose: 'conversation' };
const request = { voiceTurnId: 'turn-a', generation: 1, sessionId: 'session-a', text: '校正后的句子', providerId: 'offline', model: 'offline-model' };
const directories: string[] = []; const cleanup: (() => void)[] = [];
afterEach(() => { for (const action of cleanup.splice(0)) action(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });
function offlineProvider(text = '保留下来的原句'): SpeechProvider {
  return {
    asr: { recognize: vi.fn(async function* (input: Parameters<SpeechProvider['asr']['recognize']>[0]): ReturnType<SpeechProvider['asr']['recognize']> {
      yield { type: 'ready', requestId: input.requestId };
      for await (const audio of input.audio) { expect(audio.byteLength).toBeGreaterThan(0); }
      yield { type: 'final', requestId: input.requestId, text, durationMs: 200 };
    }) },
    tts: { synthesize: vi.fn(async function* (input: Parameters<SpeechProvider['tts']['synthesize']>[0]): ReturnType<SpeechProvider['tts']['synthesize']> {
      yield { type: 'audio', requestId: input.requestId, bytes: Uint8Array.of(1,2), format: 'wav', sampleRate: 24000 };
      yield { type: 'completed', requestId: input.requestId };
    }) }
  };
}
async function harness(options: Partial<DesktopVoiceTasksOptions> = {}, provider = offlineProvider(), enabled = true) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'voice-tasks-')); directories.push(directory);
  const runtime = new DesktopSpeechRuntime(directory, { createProvider: () => provider });
  await runtime.configure(SpeechSettingsSchema.parse({ enabled }));
  const events: SpeechEvent[] = []; const waiters = new Map<string, (event: SpeechEvent) => void>();
  const defaults: DesktopVoiceTasksOptions = {
    emit: event => { events.push(event); if (event.type === 'capture') waiters.get(event.state)?.(event); },
    readCommittedMessages: vi.fn(async () => []), isBusy: vi.fn(() => false),
    submit: vi.fn(async (_input, runId) => ({ runId })), inspectRun: vi.fn(async () => 'missing' as const)
  };
  const callbacks = { ...defaults, ...options }; const tasks = new DesktopVoiceTasks(runtime, directory, callbacks);
  cleanup.push(() => { tasks.dispose(); runtime.close(); });
  const wait = (state: string): Promise<SpeechEvent> => {
    const event = events.find(item => item.type === 'capture' && item.state === state);
    if (event) return Promise.resolve(event);
    return new Promise(resolve => { waiters.set(state, resolve); });
  };
  return { directory, runtime, tasks, events, callbacks, provider, wait };
}
async function capture(h: Awaited<ReturnType<typeof harness>>, value = handle) {
  const port = new Port(); h.tasks.attachCapture(value, port); await h.wait('ready');
  port.send({ type: 'audio', captureId: value.captureId, generation: value.generation, sequence: 1, bytes: new Uint8Array(6400) });
  port.send({ type: 'end', captureId: value.captureId, generation: value.generation, lastSequence: 1 });
  await h.wait('review'); return port;
}
function message(role: Message['role'] = 'assistant', text = '这是已提交的正文'): Message {
  return { id: 'message-a', role, createdAt: '2026-01-01T00:00:00.000Z', content: [{ type: 'text', text }] };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('Worker voice tasks', () => {
  it('requests capture stop once, drains upload, and keeps automatic endpoint separate from commit', async () => {
    const provider = offlineProvider();
    provider.asr.recognize = async function* (input) {
      yield { type: 'ready', requestId: input.requestId };
      for await (const chunk of input.audio) {
        expect(chunk.byteLength).toBeGreaterThan(0);
        yield { type: 'endpoint', requestId: input.requestId, reason: 'smart_turn' };
        yield { type: 'endpoint', requestId: input.requestId, reason: 'smart_turn' };
      }
      yield { type: 'final', requestId: input.requestId, text: '停顿后的最终文字' };
    };
    const h = await harness({}, provider), port = new Port();
    h.tasks.attachCapture(handle, port); await h.wait('ready');
    port.send({ type: 'audio', captureId: handle.captureId, generation: handle.generation, sequence: 1, bytes: new Uint8Array(6400) });
    await vi.waitFor(() => expect(h.events.filter(event => event.type === 'endpoint')).toHaveLength(1));
    expect(h.events).toContainEqual({ type: 'endpoint', ...handle, reason: 'smart_turn' });
    expect(h.events.some(event => event.type === 'capture' && event.state === 'review')).toBe(false);
    expect(h.callbacks.submit).not.toHaveBeenCalled();
    port.send({ type: 'end', captureId: handle.captureId, generation: handle.generation, lastSequence: 1 });
    expect(await h.wait('review')).toMatchObject({ text: '停顿后的最终文字' });
    expect(h.callbacks.submit).not.toHaveBeenCalled();
  });
  it('reads all of a requested short poem without the two-sentence projection or summary model', async () => {
    const poem = '春花秋月何时了？往事知多少。小楼昨夜又东风，故国不堪回首月明中。雕栏玉砌应犹在，只是朱颜改。问君能有几多愁？恰似一江春水向东流。';
    const summary = vi.fn(async () => '这首词表达了故国之思。');
    const h = await harness({ readCommittedMessages: async () => [message('assistant', poem)], summarizeReply: summary });
    const result = await h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 1, automatic: false });
    expect(result.spokenText).toBe(poem); expect(result.truncated).toBe(false); expect(summary).not.toHaveBeenCalled();
    expect(h.provider.tts.synthesize).toHaveBeenCalledWith(expect.objectContaining({ text: poem }));
  });
  it('shows actionable local setup guidance without exposing subprocess diagnostics or creating a run', async () => {
    const provider = offlineProvider();
    provider.asr.recognize = () => ({ [Symbol.asyncIterator]: () => ({
      next: async () => { throw new SpeechProviderError('local_unavailable', 'Untrusted subprocess diagnostic'); }
    }) });
    const h = await harness({}, provider);
    h.tasks.attachCapture(handle, new Port());
    const failed = await h.wait('failed');
    expect(failed).toMatchObject({ errorCode: 'local_unavailable', reason: '本地转写不可用，请检查模型目录、Python 路径及 sherpa-onnx 安装。' });
    expect(JSON.stringify(h.events)).not.toContain('Untrusted subprocess diagnostic');
    expect(h.callbacks.submit).not.toHaveBeenCalled();
  });
  it('continues local WAV replies from the actual shorter segment boundary without dropping text', async () => {
    const text = '字'.repeat(200) + '1. 内容';
    const provider = offlineProvider();
    provider.tts.synthesize = vi.fn(async function* (input): ReturnType<SpeechProvider['tts']['synthesize']> {
      yield { type: 'audio', requestId: input.requestId, bytes: Uint8Array.of(1, 2), format: 'wav', sampleRate: 24000 };
      yield { type: 'completed', requestId: input.requestId };
    });
    const h = await harness({ readCommittedMessages: async () => [message('assistant', text)] }, provider);
    await h.runtime.configure({ ...createLocalSpeechSettings(), enabled: true });
    const first = await h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 1 });
    expect(first.nextOffset).toBe(200); expect(first.asset.format).toBe('wav');
    const next = await h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 2, offset: first.nextOffset! });
    expect(first.spokenText + next.spokenText).toBe(text); expect(next.nextOffset).toBeUndefined();
  });
  it('reads long bilingual text without cutting words or losing text at sentence boundaries', async () => {
    const text = 'Morning light returns to the quiet garden. The open road is waiting for the day. '.repeat(6)
      + '晨光越过窗前的小树，河水带着落叶向前。我们沿着小路慢慢走，阳光落在每一朵花上。'.repeat(4);
    const h = await harness({ readCommittedMessages: async () => [message('assistant', text)] });
    const segments: string[] = []; let offset = 0;
    for (;;) {
      const result = await h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 1, offset });
      segments.push(result.spokenText);
      expect(Array.from(result.spokenText).length).toBeLessThanOrEqual(200);
      if (result.nextOffset === undefined) break;
      expect(result.nextOffset).toBe(offset + Array.from(result.spokenText).length);
      expect(result.spokenText).toMatch(/[。！？!?；;，,：:\s.]$/u);
      offset = result.nextOffset;
    }
    expect(segments.length).toBeGreaterThan(2);
    expect(segments.join('')).toBe(text);
  });
  it.each(['synthesis_limit', 'synthesis_failed'] as const)('retries a smaller span on %s without losing the continuation boundary', async code => {
    const provider = offlineProvider(), synthesize = provider.tts.synthesize;
    provider.tts.synthesize = vi.fn(async function* (input) {
      if (Array.from(input.text).length > 50) throw new SpeechProviderError(code, 'controlled synthesis failure');
      yield* synthesize(input);
    });
    const h = await harness({ readCommittedMessages: async () => [message('assistant', '字'.repeat(250))] }, provider);
    const result = await h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 1 });
    expect(vi.mocked(provider.tts.synthesize).mock.calls.map(([input]) => input.text.length)).toEqual([200, 100, 50]);
    expect(result.spokenText).toBe('字'.repeat(50)); expect(result.nextOffset).toBe(50);
  });
  it('does not retry an unavailable installation or retry inference failures indefinitely', async () => {
    for (const code of ['local_unavailable', 'synthesis_failed'] as const) {
      const provider = offlineProvider();
      provider.tts.synthesize = vi.fn(() => ({ [Symbol.asyncIterator]: () => ({ next: async () => { throw new SpeechProviderError(code, 'controlled failure'); } }) }));
      const h = await harness({ readCommittedMessages: async () => [message('assistant', '字'.repeat(250))] }, provider);
      await expect(h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 1 })).rejects.toMatchObject({ code });
      expect(provider.tts.synthesize).toHaveBeenCalledTimes(code === 'local_unavailable' ? 1 : 3);
    }
  });
  it('actually shortens a failed final span that is already below the normal segment budget', async () => {
    const provider = offlineProvider(), synthesize = provider.tts.synthesize;
    provider.tts.synthesize = vi.fn(async function* (input) {
      if (input.text.length > 50) throw new SpeechProviderError('synthesis_failed', 'controlled failure');
      yield* synthesize(input);
    });
    const h = await harness({ readCommittedMessages: async () => [message('assistant', '字'.repeat(99))] }, provider);
    const result = await h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 1 });
    expect(vi.mocked(provider.tts.synthesize).mock.calls.map(([input]) => input.text.length)).toEqual([99, 50]);
    expect(result.nextOffset).toBe(50);
  });
  it('only emits a review draft after ordered audio ends and never starts a Run for ASR', async () => {
    const h = await harness(); const port = await capture(h);
    expect(h.events.at(-1)).toMatchObject({ type: 'capture', state: 'review', text: '保留下来的原句', ...handle });
    expect(port.sent).toEqual([{ type: 'ack', captureId: handle.captureId, generation: 1, sequence: 1 }]);
    expect(h.callbacks.submit).not.toHaveBeenCalled(); expect(port.closed).toBe(true);
  });
  it('requires a completed conversation draft and binds it to its original session', async () => {
    const h = await harness(); await expect(h.tasks.commit(request)).rejects.toThrow('voice_draft_unavailable');
    await capture(h); await expect(h.tasks.commit({ ...request, sessionId: 'other' })).rejects.toThrow('voice_draft_unavailable'); expect(h.callbacks.submit).not.toHaveBeenCalled();
  });
  it('reserves one run for concurrent and repeated commits and rejects changed input', async () => {
    const h = await harness(); await capture(h);
    const [a,b] = await Promise.all([h.tasks.commit(request), h.tasks.commit(request)]);
    expect(a).toEqual(b); expect(a.status).toBe('committed'); expect(h.callbacks.submit).toHaveBeenCalledOnce();
    expect(h.callbacks.submit).toHaveBeenCalledWith(request, a.runId);
    expect(await h.tasks.commit(request)).toEqual(a); await expect(h.tasks.commit({ ...request, text: '换一句' })).rejects.toThrow('voice_commit_conflict');
  });
  it('retains a busy draft through restart and only submits on an explicit subsequent commit', async () => {
    const h = await harness({ isBusy: () => true }); await capture(h);
    const pending = await h.tasks.commit(request); expect(pending).toMatchObject({ status: 'pending', reason: 'previous_run_finishing' }); expect(h.callbacks.submit).not.toHaveBeenCalled();
    h.tasks.dispose();
    const submit = vi.fn(async (_input, runId: string) => ({ runId }));
    const tasks = new DesktopVoiceTasks(h.runtime, h.directory, { ...h.callbacks, isBusy: () => false, submit }); cleanup.push(() => tasks.dispose());
    expect(submit).not.toHaveBeenCalled(); expect(await tasks.commit(request)).toMatchObject({ status: 'committed', runId: pending.runId }); expect(submit).toHaveBeenCalledOnce();
  });
  it.each(['started','accepted','unknown','missing'] as const)('recovers a submitting reservation only with a verified %s state', async (state) => {
    const h = await harness({ inspectRun: async () => state });
    const ledger = new SqliteVoiceCommitLedger(path.join(h.directory, 'runtime', 'speech.sqlite'));
    const record = ledger.reserve({ ...request, voiceSessionId: request.sessionId }).record;
    ledger.transition(request.voiceTurnId, 1, 'pending', 'submitting'); ledger.close();
    const result = await h.tasks.commit(request);
    expect(result.runId).toBe(record.runId); expect(result.status).toBe(state === 'started' || state === 'missing' ? 'committed' : 'failed');
    expect(h.callbacks.submit).toHaveBeenCalledTimes(state === 'missing' ? 1 : 0);
    if (state === 'accepted') expect(result.reason).toBe('run_start_not_committed');
    if (state === 'unknown') expect(result.reason).toBe('recovery_unknown');
  });
  it('queries the accepted original run after a lost submit response without re-running', async () => {
    const h = await harness({ submit: vi.fn(async () => { throw new Error('lost response'); }), inspectRun: async () => 'started' }); await capture(h);
    const first = await h.tasks.commit(request); expect(first.status).toBe('committed'); expect(await h.tasks.commit(request)).toEqual(first); expect(h.callbacks.submit).toHaveBeenCalledOnce();
  });
  it('keeps an explicit failed commit terminal, including after another commit', async () => {
    const h = await harness({ submit: vi.fn(async () => { throw new Error('not accepted'); }) }); await capture(h);
    const first = await h.tasks.commit(request); expect(first).toMatchObject({ status: 'failed', reason: 'run_start_failed' });
    expect(await h.tasks.commit(request)).toEqual(first); expect(h.callbacks.submit).toHaveBeenCalledOnce();
  });
  it('cancels old captures when the local model changes and rejects late results', async () => {
    const h = await harness(); const port = new Port(); h.tasks.attachCapture(handle, port); await h.wait('ready');
    const changed = SpeechSettingsSchema.parse({ enabled: true }); changed.provider.asr.local.modelDirectory = '/another-model';
    await h.runtime.configure(changed); await h.wait('cancelled');
    expect(port.closed).toBe(true); expect(h.events.filter(event => event.type === 'capture' && event.state === 'review')).toHaveLength(0);
    expect(h.callbacks.submit).not.toHaveBeenCalled();
  });
  it('reports invalid audio as a failed capture and clears the port', async () => {
    const h = await harness(); const port = new Port(); h.tasks.attachCapture(handle, port); await h.wait('ready');
    port.send({ type: 'audio', captureId: handle.captureId, generation: 1, sequence: 2, bytes: new Uint8Array(6400) });
    expect(await h.wait('failed')).toMatchObject({ errorCode: 'invalid_audio' }); expect(port.closed).toBe(true);
  });
  it('validates disabled ASR and fixed-text TTS only after complete provider output', async () => {
    const h = await harness({}, offlineProvider(), false); expect(h.runtime.service).toBeUndefined();
    await capture(h, { ...handle, purpose: 'validation', sessionId: undefined });
    expect(h.tasks.status().validation).toEqual({ asr: true, tts: false });
    const ready = await h.tasks.testTts(1); expect(ready.asset.owner).toEqual({ kind: 'test', id: 'speech-validation' });
    expect(h.tasks.status().validation).toEqual({ asr: true, tts: true });
    expect(h.events.filter(event => event.type === 'validation')).toEqual([
      { type: 'validation', asr: true, tts: false }, { type: 'validation', asr: true, tts: true }
    ]);
    const signature = h.tasks.status().validationSignature;
    await h.runtime.configure(SpeechSettingsSchema.parse({ enabled: true, autoReadReplies: true }));
    expect(h.tasks.status().validation).toEqual({ asr: true, tts: true }); expect(h.tasks.status().validationSignature).toBe(signature);
    const changed = SpeechSettingsSchema.parse({ enabled: true }); changed.provider.tts.speakerId = 'other-speaker';
    await h.runtime.configure(changed); expect(h.tasks.status().validation).toEqual({ asr: false, tts: false });
    expect(h.events.at(-1)).toEqual({ type: 'validation', asr: false, tts: false });
  });
  it('reads a committed assistant message by ID and normalizes the first local WAV segment', async () => {
    const body = '# 标题\n[正文](https://example.test)\n' + '字'.repeat(700) + '\n```ts\nsecret code\n```';
    const readCommittedMessages = vi.fn(async () => [message('assistant', body)]); const h = await harness({ readCommittedMessages });
    const ready = await h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 1 });
    expect(ready.spokenText).toHaveLength(200); expect(ready.spokenText).toContain('标题 正文'); expect(ready.truncated).toBe(true);
    expect(readCommittedMessages).toHaveBeenCalledWith('session-a'); expect(ready.asset.owner).toEqual({ kind: 'session', id: 'session-a' });
    expect(h.provider.tts.synthesize).toHaveBeenCalledOnce();
  });
  it('continues normalized persisted text in Unicode-safe segments beyond 10,000 characters without repeating or skipping', async () => {
    const text = '🌱'.repeat(200) + '甲'.repeat(10_000) + '最后一段';
    const h = await harness({ readCommittedMessages: async () => [message('assistant', '# ' + text)] });
    const first = await h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 1 });
    expect(Array.from(first.spokenText)).toHaveLength(200); expect(first.spokenText).toBe('🌱'.repeat(200)); expect(first.nextOffset).toBe(200);
    const second = await h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 2, offset: first.nextOffset });
    expect(second.spokenText).toBe('甲'.repeat(200)); expect(second.nextOffset).toBe(400);
    const last = await h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 3, offset: 10_200 });
    expect(last.spokenText).toBe('最后一段'); expect(last.nextOffset).toBeUndefined(); expect(last.truncated).toBe(false);
  });
  it.each(['1. 内容', '> 阈值'])('preserves inline text when a continuation begins with a Markdown-like fragment: %s', async (fragment) => {
    const h = await harness({ readCommittedMessages: async () => [message('assistant', '字'.repeat(200) + fragment)] });
    const ready = await h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 1, offset: 200 });
    expect(ready.spokenText).toBe(fragment); expect(ready.nextOffset).toBeUndefined();
    expect(h.provider.tts.synthesize).toHaveBeenCalledWith(expect.objectContaining({ text: ready.spokenText }));
  });
  it.each([{ offset: 100 }, { offset: -1 }, { offset: 1, automatic: true }])('rejects unavailable or automatic continuation before synthesis: %o', async (segment) => {
    const h = await harness({ readCommittedMessages: async () => [message()] });
    await expect(h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 1, ...segment })).rejects.toThrow();
    expect(h.provider.tts.synthesize).not.toHaveBeenCalled();
  });
  it('reads only a fixed approval prompt and never submits or reads message content', async () => {
    const isApprovalPending = vi.fn(async () => true), h = await harness({ isApprovalPending });
    const ready = await h.tasks.readApproval({ sessionId: 'session-a', approvalId: 'approval-a', generation: 1 });
    expect(isApprovalPending).toHaveBeenCalledTimes(3);
    expect(h.provider.tts.synthesize).toHaveBeenCalledWith(expect.objectContaining({ text: '需要你确认一项操作，请在界面中查看并确认。' }));
    expect(ready.asset.owner).toEqual({ kind: 'session', id: 'session-a' });
    expect(h.callbacks.submit).not.toHaveBeenCalled(); expect(h.callbacks.readCommittedMessages).not.toHaveBeenCalled();
  });
  it('rejects an approval from a different or already resolved pending record before TTS', async () => {
    const h = await harness({ isApprovalPending: () => false });
    await expect(h.tasks.readApproval({ sessionId: 'session-a', approvalId: 'approval-a', generation: 1 })).rejects.toMatchObject({ code: 'resource_denied' });
    expect(h.provider.tts.synthesize).not.toHaveBeenCalled();
  });
  it('releases a synthesized approval when the record resolves before playback handoff', async () => {
    const isApprovalPending = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const h = await harness({ isApprovalPending });
    const release = vi.spyOn(h.runtime, 'releaseAsset');
    await expect(h.tasks.readApproval({ sessionId: 'session-a', approvalId: 'approval-a', generation: 1 })).rejects.toMatchObject({ code: 'resource_denied' });
    expect(release).toHaveBeenCalledOnce();
  });
  it('tests a saved voice preset without granting validation to the global voice configuration', async () => {
    const h = await harness({}, offlineProvider(), false);
    await h.runtime.configure(SpeechSettingsSchema.parse({ enabled: false, voicePresets: [{ id: 'calm', name: '安静', speakerId: 'offline-calm' }] }));
    const ready = await h.tasks.testTts(1, 'calm');
    expect(ready.asset.owner.kind).toBe('test'); expect(h.tasks.status().validation.tts).toBe(false);
    await expect(h.tasks.testTts(2, 'missing')).rejects.toMatchObject({ code: 'speaker_unavailable' });
    expect(h.provider.tts.synthesize).toHaveBeenCalledOnce();
  });
  it('clears cached speech assets while retaining the completed ASR and TTS validation proof', async () => {
    const h = await harness({ readCommittedMessages: async () => [message()] });
    const ready = await h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 1 });
    await h.tasks.testTts(2); const before = h.tasks.status().validation;
    await h.tasks.clearCache();
    expect(await h.runtime.resolveAsset(ready.asset.id, ready.asset.owner)).toBeUndefined();
    expect(h.tasks.status().validation).toEqual(before);
  });
  it.each(['user','tool','internal','planning','missing'] as const)('rejects %s message reading without TTS', async (kind) => {
    const value = message(kind === 'user' || kind === 'tool' ? kind : 'assistant');
    if (kind === 'internal') value.metadata = { internal: true };
    if (kind === 'planning') value.content.push({ type: 'tool_call', call: { id: 'call-a', name: 'tool', input: {} } });
    const h = await harness({ readCommittedMessages: async () => kind === 'missing' ? [] : [value] });
    await expect(h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 1 })).rejects.toMatchObject({ code: 'resource_denied' }); expect(h.provider.tts.synthesize).not.toHaveBeenCalled();
  });
  it('removes deleted-session drafts, durable reservations and owned audio assets', async () => {
    const h = await harness({ isBusy: () => true, readCommittedMessages: async () => [message()] }); await capture(h); await h.tasks.commit(request);
    const ready = await h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 1 });
    await h.tasks.releaseSession('session-a'); expect(h.tasks.status().captures).toEqual([]);
    expect(await h.runtime.resolveAsset(ready.asset.id, ready.asset.owner)).toBeUndefined();
    await expect(h.tasks.commit(request)).rejects.toThrow('voice_draft_unavailable'); expect(h.callbacks.submit).not.toHaveBeenCalled();
  });
  it('does not grant validation for a duplicated or late final result', async () => {
    const provider = offlineProvider();
    provider.asr.recognize = async function* (input) {
      yield { type: 'ready', requestId: input.requestId };
      for await (const audio of input.audio) expect(audio.byteLength).toBeGreaterThan(0);
      yield { type: 'final', requestId: input.requestId, text: 'first' };
      yield { type: 'final', requestId: input.requestId, text: 'late duplicate' };
    };
    const h = await harness({}, provider, false); const value = { ...handle, purpose: 'validation' as const };
    const port = new Port(); h.tasks.attachCapture(value, port); await h.wait('ready');
    port.send({ type: 'audio', captureId: value.captureId, generation: 1, sequence: 1, bytes: new Uint8Array(6400) });
    port.send({ type: 'end', captureId: value.captureId, generation: 1, lastSequence: 1 });
    expect(await h.wait('failed')).toMatchObject({ errorCode: 'protocol_error' }); expect(h.tasks.status().validation.asr).toBe(false);
    expect(h.events.some(event => event.type === 'capture' && event.state === 'review')).toBe(false);
  });
  it('stops an in-flight synthesis without dropping its busy voice draft or retrying TTS', async () => {
    const entered = deferred<void>(); const provider = offlineProvider();
    provider.tts.synthesize = vi.fn(async function* (input: Parameters<SpeechProvider['tts']['synthesize']>[0]): ReturnType<SpeechProvider['tts']['synthesize']> {
      yield { type: 'audio', requestId: input.requestId, bytes: Uint8Array.of(1,2), format: 'wav', sampleRate: 24000 };
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new SpeechProviderError('cancelled', 'Stopped'));
        input.signal.addEventListener('abort', abort, { once: true }); if (input.signal.aborted) abort();
      });
      yield { type: 'completed', requestId: input.requestId };
    });
    const h = await harness({ isBusy: () => true, readCommittedMessages: async () => [message()] }, provider); await capture(h);
    const pending = await h.tasks.commit(request);
    const read = h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 1 });
    const rejected = expect(read).rejects.toMatchObject({ code: 'cancelled' }); await entered.promise;
    h.tasks.cancelReadTasks('session-a', 1); await rejected;
    expect(await h.tasks.commit(request)).toEqual(pending); expect(provider.tts.synthesize).toHaveBeenCalledOnce(); expect(h.callbacks.submit).not.toHaveBeenCalled();
  });
  it('releases a ready audio reference when stop races with resolving its authorized path', async () => {
    const h = await harness({ readCommittedMessages: async () => [message()] });
    const entered = deferred<void>(); const gate = deferred<void>(); const original = h.runtime.resolveAsset.bind(h.runtime);
    let id: string | undefined;
    vi.spyOn(h.runtime, 'resolveAsset').mockImplementation(async (assetId, owner) => { id = assetId; entered.resolve(); await gate.promise; return original(assetId, owner); });
    const read = h.tasks.readMessage({ sessionId: 'session-a', messageId: 'message-a', generation: 1 });
    const rejected = expect(read).rejects.toMatchObject({ code: 'cancelled' }); await entered.promise;
    h.tasks.cancelReadTasks('session-a'); gate.resolve(); await rejected;
    expect(await original(id!, { kind: 'session', id: 'session-a' })).toBeUndefined();
  });
  it('cancels a reviewed busy draft without cancelling or starting an Agent Run', async () => {
    const h = await harness({ isBusy: () => true }); await capture(h); const pending = await h.tasks.commit(request);
    h.tasks.cancelCapture(handle.captureId, 1);
    expect(await h.tasks.commit(request)).toMatchObject({ runId: pending.runId, status: 'failed', reason: 'voice_turn_cancelled' }); expect(h.callbacks.submit).not.toHaveBeenCalled();
  });
  it('retains a pending draft when another registry task starts between busy check and submission', async () => {
    const submit = vi.fn(async (_input, runId: string) => ({ runId })).mockRejectedValueOnce(new VoiceRunBusyError());
    const h = await harness({ submit }); await capture(h);
    const first = await h.tasks.commit(request); expect(first).toMatchObject({ status: 'pending', reason: 'previous_run_finishing' });
    const next = await h.tasks.commit(request); expect(next).toMatchObject({ status: 'committed', runId: first.runId }); expect(submit).toHaveBeenCalledTimes(2);
  });
  it('does not reset a submitting Run to pending if a busy error follows an existing Run', async () => {
    const submit = vi.fn(async () => { throw new VoiceRunBusyError(); });
    const h = await harness({ submit, inspectRun: async () => 'accepted' }); await capture(h);
    expect(await h.tasks.commit(request)).toMatchObject({ status: 'failed', reason: 'run_start_not_committed' });
    await h.tasks.commit(request); expect(submit).toHaveBeenCalledOnce();
  });
  it('calls the current TTS provider on every explicit validation even when test audio is cached', async () => {
    const h = await harness({}, offlineProvider(), false);
    const first = await h.tasks.testTts(1); const next = await h.tasks.testTts(2);
    expect(first.asset.owner).toEqual(next.asset.owner); expect(first.asset.bytes).toBe(next.asset.bytes);
    expect(h.provider.tts.synthesize).toHaveBeenCalledTimes(2); expect(h.tasks.status().validation.tts).toBe(true);
  });
  it('does not validate a changed local voice with cached audio from the previous configuration', async () => {
    const h = await harness({}, offlineProvider(), false); const ready = await h.tasks.testTts(1);
    expect(h.tasks.status().validation.tts).toBe(true);
    const changed = SpeechSettingsSchema.parse({ enabled: false }); changed.provider.tts.speechRate = 15;
    await h.runtime.configure(changed);
    expect(h.tasks.status().validation.tts).toBe(false);
    expect(await h.runtime.resolveAsset(ready.asset.id, ready.asset.owner)).toBeDefined();
    h.provider.tts.synthesize = vi.fn(async function* (request: Parameters<SpeechProvider['tts']['synthesize']>[0]): ReturnType<SpeechProvider['tts']['synthesize']> {
      yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1,2), format: 'wav', sampleRate: 24000 };
      throw new SpeechProviderError('local_unavailable', 'System voice is unavailable.');
    });
    await expect(h.tasks.testTts(2)).rejects.toMatchObject({ code: 'local_unavailable' });
    expect(h.provider.tts.synthesize).toHaveBeenCalledOnce(); expect(h.tasks.status().validation.tts).toBe(false);
  });
});
