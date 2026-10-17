import React, { useEffect, useRef, useState } from 'react';
import { createLocalSpeechSettings, type DesktopApi, type SpeechDiagnostics, type SpeechPlaybackState, type SpeechSettings, type SpeechSettingsSnapshot, type SpeechVoicePreset } from '@desktop-agent/contracts';
import { activeSpeechPlayback, nextSpeechGeneration, useSpeechCapture, useSpeechStatus } from './useSpeech';
import { VoiceComposer } from './VoiceComposer';

type PresetTrial = { signature: string; playbackId?: string; error?: string };

export function SpeechActivationPanel({ enabled, dirty, asrVerified, ttsVerified, busy, onEnable }: {
  enabled: boolean; dirty: boolean; asrVerified: boolean; ttsVerified: boolean; busy: boolean; onEnable(): void;
}) {
  if (enabled) return null;
  const pending = [!asrVerified && '转写测试', !ttsVerified && '试听测试'].filter(Boolean);
  return <section className="settings-section-card" aria-label="语音启用说明">
    <h2>语音尚未启用</h2>
    <p>安装模型后，还需要保存配置、完成转写和试听测试，再启用语音。启用后，输入框的麦克风会直接开始录音。</p>
    <p role="status">{dirty ? '请先保存当前修改，再确认转写和试听测试均已通过。' : pending.length ? `待完成：${pending.join('、')}。请在下方“显式验证”中测试。` : '转写和试听均已通过，可以启用语音。'}</p>
    <div className="speech-setting-actions"><button className="primary" type="button" disabled={busy || dirty || pending.length > 0} onClick={onEnable}>启用语音并保存</button></div>
  </section>;
}

export function speechPresetTrialLabel(trial: PresetTrial | undefined, signature: string, playbacks: SpeechPlaybackState[]): string {
  if (!trial || trial.signature !== signature) return '尚未试听此预设';
  if (trial.error) return `试听失败：${trial.error}`;
  if (!trial.playbackId) return '正在准备试听…';
  const playback = playbacks.find(value => value.playbackId === trial.playbackId);
  if (playback?.state === 'played') return '本次试听已完成';
  if (playback?.state === 'playing') return '正在试听…';
  if (playback?.state === 'failed') return `试听失败${playback.reason ? `：${playback.reason}` : ''}`;
  if (playback?.state === 'suppressed') return '本次试听已静音，尚未验证声音';
  if (playback?.state === 'interrupted') return '本次试听已停止';
  return '正在准备试听…';
}

export function SpeechVoicePresetEditor({ preset, index, dirty, busy, trialLabel, onChange, onRemove, onTest }: {
  preset: SpeechVoicePreset; index: number; dirty: boolean; busy: boolean;
  trialLabel: string;
  onChange(patch: Partial<SpeechVoicePreset>): void;
  onRemove(): void;
  onTest(): void;
}) {
  return <article className="speech-preset-card" aria-label={`音色预设 ${index + 1}`}>
    <div className="speech-preset-header"><strong>{preset.name || `预设 ${index + 1}`}</strong><button type="button" disabled={busy} onClick={onRemove} aria-label={`移除音色预设 ${index + 1}`}>移除</button></div>
    <label className="speech-setting-field">预设名称<input aria-label={`预设 ${index + 1} 名称`} maxLength={80} value={preset.name} disabled={busy} onChange={event => onChange({ name: event.target.value })} placeholder="例如：工作提醒" /></label>
    <label className="speech-setting-field">系统声音名称<input aria-label={`预设 ${index + 1} 系统声音名称`} maxLength={256} value={preset.speakerId} disabled={busy} onChange={event => onChange({ speakerId: event.target.value })} placeholder="default 自动选择中文声音，如 Tingting" /></label>
    <label className="speech-setting-field">语速 · {preset.speechRate}<input aria-label={`预设 ${index + 1} 语速`} type="range" min={-50} max={100} step={1} value={preset.speechRate} disabled={busy} onChange={event => onChange({ speechRate: Number(event.target.value) })} /></label>
    <div className="speech-setting-actions"><button type="button" disabled={busy || dirty} onClick={onTest}>试听此预设</button><span className="speech-preset-status" role="status">{dirty ? '先保存语音设置，再试听此预设。' : trialLabel}</span></div>
  </article>;
}

export function SpeechDiagnosticsSummary({ diagnostics, refreshing, onRefresh }: { diagnostics: SpeechDiagnostics | undefined; refreshing: boolean; onRefresh(): void }) {
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
    <div className="speech-setting-actions"><button type="button" disabled={refreshing} onClick={onRefresh}>{refreshing ? '正在刷新…' : '刷新统计'}</button></div>
  </details></section>;
}

export function SpeechSettingsPage({ api, onSaved }: { api: DesktopApi; onSaved: (settings: SpeechSettings) => void }) {
  const [snapshot, setSnapshot] = useState<SpeechSettingsSnapshot | undefined>();
  const [draft, setDraft] = useState<SpeechSettings>(createLocalSpeechSettings);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [transcript, setTranscript] = useState('');
  const [presetTrials, setPresetTrials] = useState<Record<string, PresetTrial>>({});
  const [testingPreset, setTestingPreset] = useState<string | undefined>();
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheNotice, setCacheNotice] = useState('');
  const [diagnostics, setDiagnostics] = useState<SpeechDiagnostics | undefined>();
  const [refreshingDiagnostics, setRefreshingDiagnostics] = useState(false);
  const live = useRef(true);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const status = useSpeechStatus(api);
  const capture = useSpeechCapture({ api, purpose: 'validation', ...(draft.inputDeviceId ? { inputDeviceId: draft.inputDeviceId } : {}), onFinal: event => { setTranscript(event.text ?? ''); void refreshDevices(); } });
  const dirty = Boolean(snapshot && JSON.stringify(snapshot.settings) !== JSON.stringify(draft));
  const verified = status.validation.asr && status.validation.tts && !dirty;
  const playing = activeSpeechPlayback(status.playbacks);
  const captureBusy = ['connecting', 'recording', 'recognizing'].includes(capture.state);
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
  const prepareTest = async () => dirty ? Boolean(await save({ ...draft, enabled: false })) : true;
  const testPreset = async (presetId: string) => {
    if (dirty || testingPreset || busy || captureBusy) return;
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
    try { const value = await api.getSpeechStatus(); if (live.current) setDiagnostics(value.diagnostics); }
    catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (live.current) setRefreshingDiagnostics(false); }
  };

  if (!snapshot) return <form className="settings-content model-settings-page speech-settings-page" aria-labelledby="speech-settings-title" aria-busy="true" onSubmit={event => event.preventDefault()}>
    <div className="settings-heading"><div><h1 id="speech-settings-title">语音</h1><p>在本机转写录音并使用 Mac 系统声音朗读。</p></div></div>
    {error ? <div className="settings-error" role="alert">{error}</div> : <p role="status">正在读取语音设置…</p>}
  </form>;

  return <form className="settings-content model-settings-page speech-settings-page" aria-labelledby="speech-settings-title" onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="settings-heading"><div><h1 id="speech-settings-title">语音</h1><p>在本机转写录音并使用 Mac 系统声音朗读。</p></div><span className={`browser-status-pill ${snapshot?.settings.enabled ? 'on' : ''}`}>{snapshot?.settings.enabled ? '已开启' : '已关闭'}</span></div>
    <SpeechActivationPanel enabled={snapshot.settings.enabled} dirty={dirty} asrVerified={status.validation.asr} ttsVerified={status.validation.tts}
      busy={busy || captureBusy || Boolean(testingPreset) || clearingCache} onEnable={() => void save({ ...draft, enabled: true })} />
    <section className="settings-section-card speech-privacy"><h2>录音与播报</h2><p>录音仅在本机由 SenseVoice 转写，朗读由 Mac 系统声音在本机合成。原始录音不会保存。生成的声音为 AI 合成语音。</p></section>
    {error && <div className="settings-error" role="alert">{error}</div>}
    <section className="settings-section-card speech-provider-section"><h2>语音服务</h2>
      <label className="speech-setting-field">转写服务<input aria-label="转写服务" readOnly value="SenseVoice · 本地识别" /></label>
      <label className="speech-setting-field">朗读服务<input aria-label="朗读服务" readOnly value="Mac 系统朗读" /></label>
      <label className="speech-setting-field">模型目录<input aria-label="SenseVoice 模型目录" value={draft.provider.asr.local.modelDirectory} onChange={event => setDraft({ ...draft, provider: { ...draft.provider, asr: { ...draft.provider.asr, local: { ...draft.provider.asr.local, modelDirectory: event.target.value } } } })} placeholder="包含 model.int8.onnx 和 tokens.txt 的目录" /></label>
      <div className="speech-setting-actions"><button type="button" disabled={busy || captureBusy} onClick={() => { void api.chooseDirectory().then(directory => { if (directory) setDraft(current => ({ ...current, provider: { ...current.provider, asr: { ...current.provider.asr, local: { ...current.provider.asr.local, modelDirectory: directory } } } })); }).catch(cause => setError(String(cause))); }}>选择模型目录</button></div>
      <label className="speech-setting-field">Python 路径<input aria-label="本地语音 Python 路径" value={draft.provider.asr.local.pythonPath} onChange={event => setDraft({ ...draft, provider: { ...draft.provider, asr: { ...draft.provider.asr, local: { ...draft.provider.asr.local, pythonPath: event.target.value } } } })} placeholder="已安装 sherpa-onnx 的 Python 可执行文件" /></label>
      <label className="speech-setting-field">识别语言<select aria-label="本地识别语言" value={draft.provider.asr.local.language} onChange={event => setDraft({ ...draft, provider: { ...draft.provider, asr: { ...draft.provider.asr, local: { ...draft.provider.asr.local, language: event.target.value as SpeechSettings['provider']['asr']['local']['language'] } } } })}><option value="auto">自动识别</option><option value="zh">普通话</option><option value="yue">粤语</option><option value="en">英语</option><option value="ja">日语</option><option value="ko">韩语</option></select></label>
      <p>首次使用需安装本地模型和 sherpa-onnx。可在项目目录执行 pnpm speech:setup，完成后填写其输出的路径。结束录音后返回最终文字。</p>
      <p>朗读仅支持 macOS。default 会选择已安装的中文声音；可在系统设置的辅助功能中下载更多声音，下载后离线使用。</p>
    </section>
    <section className="settings-section-card"><h2>输入与声音</h2>
      <label className="speech-setting-field">输入设备<select aria-label="语音输入设备" value={draft.inputDeviceId ?? ''} onChange={event => { const next = { ...draft }; if (event.target.value) next.inputDeviceId = event.target.value; else delete next.inputDeviceId; setDraft(next); }}><option value="">系统默认麦克风</option>{devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `麦克风 ${index + 1}`}</option>)}</select></label>
      <label className="speech-setting-field">系统声音名称<input aria-label="默认声音" value={draft.provider.tts.speakerId} onChange={event => setDraft({ ...draft, provider: { ...draft.provider, tts: { ...draft.provider.tts, speakerId: event.target.value } } })} placeholder="default 自动选择中文声音，如 Tingting" /></label>
      <label className="speech-setting-field">语速 · {draft.provider.tts.speechRate}<input type="range" min={-50} max={100} step={1} value={draft.provider.tts.speechRate} onChange={event => setDraft({ ...draft, provider: { ...draft.provider, tts: { ...draft.provider.tts, speechRate: Number(event.target.value) } } })} /></label>
      <label className="speech-setting-field">播放音量 · {Math.round(draft.playback.volume * 100)}%<input type="range" min={0} max={1} step={0.05} value={draft.playback.volume} onChange={event => setDraft({ ...draft, playback: { ...draft.playback, volume: Number(event.target.value) } })} /></label>
    </section>
    <section className="settings-section-card speech-presets-section"><h2>音色预设</h2><p>为不同自动化选择名称、音色和语速。预设使用本机已安装的系统声音。</p>
      <div className="speech-preset-list">{draft.voicePresets.map((preset, index) => <SpeechVoicePresetEditor
        key={preset.id} preset={preset} index={index} dirty={dirty} busy={busy || captureBusy || Boolean(testingPreset) || clearingCache}
        trialLabel={speechPresetTrialLabel(presetTrials[preset.id], presetSignature, status.playbacks)}
        onChange={patch => setDraft({ ...draft, voicePresets: draft.voicePresets.map(value => value.id === preset.id ? { ...value, ...patch } : value) })}
        onRemove={() => setDraft({ ...draft, voicePresets: draft.voicePresets.filter(value => value.id !== preset.id) })}
        onTest={() => void testPreset(preset.id)}
      />)}</div>
      <div className="speech-setting-actions"><button type="button" disabled={busy || Boolean(testingPreset) || draft.voicePresets.length >= 20} onClick={() => setDraft({ ...draft, voicePresets: [...draft.voicePresets, { id: `voice-${crypto.randomUUID()}`, name: `音色预设 ${draft.voicePresets.length + 1}`, speakerId: draft.provider.tts.speakerId, speechRate: draft.provider.tts.speechRate }] })}>添加音色预设</button><span className="speech-preset-status">{draft.voicePresets.length} / 20</span></div>
      {draft.voicePresets.length > 0 && <p>移除预设后，引用它的任务需要重新选择音色并保存。预设试听结果只适用于本次试听，不替代默认声音的合成验证。</p>}
    </section>
    <section className="settings-section-card speech-validation-section"><h2>显式验证</h2><p>先保存配置，再主动录音转写和试听。两项测试均在本机完成。两项通过后才能启用。</p>
      <div className="speech-validation-summary"><span className={status.validation.asr && !dirty ? 'passed' : ''}>转写：{status.validation.asr && !dirty ? '已通过' : '待验证'}</span><span className={status.validation.tts && !dirty ? 'passed' : ''}>合成：{status.validation.tts && !dirty ? '已通过' : '待验证'}</span></div>
      <VoiceComposer enabled={true} disabled={busy || dirty} capture={capture} inputMode="review" showInputMode={false} idleLabel="测试转写" onInputMode={() => undefined} onSettings={() => setError('请先保存当前语音配置。')}>
        <button type="button" disabled={busy || captureBusy || Boolean(testingPreset)} onClick={() => { void (async () => { if (!await prepareTest()) return; setError(''); try { await api.testSpeechSettings({ generation: nextSpeechGeneration() }); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } })(); }}>{dirty ? '保存并试听' : '试听 AI 合成语音'}</button>
        {playing && <button type="button" onClick={() => void api.stopSpeechPlayback({ playbackId: playing.playbackId })}>停止试听</button>}
      </VoiceComposer>
      {transcript && <div className="speech-test-transcript"><strong>识别结果</strong><p>{transcript}</p></div>}
    </section>
    <section className="settings-section-card"><h2>语音缓存</h2><p>清除本机生成的合成音频，正在朗读的声音会停止。下一次朗读或提醒会重新准备音频。</p><div className="speech-setting-actions"><button type="button" disabled={clearingCache || busy || Boolean(testingPreset)} onClick={() => void clearCache()}>{clearingCache ? '正在清除…' : '清除语音缓存'}</button>{cacheNotice && <span className="speech-preset-status" role="status">{cacheNotice}</span>}</div></section>
    <section className="settings-section-card speech-preferences-section"><h2>使用偏好</h2>
      <label className="speech-setting-check"><input type="checkbox" checked={draft.enabled} disabled={!verified && !draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /><span>启用语音</span></label>
      <label className="speech-setting-field">转写后<select value={draft.inputMode} onChange={event => setDraft({ ...draft, inputMode: event.target.value as SpeechSettings['inputMode'] })}><option value="review">回填文字，校正后发送（默认）</option><option value="auto_send">自动发送最终文字</option></select></label>
      <label className="speech-setting-check"><input type="checkbox" checked={draft.autoReadReplies} onChange={event => setDraft({ ...draft, autoReadReplies: event.target.checked })} /><span>自动朗读已完成的助手回复</span></label>
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
    <SpeechDiagnosticsSummary diagnostics={diagnostics ?? status.diagnostics} refreshing={refreshingDiagnostics} onRefresh={() => void refreshDiagnostics()} />
    <div className="settings-actions"><span>{dirty ? '有尚未保存的修改。' : '所有设置已保存。'}</span><button className="primary" type="submit" disabled={busy || Boolean(testingPreset) || !snapshot || !dirty}>{busy ? '保存中…' : '保存语音设置'}</button></div>
  </form>;
}
