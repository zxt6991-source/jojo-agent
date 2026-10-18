import React, { useEffect, useRef, useState } from 'react';
import { createLocalSpeechSettings, LOCAL_NEURAL_VOICES, type DesktopApi, type SpeechDiagnostics, type SpeechPlaybackState, type SpeechSettings, type SpeechSettingsSnapshot, type SpeechVoicePreset, type VoiceLatencyDiagnostics } from '@desktop-agent/contracts';
import { activeSpeechPlayback, nextSpeechGeneration, useSpeechStatus } from './useSpeech';
import { changeSpeechEngine, NEURAL_VOICE_LABELS } from './neural-voice-settings';

type PresetTrial = { signature: string; playbackId?: string; error?: string };

export function speechPresetTrialLabel(trial: PresetTrial | undefined, signature: string, playbacks: SpeechPlaybackState[]): string {
  if (!trial || trial.signature !== signature) return '尚未试听此预设';
  if (trial.error) return `试听失败：${trial.error}`;
  if (!trial.playbackId) return '正在准备试听…';
  const playback = playbacks.find(value => value.playbackId === trial.playbackId);
  if (playback?.state === 'played') return '本次试听已完成';
  if (playback?.state === 'playing') return '正在试听…';
  if (playback?.state === 'failed') return `试听失败${playback.reason ? `：${playback.reason}` : ''}`;
  if (playback?.state === 'suppressed') return '本次试听已静音';
  if (playback?.state === 'interrupted') return '本次试听已停止';
  return '正在准备试听…';
}

export function SpeechVoicePresetEditor({ preset, index, dirty, busy, neural = false, trialLabel, onChange, onRemove, onTest }: {
  preset: SpeechVoicePreset; index: number; dirty: boolean; busy: boolean;
  trialLabel: string;
  neural?: boolean;
  onChange(patch: Partial<SpeechVoicePreset>): void;
  onRemove(): void;
  onTest(): void;
}) {
  return <article className="speech-preset-card" aria-label={`音色预设 ${index + 1}`}>
    <div className="speech-preset-header"><strong>{preset.name || `预设 ${index + 1}`}</strong><button type="button" disabled={busy} onClick={onRemove} aria-label={`移除音色预设 ${index + 1}`}>移除</button></div>
    <label className="speech-setting-field">预设名称<input aria-label={`预设 ${index + 1} 名称`} maxLength={80} value={preset.name} disabled={busy} onChange={event => onChange({ name: event.target.value })} placeholder="例如：工作提醒" /></label>
    {neural ? <label className="speech-setting-field">声音<select aria-label={`预设 ${index + 1} 声音`} value={preset.speakerId} disabled={busy} onChange={event => onChange({ speakerId: event.target.value, speechRate: 0 })}>
      <option value="default">默认 · 温柔女声</option>{!['default', ...LOCAL_NEURAL_VOICES].includes(preset.speakerId) && <option value={preset.speakerId}>请选择自然声音</option>}{LOCAL_NEURAL_VOICES.map(voice => <option key={voice} value={voice}>{NEURAL_VOICE_LABELS[voice]}</option>)}
    </select></label> : <label className="speech-setting-field">系统声音名称<input aria-label={`预设 ${index + 1} 系统声音名称`} maxLength={256} value={preset.speakerId} disabled={busy} onChange={event => onChange({ speakerId: event.target.value })} placeholder="default 自动选择中文声音，如 Tingting" /></label>}
    {!neural && <label className="speech-setting-field">语速 · {preset.speechRate}<input aria-label={`预设 ${index + 1} 语速`} type="range" min={-50} max={100} step={1} value={preset.speechRate} disabled={busy} onChange={event => onChange({ speechRate: Number(event.target.value) })} /></label>}
    <div className="speech-setting-actions"><button type="button" disabled={busy || dirty} onClick={onTest}>试听此预设</button><span className="speech-preset-status" role="status">{dirty ? '先保存语音设置，再试听此预设。' : trialLabel}</span></div>
  </article>;
}

export function SpeechDiagnosticsSummary({ diagnostics, latency, refreshing, onRefresh }: { diagnostics: SpeechDiagnostics | undefined; latency?: VoiceLatencyDiagnostics | undefined; refreshing: boolean; onRefresh(): void }) {
  const timing = (value: Pick<SpeechDiagnostics['asr'], 'samples' | 'meanMs' | 'p95Ms'>) => value.samples
    ? `平均 ${Math.round(value.meanMs)} ms · P95 ${Math.round(value.p95Ms)} ms（${value.samples} 次）`
    : '尚无请求耗时样本';
  return <section className="settings-section-card speech-diagnostics-section"><details><summary>本次启动统计</summary>
    <p>仅保留本次启动的次数和用量，重启后归零。平均与 P95 耗时取最近 100 次请求尝试，可手动刷新查看最新统计。</p>
    {diagnostics ? <>
      <dl className="speech-diagnostics-grid">
        <dt>语音识别请求</dt><dd>{diagnostics.asr.requests} 次 · 成功 {diagnostics.asr.completed} · 失败 {diagnostics.asr.failed} · 取消 {diagnostics.asr.cancelled}</dd>
        <dt>识别音频时长</dt><dd>{(diagnostics.asr.audioMs / 1_000).toFixed(1)} 秒</dd>
        <dt>识别请求总耗时</dt><dd>{timing(diagnostics.asr)}</dd>
        <dt>语音合成请求</dt><dd>{diagnostics.tts.requests} 次 · 成功 {diagnostics.tts.completed} · 失败 {diagnostics.tts.failed} · 取消 {diagnostics.tts.cancelled}</dd>
        <dt>合成请求字符</dt><dd>{diagnostics.tts.requestedChars}</dd>
        <dt>合成音频大小</dt><dd>{(diagnostics.tts.audioBytes / 1_024).toFixed(1)} KiB</dd>
        <dt>合成缓存命中</dt><dd>{diagnostics.tts.cacheHits} 次</dd>
        <dt>合成请求总耗时</dt><dd>{timing(diagnostics.tts)}</dd>
      </dl>
      <p>识别请求耗时包含录音与本地处理时间，不代表结束说话到转写完成的延迟。合成请求耗时不代表首音播放延迟。</p>
    </> : <p role="status">统计暂不可用。</p>}
    {latency && <dl className="speech-diagnostics-grid">{Object.entries(latency.metrics).map(([key, value]) => <React.Fragment key={key}>
      <dt>{{ asrFinalMs: '结束录音到转写完成', llmTtftMs: '模型首个文本', firstSpeakableMs: '首个可朗读短句', ttsFirstPcmMs: '合成首个 PCM', playbackStartMs: 'PCM 到开始播放', recordToPlaybackMs: '结束录音到开始播放', stopMs: '停止播放' }[key] ?? key}</dt>
      <dd>P50 {Math.round(value.p50Ms)} ms · P95 {Math.round(value.p95Ms)} ms（{value.samples} 次）</dd>
    </React.Fragment>)}</dl>}
    <div className="speech-setting-actions"><button type="button" disabled={refreshing} onClick={onRefresh}>{refreshing ? '正在刷新…' : '刷新统计'}</button></div>
  </details></section>;
}

export function SpeechSettingsPage({ api, onSaved }: { api: DesktopApi; onSaved: (settings: SpeechSettings) => void }) {
  const [snapshot, setSnapshot] = useState<SpeechSettingsSnapshot | undefined>();
  const [draft, setDraft] = useState<SpeechSettings>(createLocalSpeechSettings);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [presetTrials, setPresetTrials] = useState<Record<string, PresetTrial>>({});
  const [testingPreset, setTestingPreset] = useState<string | undefined>();
  const [testingVoice, setTestingVoice] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheNotice, setCacheNotice] = useState('');
  const [diagnostics, setDiagnostics] = useState<SpeechDiagnostics | undefined>();
  const [latency, setLatency] = useState<VoiceLatencyDiagnostics | undefined>();
  const [voiceModels, setVoiceModels] = useState<Array<{ value: string; label: string }>>([]);
  useEffect(() => { void api.getSettings().then(value => setVoiceModels(value.providers.flatMap(provider => provider.models.map(model => ({ value: JSON.stringify({ providerId: provider.id, model: model.id }), label: `${provider.name} · ${model.id}` }))))).catch(() => undefined); }, [api]);
  const [refreshingDiagnostics, setRefreshingDiagnostics] = useState(false);
  const live = useRef(true);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const status = useSpeechStatus(api);
  const dirty = Boolean(snapshot && JSON.stringify(snapshot.settings) !== JSON.stringify(draft));
  const playing = activeSpeechPlayback(status.playbacks);
  const presetSignature = JSON.stringify(snapshot?.settings);
  const refreshDevices = async () => {
    try { setDevices((await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput')); } catch { setDevices([]); }
  };
  useEffect(() => {
    live.current = true;
    void api.getSpeechSettings().then(value => { if (live.current) { setSnapshot(value); setDraft(value.settings); onSavedRef.current(value.settings); } }).catch(cause => { if (live.current) setError(String(cause)); });
    void refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => { live.current = false; navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices); };
  }, [api]);

  const save = async (settings = draft) => {
    setBusy(true); setError('');
    try {
      const value = await api.saveSpeechSettings({ settings });
      setSnapshot(value); setDraft(value.settings); setPresetTrials({}); onSaved(value.settings);
      return value;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return undefined; }
    finally { setBusy(false); }
  };
  const previewVoice = async () => {
    if (busy || testingVoice || testingPreset || clearingCache) return;
    setTestingVoice(true); setError('');
    try {
      if (dirty && !await save()) return;
      await api.testSpeechSettings({ generation: nextSpeechGeneration() });
    } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (live.current) setTestingVoice(false); }
  };
  const testPreset = async (presetId: string) => {
    if (dirty || testingPreset || busy || testingVoice || clearingCache) return;
    const signature = presetSignature;
    setTestingPreset(presetId); setError('');
    setPresetTrials(current => ({ ...current, [presetId]: { signature } }));
    try {
      const result = await api.testSpeechSettings({ generation: nextSpeechGeneration(), presetId });
      if (live.current) setPresetTrials(current => ({ ...current, [presetId]: { signature, playbackId: result.playbackId } }));
    } catch (cause) {
      if (live.current) setPresetTrials(current => ({ ...current, [presetId]: { signature, error: cause instanceof Error ? cause.message : String(cause) } }));
    } finally { if (live.current) setTestingPreset(undefined); }
  };
  const clearCache = async () => {
    setClearingCache(true); setCacheNotice(''); setError('');
    try { await api.clearSpeechCache(); if (live.current) { setCacheNotice('本机语音缓存已清除。'); setPresetTrials({}); } }
    catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (live.current) setClearingCache(false); }
  };
  const refreshDiagnostics = async () => {
    setRefreshingDiagnostics(true);
    try { const value = await api.getSpeechStatus(); if (live.current) { setDiagnostics(value.diagnostics); setLatency(value.latency); } }
    catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (live.current) setRefreshingDiagnostics(false); }
  };

  if (!snapshot) return <form className="settings-content model-settings-page speech-settings-page" aria-labelledby="speech-settings-title" aria-busy="true" onSubmit={event => event.preventDefault()}>
    <div className="settings-heading"><div><h1 id="speech-settings-title">语音</h1><p>在本机完成转写和朗读，选择适合你的声音。</p></div></div>
    {error ? <div className="settings-error" role="alert">{error}</div> : <p role="status">正在读取语音设置…</p>}
  </form>;

  return <form className="settings-content model-settings-page speech-settings-page" aria-labelledby="speech-settings-title" onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="settings-heading"><div><h1 id="speech-settings-title">语音</h1><p>在本机完成转写和朗读，选择适合你的声音。</p></div><span className={`browser-status-pill ${snapshot?.settings.enabled ? 'on' : ''}`}>{snapshot?.settings.enabled ? '已开启' : '已关闭'}</span></div>
    <section className="settings-section-card speech-privacy"><h2>录音与播报</h2><p>转写与朗读均在本机完成。原始录音不会保存。生成的声音为 AI 合成语音。连续对话需在输入框旁主动开启，可随时静音或结束。</p></section>
    {error && <div className="settings-error" role="alert">{error}</div>}
    <section className="settings-section-card speech-provider-section"><h2>语音服务</h2>
      <label className="speech-setting-field">转写服务<input aria-label="转写服务" readOnly value={draft.streamingInput?.enabled ? 'Paraformer · 本地实时识别' : 'SenseVoice · 本地识别'} /></label>
      <label className="speech-setting-field">朗读服务<input aria-label="朗读服务" readOnly value={draft.provider.tts.id === 'mlx-qwen3' ? 'Qwen3 · 本机自然声音' : 'Mac 系统朗读'} /></label>
      {!draft.streamingInput?.enabled && <><label className="speech-setting-field">模型目录<input aria-label="SenseVoice 模型目录" value={draft.provider.asr.local.modelDirectory} onChange={event => setDraft({ ...draft, provider: { ...draft.provider, asr: { ...draft.provider.asr, local: { ...draft.provider.asr.local, modelDirectory: event.target.value } } } })} placeholder="包含 model.int8.onnx 和 tokens.txt 的目录" /></label>
      <div className="speech-setting-actions"><button type="button" disabled={busy} onClick={() => { void api.chooseDirectory().then(directory => { if (directory) setDraft(current => ({ ...current, provider: { ...current.provider, asr: { ...current.provider.asr, local: { ...current.provider.asr.local, modelDirectory: directory } } } })); }).catch(cause => setError(String(cause))); }}>选择模型目录</button></div></>}
      <label className="speech-setting-field">Python 路径<input aria-label="本地语音 Python 路径" value={draft.provider.asr.local.pythonPath} onChange={event => setDraft({ ...draft, provider: { ...draft.provider, asr: { ...draft.provider.asr, local: { ...draft.provider.asr.local, pythonPath: event.target.value } } } })} placeholder="已安装 sherpa-onnx 的 Python 可执行文件" /></label>
      {!draft.streamingInput?.enabled && <label className="speech-setting-field">识别语言<select aria-label="本地识别语言" value={draft.provider.asr.local.language} onChange={event => setDraft({ ...draft, provider: { ...draft.provider, asr: { ...draft.provider.asr, local: { ...draft.provider.asr.local, language: event.target.value as SpeechSettings['provider']['asr']['local']['language'] } } } })}><option value="auto">自动识别</option><option value="zh">普通话</option><option value="yue">粤语</option><option value="en">英语</option><option value="ja">日语</option><option value="ko">韩语</option></select></label>}
      <p>{draft.streamingInput?.enabled ? '在下方填写实时模型路径。当前 Paraformer 支持普通话与英语，录音时显示实时字幕。' : '首次使用需安装本地模型和 sherpa-onnx。可在项目目录执行 pnpm speech:setup，完成后填写其输出的路径。结束录音后返回最终文字。'}</p>
      <p>系统声音可直接使用；自然声音需要先安装本地模型，安装后可离线朗读。</p>
    </section>
    <section className="settings-section-card" aria-label="实时转写设置"><h2>实时转写（实验）</h2>
      <label className="speech-setting-field">输入引擎<select aria-label="语音输入引擎" value={draft.streamingInput?.enabled ? 'streaming' : 'sensevoice'} onChange={event => setDraft({ ...draft, streamingInput: { vadModel: '', paraformerDirectory: '', ...draft.streamingInput, enabled: event.target.value === 'streaming' } })}><option value="sensevoice">SenseVoice · 结束录音后转写</option><option value="streaming">Paraformer + Silero · 常驻本地实时转写</option></select></label>
      {draft.streamingInput?.enabled && <>
        <label className="speech-setting-field">Silero VAD 模型<input aria-label="Silero VAD 模型路径" value={draft.streamingInput.vadModel} onChange={event => setDraft({ ...draft, streamingInput: { ...draft.streamingInput!, vadModel: event.target.value } })} placeholder="silero_vad.onnx 的绝对路径" /></label>
        <label className="speech-setting-field">Paraformer 模型目录<input aria-label="Paraformer 模型目录" value={draft.streamingInput.paraformerDirectory} onChange={event => setDraft({ ...draft, streamingInput: { ...draft.streamingInput!, paraformerDirectory: event.target.value } })} placeholder="包含 encoder、decoder 与 tokens.txt 的目录" /></label>
        <label className="speech-setting-field">Smart Turn 模型（可选）<input aria-label="Smart Turn 模型路径" value={draft.streamingInput.smartTurnModel ?? ''} onChange={event => setDraft({ ...draft, streamingInput: { ...draft.streamingInput!, smartTurnModel: event.target.value } })} placeholder="本地 ONNX 模型的绝对路径" /></label>
        <label className="speech-setting-field">结束录音<select aria-label="自动结束录音" value={draft.streamingInput.autoEndpoint ? 'automatic' : 'manual'} onChange={event => setDraft({ ...draft, streamingInput: { ...draft.streamingInput!, autoEndpoint: event.target.value === 'automatic' } })}><option value="manual">手动点击结束（默认）</option><option value="automatic">实验：停顿后自动结束</option></select></label>
        {draft.streamingInput.autoEndpoint && <label className="speech-setting-field">未说完时最长等待（毫秒）<input aria-label="自动结束等待时长" type="number" min={500} max={10000} step={100} value={draft.streamingInput.fallbackTimeoutMs ?? 3000} onChange={event => setDraft({ ...draft, streamingInput: { ...draft.streamingInput!, fallbackTimeoutMs: Number(event.target.value) } })} /></label>}
        <p>使用上方 Python 环境。模型在主动录音时加载，后续录音复用进程。修改后保存即可生效，缺少模型时会显示不可用。自动结束需配置 Smart Turn 模型与依赖，可随时手动结束；转写后是否自动发送由下方偏好决定。</p>
      </>}
    </section>
    <section className="settings-section-card"><h2>输入与声音</h2>
      <label className="speech-setting-field">输入设备<select aria-label="语音输入设备" value={draft.inputDeviceId ?? ''} onChange={event => { const next = { ...draft }; if (event.target.value) next.inputDeviceId = event.target.value; else delete next.inputDeviceId; setDraft(next); }}><option value="">系统默认麦克风</option>{devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `麦克风 ${index + 1}`}</option>)}</select></label>
      <label className="speech-setting-field">朗读方式<select aria-label="朗读方式" value={draft.provider.tts.id} onChange={event => setDraft(changeSpeechEngine(draft, event.target.value as SpeechSettings['provider']['tts']['id']))}><option value="macos">系统声音 · 快速</option><option value="mlx-qwen3">自然声音 · 本机离线</option></select></label>
      {draft.provider.tts.id === 'mlx-qwen3' ? <>
        <label className="speech-setting-field">声音<select aria-label="默认声音" value={draft.provider.tts.speakerId} onChange={event => setDraft({ ...draft, provider: { ...draft.provider, tts: { ...draft.provider.tts, speakerId: event.target.value } } })}><option value="default">默认 · 温柔女声</option>{LOCAL_NEURAL_VOICES.map(voice => <option key={voice} value={voice}>{NEURAL_VOICE_LABELS[voice]}</option>)}</select></label>
        <p>自然声音使用原始语速。首次朗读需要加载模型，之后会保留在内存中供后续对话使用。</p>
        <details><summary>本地模型位置</summary><p>首次安装：在项目目录执行 pnpm speech:setup:neural --download --install-runtime，再填写命令输出的路径。</p>
          <label className="speech-setting-field">运行环境<input aria-label="自然声音 Python 路径" value={draft.provider.tts.local?.pythonPath ?? ''} onChange={event => setDraft({ ...draft, provider: { ...draft.provider, tts: { ...draft.provider.tts, local: { modelDirectory: draft.provider.tts.local?.modelDirectory ?? '', pythonPath: event.target.value } } } })} /></label>
          <label className="speech-setting-field">模型位置<input aria-label="自然声音模型路径" value={draft.provider.tts.local?.modelDirectory ?? ''} onChange={event => setDraft({ ...draft, provider: { ...draft.provider, tts: { ...draft.provider.tts, local: { pythonPath: draft.provider.tts.local?.pythonPath ?? 'python3', modelDirectory: event.target.value } } } })} /></label>
        </details>
      </> : <>
        <label className="speech-setting-field">系统声音名称<input aria-label="默认声音" value={draft.provider.tts.speakerId} onChange={event => setDraft({ ...draft, provider: { ...draft.provider, tts: { ...draft.provider.tts, speakerId: event.target.value } } })} placeholder="default 自动选择中文声音，如 Tingting" /></label>
        <label className="speech-setting-field">语速 · {draft.provider.tts.speechRate}<input type="range" min={-50} max={100} step={1} value={draft.provider.tts.speechRate} onChange={event => setDraft({ ...draft, provider: { ...draft.provider, tts: { ...draft.provider.tts, speechRate: Number(event.target.value) } } })} /></label>
      </>}
      <label className="speech-setting-field">播放音量 · {Math.round(draft.playback.volume * 100)}%<input type="range" min={0} max={1} step={0.05} value={draft.playback.volume} onChange={event => setDraft({ ...draft, playback: { ...draft.playback, volume: Number(event.target.value) } })} /></label>
      <div className="speech-setting-actions"><button type="button" disabled={busy || testingVoice || Boolean(testingPreset) || clearingCache || Boolean(playing)} onClick={() => void previewVoice()}>{testingVoice ? '正在准备声音…' : '试听声音'}</button>
        {playing && <button type="button" onClick={() => void api.stopSpeechPlayback({ playbackId: playing.playbackId })}>停止试听</button>}
      </div>
    </section>
    <section className="settings-section-card speech-presets-section"><h2>音色预设</h2><p>为不同自动化选择声音。切换朗读方式后，请为已有预设选择适用的声音。</p>
      <div className="speech-preset-list">{draft.voicePresets.map((preset, index) => <SpeechVoicePresetEditor
        key={preset.id} preset={preset} index={index} dirty={dirty} neural={draft.provider.tts.id === 'mlx-qwen3'} busy={busy || testingVoice || Boolean(testingPreset) || clearingCache}
        trialLabel={speechPresetTrialLabel(presetTrials[preset.id], presetSignature, status.playbacks)}
        onChange={patch => setDraft({ ...draft, voicePresets: draft.voicePresets.map(value => value.id === preset.id ? { ...value, ...patch } : value) })}
        onRemove={() => setDraft({ ...draft, voicePresets: draft.voicePresets.filter(value => value.id !== preset.id) })}
        onTest={() => void testPreset(preset.id)}
      />)}</div>
      <div className="speech-setting-actions"><button type="button" disabled={busy || Boolean(testingPreset) || draft.voicePresets.length >= 20} onClick={() => setDraft({ ...draft, voicePresets: [...draft.voicePresets, { id: `voice-${crypto.randomUUID()}`, name: `音色预设 ${draft.voicePresets.length + 1}`, speakerId: draft.provider.tts.speakerId, speechRate: draft.provider.tts.speechRate }] })}>添加音色预设</button><span className="speech-preset-status">{draft.voicePresets.length} / 20</span></div>
      {draft.voicePresets.length > 0 && <p>移除预设后，引用它的任务需要重新选择音色并保存。</p>}
    </section>
    <section className="settings-section-card"><h2>语音缓存</h2><p>清除本机生成的合成音频，正在朗读的声音会停止。下一次朗读或提醒会重新准备音频。</p><div className="speech-setting-actions"><button type="button" disabled={clearingCache || busy || Boolean(testingPreset)} onClick={() => void clearCache()}>{clearingCache ? '正在清除…' : '清除语音缓存'}</button>{cacheNotice && <span className="speech-preset-status" role="status">{cacheNotice}</span>}</div></section>
    <section className="settings-section-card speech-preferences-section"><h2>使用偏好</h2>
      <label className="speech-setting-check"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /><span>启用语音</span></label>
      <p>修改后保存即可生效。试听可按需使用。</p>
      <label className="speech-setting-field">转写后<select value={draft.inputMode} onChange={event => setDraft({ ...draft, inputMode: event.target.value as SpeechSettings['inputMode'] })}><option value="review">回填文字，校正后发送（默认）</option><option value="auto_send">自动发送最终文字</option></select></label>
      <label className="speech-setting-check"><input type="checkbox" checked={draft.autoReadReplies} onChange={event => setDraft({ ...draft, autoReadReplies: event.target.checked })} /><span>语音输入后自动朗读回复</span></label>
      <p>普通文字提问保持文字回复；需要出声时，可以明确要求朗读或点击消息下方的朗读按钮。</p>
      <label className="speech-setting-check"><input type="checkbox" checked={draft.realtimeReplies} onChange={event => setDraft({ ...draft, realtimeReplies: event.target.checked })} /><span>实验：语音提问后边生成边朗读</span></label>
      {draft.realtimeReplies && <p>需同时开启自动朗读。使用所选声音分段合成；连续对话在回复播放完后恢复收音，扬声器插话仍待实机验证。</p>}
      <label className="speech-setting-field">口语摘要模型（可选）<select value={draft.voiceResponseModel ? JSON.stringify(draft.voiceResponseModel) : ''} onChange={event => {
        const next = { ...draft }; if (event.target.value) next.voiceResponseModel = JSON.parse(event.target.value); else delete next.voiceResponseModel; setDraft(next);
      }}><option value="">直接使用当前回答</option>{voiceModels.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}</select></label>
      <p>可选择响应较快的已配置模型，为已完成的回答生成简短口语摘要。执行任务仍使用原模型；实验流式朗读直接使用原模型的口语输出。</p>
      <label className="speech-setting-check"><input type="checkbox" checked={draft.playback.muteWhenLocked} onChange={event => setDraft({ ...draft, playback: { ...draft.playback, muteWhenLocked: event.target.checked } })} /><span>屏幕锁定时保持安静</span></label>
      <label className="speech-setting-check"><input type="checkbox" checked={draft.backgroundRunning} onChange={event => setDraft({ ...draft, backgroundRunning: event.target.checked })} /><span>关闭窗口后继续运行（托盘）</span></label>
      <p>托盘提供打开窗口、停止朗读和退出入口。应用退出或设备休眠期间无法实时播报。</p>
      <label className="speech-setting-check"><input type="checkbox" checked={Boolean(draft.playback.quietHours)} onChange={event => {
        const playback = { ...draft.playback };
        if (event.target.checked) playback.quietHours = { start: '22:00', end: '08:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
        else delete playback.quietHours;
        setDraft({ ...draft, playback });
      }} /><span>启用静默时段</span></label>
      {draft.playback.quietHours && <>
        <label className="speech-setting-field">静默开始<input type="time" value={draft.playback.quietHours.start} onChange={event => setDraft({ ...draft, playback: { ...draft.playback, quietHours: { ...draft.playback.quietHours!, start: event.target.value } } })} /></label>
        <label className="speech-setting-field">静默结束<input type="time" value={draft.playback.quietHours.end} onChange={event => setDraft({ ...draft, playback: { ...draft.playback, quietHours: { ...draft.playback.quietHours!, end: event.target.value } } })} /></label>
        <label className="speech-setting-field">静默时区<input value={draft.playback.quietHours.timezone} onChange={event => setDraft({ ...draft, playback: { ...draft.playback, quietHours: { ...draft.playback.quietHours!, timezone: event.target.value } } })} /></label>
      </>}
    </section>
    <SpeechDiagnosticsSummary diagnostics={diagnostics ?? status.diagnostics} latency={latency ?? status.latency} refreshing={refreshingDiagnostics} onRefresh={() => void refreshDiagnostics()} />
    <div className="settings-actions"><span>{dirty ? '有尚未保存的修改。' : '所有设置已保存。'}</span><button className="primary" type="submit" disabled={busy || Boolean(testingPreset) || !snapshot || !dirty}>{busy ? '保存中…' : '保存语音设置'}</button></div>
  </form>;
}
