import { SPEECH_LIMITS, SpeechProviderError, SpeechCaptureHandleSchema, type AudioAsset, type AudioAssetOwner, type Message,
  ReadSpeechMessageInputSchema, ReadApprovalSpeechInputSchema, type ReadSpeechMessageInput, type ReadApprovalSpeechInput, type SpeechCaptureHandle, type CommitVoiceTurnInput, type VoiceCommitResult, type SpeechEvent, type SpeechCaptureState, type SpeechErrorCode } from '@desktop-agent/contracts';
import { type SpeechService, normalizeSpeechTextContent, projectVoiceReply, speechTextSegment } from '@desktop-agent/speech';
import { SqliteVoiceCommitLedger, VoiceCommitInputSchema, type VoiceCommitLedger, type VoiceCommitRecord } from '@desktop-agent/storage';
import path from 'node:path';
import { z } from 'zod';
import { PcmUploadStream, type PcmAudioPort } from './pcm-upload-stream';
import { DesktopSpeechRuntime } from './speech-runtime';

export type VoiceCaptureHandle = SpeechCaptureHandle;
export type VoiceCommitRequest = CommitVoiceTurnInput;
export type VoiceCommitResponse = VoiceCommitResult;
export type WorkerSpeechEvent = Extract<SpeechEvent, { type: 'capture' }>;
/** A registry conflict before the host creates either application/runtime Run. */
export class VoiceRunBusyError extends Error {
  constructor() { super('The previous session task is still active.'); this.name = 'VoiceRunBusyError'; }
}
export interface DesktopVoiceTasksOptions {
  emit(event: SpeechEvent): void;
  readCommittedMessages(sessionId: string): Promise<Message[]>;
  summarizeReply?(text: string, signal: AbortSignal): Promise<string | undefined>;
  isBusy(sessionId: string): boolean | Promise<boolean>;
  isApprovalPending?(sessionId: string, approvalId: string): boolean | Promise<boolean>;
  submit(input: VoiceCommitRequest, reservedRunId: string): Promise<{ runId: string }>;
  /** Must query both App Service and Runtime and check the session/lane binding. */
  inspectRun(record: VoiceCommitRecord): Promise<'missing' | 'accepted' | 'started' | 'unknown'>;
  ledger?: VoiceCommitLedger;
}
interface CaptureTask { handle: VoiceCaptureHandle; controller: AbortController; stream: PcmUploadStream; done: Promise<void>; timer?: ReturnType<typeof setTimeout> }
interface ReadTask { sessionId: string; generation: number; controller: AbortController }
const keyFor = (voiceTurnId: string, generation: number): string => JSON.stringify([voiceTurnId, generation]);
const failureCode = (error: unknown): SpeechErrorCode => error instanceof SpeechProviderError ? error.code : 'protocol_error';

/** Host orchestration: final ASR is a draft, never a tool invocation. Committing a
 * draft is an explicit, durable reservation before the existing text Run path. */
export class DesktopVoiceTasks {
  private readonly ledger: VoiceCommitLedger;
  private readonly captures = new Map<string, CaptureTask>();
  private readonly captureStates = new Map<string, SpeechCaptureState>();
  private readonly drafts = new Map<string, VoiceCaptureHandle>();
  private readonly submissions = new Map<string, Promise<VoiceCommitResponse>>();
  private readonly readTasks = new Map<string, ReadTask>();
  private readonly sessionEpoch = new Map<string, number>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeValidation: () => void;
  private closed = false;
  constructor(private readonly runtime: DesktopSpeechRuntime, dataDirectory: string, private readonly options: DesktopVoiceTasksOptions) {
    this.ledger = options.ledger ?? new SqliteVoiceCommitLedger(path.join(dataDirectory, 'runtime', 'speech.sqlite'));
    this.unsubscribe = runtime.onInvalidated(() => this.invalidate());
    this.unsubscribeValidation = runtime.onValidationChanged(validation => { if (!this.closed) this.options.emit({ type: 'validation', ...validation }); });
  }
  private post(handle: VoiceCaptureHandle, state: WorkerSpeechEvent['state'], extra: Partial<WorkerSpeechEvent> = {}): void {
    if (!this.closed) {
      const event: WorkerSpeechEvent = { type: 'capture', ...handle, state, ...extra };
      const { type: _type, ...snapshot } = event;
      void _type;
      this.captureStates.set(handle.captureId, snapshot);
      if (this.captureStates.size > 100) this.captureStates.delete(this.captureStates.keys().next().value!);
      this.options.emit(event);
    }
  }
  attachCapture(handle: VoiceCaptureHandle, port: PcmAudioPort): void {
    handle = SpeechCaptureHandleSchema.parse(handle);
    if (handle.purpose === 'conversation' && !handle.sessionId) { port.close(); throw new Error('speech_capture_session_missing'); }
    if (this.closed || this.captures.has(handle.captureId) || this.captures.size >= 32 || (handle.purpose === 'conversation' && this.drafts.size >= 32) ||
      Array.from(this.captures.values()).some((task) => task.handle.sessionId && task.handle.sessionId === handle.sessionId)) {
      port.close(); throw new Error('speech_capture_unavailable');
    }
    const service = handle.purpose === 'validation' ? this.runtime.serviceForValidation : this.runtime.service;
    if (!service) { port.close(); this.post(handle, 'failed', { errorCode: 'resource_denied', reason: 'Speech is disabled or its key is missing.' }); return; }
    const controller = new AbortController();
    const trace = { captureId: handle.voiceTurnId, generation: handle.generation };
    this.runtime.latency.begin(trace);
    const stream = new PcmUploadStream(port, handle, {
      onEnd: () => {
        this.runtime.latency.mark(trace, 'record_end');
        const task = this.captures.get(handle.captureId);
        if (task?.timer) clearTimeout(task.timer);
        if (task) task.timer = setTimeout(() => stream.fail(new SpeechProviderError('timeout', 'Speech final result timed out.')), this.runtime.usesLocalAsr ? 30_000 : 15_000);
        this.post(handle, 'recognizing');
      }, onFailure: () => controller.abort()
    });
    const task: CaptureTask = { handle, controller, stream, done: Promise.resolve(),
      timer: setTimeout(() => stream.fail(new SpeechProviderError('timeout', 'Speech connection timed out.')), this.runtime.usesLocalAsr ? 30_000 : 10_000) };
    this.captures.set(handle.captureId, task); this.post(handle, 'connecting');
    task.done = this.recognize(task, service);
  }
  private async recognize(task: CaptureTask, service: SpeechService): Promise<void> {
    const { handle, controller, stream } = task;
    let ready = false; let requestId: string | undefined; let revision = 0; let endpointSent = false;
    let final: { text: string; durationMs?: number } | undefined;
    try {
      for await (const event of service.recognize(stream, controller.signal)) {
        if (controller.signal.aborted || this.captures.get(handle.captureId) !== task) throw new SpeechProviderError('cancelled', 'Speech capture cancelled.');
        if (event.type === 'ready') {
          if (ready || !event.requestId || event.requestId.length > 256) throw new SpeechProviderError('protocol_error', 'Invalid ASR readiness.');
          requestId = event.requestId;
          if (task.timer) clearTimeout(task.timer);
          ready = true; stream.activate(); this.post(handle, 'ready');
          task.timer = setTimeout(() => stream.fail(new SpeechProviderError('timeout', 'Speech recording reached its time limit.')), SPEECH_LIMITS.captureMs);
        } else if (event.type === 'endpoint') {
          if (!ready || final || event.requestId !== requestId) throw new SpeechProviderError('protocol_error', 'Invalid ASR endpoint order.');
          if (endpointSent || stream.finished) continue;
          endpointSent = true;
          this.options.emit({ type: 'endpoint', ...handle, reason: event.reason });
        } else if (event.type === 'partial') {
          if (!ready || final || event.requestId !== requestId || !Number.isSafeInteger(event.revision) || event.revision <= revision || event.text.length > 20_000) {
            throw new SpeechProviderError('protocol_error', 'Invalid ASR event order.');
          }
          revision = event.revision; this.post(handle, 'recording', { text: event.text });
        } else {
          if (!ready || final || event.requestId !== requestId || !stream.finished || !event.text.trim() || event.text.length > 20_000 ||
            (event.durationMs !== undefined && (!Number.isFinite(event.durationMs) || event.durationMs < 0 || event.durationMs > 60_200))) {
            throw new SpeechProviderError('protocol_error', 'Invalid ASR completion.');
          }
          final = { text: event.text.trim(), ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }) };
          this.runtime.latency.mark({ captureId: handle.voiceTurnId, generation: handle.generation }, 'asr_final');
        }
      }
      if (!final) throw new SpeechProviderError('empty_result', 'ASR ended without a final sentence.');
      if (controller.signal.aborted) throw new SpeechProviderError('cancelled', 'Speech capture cancelled.');
      if (handle.purpose === 'validation') this.runtime.markValidated('asr', service);
      else this.drafts.set(keyFor(handle.voiceTurnId, handle.generation), handle);
      this.post(handle, 'review', final);
    } catch (error) {
      const cancelled = controller.signal.aborted && (!stream.error || stream.error.code === 'cancelled');
      this.post(handle, cancelled ? 'cancelled' : 'failed', {
        errorCode: cancelled ? 'cancelled' : failureCode(stream.error ?? error),
        reason: cancelled ? 'Speech capture cancelled.' : error instanceof SpeechProviderError && error.code === 'local_unavailable'
          ? '本地转写不可用，请检查模型目录、Python 路径及 sherpa-onnx 安装。' : 'Speech recognition failed; record the sentence again.'
      });
    } finally {
      if (task.timer) clearTimeout(task.timer); stream.dispose(); controller.abort();
      if (this.captures.get(handle.captureId) === task) this.captures.delete(handle.captureId);
    }
  }
  cancelCapture(captureId: string, generation: number): void {
    const task = this.captures.get(captureId);
    if (task && task.handle.generation === generation) { task.controller.abort(); task.stream.dispose(); }
    for (const [key, handle] of this.drafts) {
      if (handle.captureId !== captureId || handle.generation !== generation) continue;
      this.drafts.delete(key); this.post(handle, 'cancelled', { errorCode: 'cancelled', reason: 'Speech draft cancelled.' });
      const record = this.ledger.get(handle.voiceTurnId, generation);
      if (record?.state === 'pending') this.ledger.transition(handle.voiceTurnId, generation, 'pending', 'failed', 'voice_turn_cancelled', record.revision);
    }
  }
  /** Return the original reservation, including busy drafts and terminal failures. */
  async commit(input: VoiceCommitRequest): Promise<VoiceCommitResponse> {
    if (this.closed) return Promise.reject(new Error('speech_tasks_closed'));
    const parsed = VoiceCommitInputSchema.parse({ ...input, voiceSessionId: input.sessionId });
    const key = keyFor(parsed.voiceTurnId, parsed.generation);
    const existing = this.ledger.get(parsed.voiceTurnId, parsed.generation);
    const draft = this.drafts.get(key);
    if (!existing && (!draft || draft.sessionId !== parsed.sessionId)) return Promise.reject(new Error('voice_draft_unavailable'));
    const { record } = this.ledger.reserve(parsed);
    const pending = this.submissions.get(key);
    if (pending) return pending;
    const epoch = this.sessionEpoch.get(input.sessionId) ?? 0;
    const task = this.submit(record, epoch).finally(() => { if (this.submissions.get(key) === task) this.submissions.delete(key); });
    this.submissions.set(key, task); return task;
  }
  private result(record: VoiceCommitRecord, reason?: string): VoiceCommitResponse {
    return { voiceTurnId: record.voiceTurnId, generation: record.generation, sessionId: record.sessionId, runId: record.runId,
      status: record.state === 'committed' ? 'committed' : record.state === 'failed' ? 'failed' : 'pending',
      ...(reason ?? record.errorCode ? { reason: reason ?? record.errorCode } : {}) };
  }
  private alive(record: VoiceCommitRecord, epoch: number): boolean {
    return !this.closed && (this.sessionEpoch.get(record.sessionId) ?? 0) === epoch;
  }
  private async submit(record: VoiceCommitRecord, epoch: number): Promise<VoiceCommitResponse> {
    if (record.state === 'committed' || record.state === 'failed') return this.result(record);
    if (record.state === 'submitting') {
      let state: Awaited<ReturnType<DesktopVoiceTasksOptions['inspectRun']>>;
      try { state = await this.options.inspectRun(record); } catch { state = 'unknown'; }
      if (!this.alive(record, epoch)) return this.result(record, 'voice_session_cancelled');
      if (state === 'started') return this.result(this.ledger.transition(record.voiceTurnId, record.generation, 'submitting', 'committed', undefined, record.revision));
      if (state !== 'missing') return this.result(this.ledger.transition(record.voiceTurnId, record.generation, 'submitting', 'failed',
        state === 'accepted' ? 'run_start_not_committed' : 'recovery_unknown', record.revision));
      record = this.ledger.transition(record.voiceTurnId, record.generation, 'submitting', 'pending', undefined, record.revision);
      if (record.state !== 'pending') return this.result(record);
    }
    const busy = await this.options.isBusy(record.sessionId);
    if (!this.alive(record, epoch)) return this.result(record, 'voice_session_cancelled');
    if (busy) return this.result(record, 'previous_run_finishing');
    const claim = this.ledger.claim(record); record = claim.record;
    if (!claim.claimed) return this.result(record);
    try {
      const { voiceTurnId, generation, sessionId, text, providerId, model } = record;
      const accepted = await this.options.submit({ voiceTurnId, generation, sessionId, text, providerId, model }, record.runId);
      if (!this.alive(record, epoch)) return this.result(record, 'voice_session_cancelled');
      if (accepted.runId !== record.runId) throw new Error('voice_run_binding_mismatch');
      record = this.ledger.transition(voiceTurnId, generation, 'submitting', 'committed', undefined, record.revision);
      this.drafts.delete(keyFor(voiceTurnId, generation)); return this.result(record);
    } catch (error) {
      if (!this.alive(record, epoch)) return this.result(record, 'voice_session_cancelled');
      // The host may have accepted before its response was lost. Inspect both stores;
      // never retry a provider/Run as a consequence of transport ambiguity.
      let state: Awaited<ReturnType<DesktopVoiceTasksOptions['inspectRun']>>;
      try { state = await this.options.inspectRun(record); } catch { state = 'unknown'; }
      if (!this.alive(record, epoch)) return this.result(record, 'voice_session_cancelled');
      if (error instanceof VoiceRunBusyError && state === 'missing') {
        record = this.ledger.transition(record.voiceTurnId, record.generation, 'submitting', 'pending', undefined, record.revision);
        return this.result(record, record.state === 'pending' ? 'previous_run_finishing' : undefined);
      }
      record = this.ledger.transition(record.voiceTurnId, record.generation, 'submitting', state === 'started' ? 'committed' : 'failed',
        state === 'started' ? undefined : state === 'accepted' ? 'run_start_not_committed' : state === 'unknown' ? 'recovery_unknown' : 'run_start_failed', record.revision);
      return this.result(record);
    }
  }
  async readMessage(input: ReadSpeechMessageInput): Promise<{ asset: AudioAsset; path: string; spokenText: string; truncated: boolean; nextOffset?: number }> {
    input = ReadSpeechMessageInputSchema.parse(input);
    const service = this.runtime.service;
    if (!service || this.closed) throw new SpeechProviderError('resource_denied', 'Speech is disabled or its key is missing.');
    const controller = new AbortController(); const task: ReadTask = { ...input, controller };
    let published: AudioAsset | undefined;
    const key = input.sessionId; this.readTasks.get(key)?.controller.abort(); this.readTasks.set(key, task);
    const check = () => { if (controller.signal.aborted || this.closed || this.readTasks.get(key) !== task) throw new SpeechProviderError('cancelled', 'Speech reading cancelled.'); };
    try {
      const messages = await this.options.readCommittedMessages(input.sessionId); check();
      const message = messages.find((item) => item.id === input.messageId);
      if (!message || message.role !== 'assistant' || message.metadata?.internal || message.content.some((block) => block.type === 'tool_call')) {
        throw new SpeechProviderError('resource_denied', 'Only committed assistant messages can be read.');
      }
      const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      const summary = input.automatic ? await this.options.summarizeReply?.(text, controller.signal) : undefined;
      check();
      const normalized = Array.from(input.automatic ? projectVoiceReply(summary || text, service.replySegmentChars) : normalizeSpeechTextContent(text));
      const offset = input.offset ?? 0;
      if ((input.automatic && offset !== 0) || offset >= normalized.length) throw new SpeechProviderError('resource_denied', 'The requested speech segment is unavailable.');
      let budget = service.replySegmentChars, spokenText: string, asset: AudioAsset;
      for (;;) {
        spokenText = speechTextSegment(normalized, offset, budget);
        try {
          asset = await service.synthesize({ text: spokenText, owner: { kind: 'session', id: input.sessionId }, signal: controller.signal,
            maxChars: service.replySegmentChars, alreadyNormalized: true });
          break;
        } catch (error) {
          check();
          // An inference failure never publishes partial audio. Retry a smaller
          // coherent span at most twice; missing installations are not retried.
          const chars = Array.from(spokenText).length;
          if (!(error instanceof SpeechProviderError) || !['synthesis_failed', 'synthesis_limit'].includes(error.code) || chars <= 50) throw error;
          budget = Math.max(50, Math.floor(chars / 2));
        }
      }
      const nextOffset = offset + Array.from(spokenText).length;
      published = asset; check();
      const ready = await this.runtime.resolveAsset(asset.id, asset.owner); check();
      if (!ready) throw new SpeechProviderError('protocol_error', 'Speech asset is unavailable.');
      return { ...ready, spokenText, truncated: nextOffset < normalized.length, ...(nextOffset < normalized.length ? { nextOffset } : {}) };
    } catch (error) {
      if (published) await this.runtime.releaseAsset(published).catch(() => undefined);
      throw error;
    } finally { controller.abort(); if (this.readTasks.get(key) === task) this.readTasks.delete(key); }
  }
  async readApproval(input: ReadApprovalSpeechInput): Promise<{ asset: AudioAsset; path: string }> {
    input = ReadApprovalSpeechInputSchema.parse(input);
    const service = this.runtime.service;
    if (!service || this.closed) throw new SpeechProviderError('resource_denied', 'Speech is disabled or its key is missing.');
    const controller = new AbortController(), key = input.sessionId;
    const task: ReadTask = { sessionId: key, generation: input.generation, controller };
    let published: AudioAsset | undefined;
    this.readTasks.get(key)?.controller.abort(); this.readTasks.set(key, task);
    const check = async () => {
      if (controller.signal.aborted || this.closed || this.readTasks.get(key) !== task) throw new SpeechProviderError('cancelled', 'Approval speech cancelled.');
      const pending = await this.options.isApprovalPending?.(input.sessionId, input.approvalId);
      if (!pending || controller.signal.aborted || this.closed || this.readTasks.get(key) !== task) throw new SpeechProviderError('resource_denied', 'Approval is no longer pending.');
    };
    try {
      await check();
      const asset = await service.synthesize({ text: '需要你确认一项操作，请在界面中查看并确认。',
        owner: { kind: 'session', id: input.sessionId }, signal: controller.signal, maxChars: SPEECH_LIMITS.autoReadChars });
      published = asset; await check();
      const ready = await this.runtime.resolveAsset(asset.id, asset.owner); await check();
      if (!ready) throw new SpeechProviderError('protocol_error', 'Approval speech asset is unavailable.');
      return ready;
    } catch (error) {
      if (published) await this.runtime.releaseAsset(published).catch(() => undefined);
      throw error;
    } finally { controller.abort(); if (this.readTasks.get(key) === task) this.readTasks.delete(key); }
  }
  async testTts(generation: number, presetId?: string): Promise<{ asset: AudioAsset; path: string }> {
    z.number().int().nonnegative().parse(generation);
    const service = presetId ? this.runtime.serviceForPresetValidation(presetId) : this.runtime.serviceForValidation;
    if (!service || this.closed) throw new SpeechProviderError('resource_denied', 'Speech key is missing.');
    const controller = new AbortController(); const key = 'validation';
    let published: AudioAsset | undefined;
    this.readTasks.get(key)?.controller.abort(); const task: ReadTask = { sessionId: key, generation, controller }; this.readTasks.set(key, task);
    try {
      const asset = await service.synthesize({ text: '你好，我是 Jojo。语音朗读测试完成。', owner: { kind: 'test', id: 'speech-validation' }, signal: controller.signal,
        maxChars: SPEECH_LIMITS.autoReadChars, forceProvider: true }); published = asset;
      if (controller.signal.aborted || this.readTasks.get(key) !== task) throw new SpeechProviderError('cancelled', 'Speech test cancelled.');
      const ready = await this.runtime.resolveAsset(asset.id, asset.owner);
      if (controller.signal.aborted || this.readTasks.get(key) !== task) throw new SpeechProviderError('cancelled', 'Speech test cancelled.');
      if (!ready) throw new SpeechProviderError('protocol_error', 'Speech test asset is unavailable.');
      if (!presetId) this.runtime.markValidated('tts', service); return ready;
    } catch (error) {
      if (published) await this.runtime.releaseAsset(published).catch(() => undefined);
      throw error;
    } finally { controller.abort(); if (this.readTasks.get(key) === task) this.readTasks.delete(key); }
  }
  status() {
    const { validationSignature, ...validation } = this.runtime.validationStatus();
    return { captures: Array.from(this.captureStates.values()), playbacks: [], validation, diagnostics: this.runtime.diagnostics(), latency: this.runtime.latencyDiagnostics(), ...(validationSignature ? { validationSignature } : {}) };
  }
  cancelReadTasks(sessionId?: string, generation?: number): void {
    for (const task of this.readTasks.values()) {
      if ((sessionId === undefined || task.sessionId === sessionId) && (generation === undefined || task.generation <= generation)) task.controller.abort();
    }
  }
  resolveAsset(id: string, owner: AudioAssetOwner) { return this.runtime.resolveAsset(id, owner); }
  async clearCache(): Promise<void> { this.invalidate(); await this.runtime.clearCache(); }
  invalidate(): void {
    for (const task of this.captures.values()) { task.controller.abort(); task.stream.dispose(); }
    for (const task of this.readTasks.values()) task.controller.abort();
    this.drafts.clear();
  }
  async releaseSession(sessionId: string): Promise<void> {
    this.sessionEpoch.set(sessionId, (this.sessionEpoch.get(sessionId) ?? 0) + 1);
    for (const task of this.captures.values()) if (task.handle.sessionId === sessionId) { task.controller.abort(); task.stream.dispose(); }
    this.readTasks.get(sessionId)?.controller.abort();
    for (const [key, handle] of this.drafts) if (handle.sessionId === sessionId) this.drafts.delete(key);
    for (const [key, state] of this.captureStates) if (state.sessionId === sessionId) this.captureStates.delete(key);
    this.ledger.deleteSession(sessionId); await this.runtime.releaseOwner({ kind: 'session', id: sessionId });
  }
  dispose(): void {
    if (this.closed) return;
    this.invalidate(); this.closed = true; this.unsubscribe(); this.unsubscribeValidation(); this.ledger.close();
  }
}
