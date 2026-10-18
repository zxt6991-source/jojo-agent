import { ipcRenderer } from 'electron';
import { APPLICATION_OPERATIONS } from '@desktop-agent/contracts/application/operations';
import { IPC, SpeechCaptureHandleSchema, SpeechEventSchema, type DesktopApi } from '@desktop-agent/contracts';
import { VoiceOutputHandleSchema } from '@desktop-agent/contracts';

ipcRenderer.on(IPC.voiceOutputPort, (event, raw: unknown) => {
  const parsed = VoiceOutputHandleSchema.safeParse(raw);
  if (!parsed.success || event.ports.length !== 1) { event.ports.forEach(port => port.close()); return; }
  window.postMessage({ type: 'jojo.voice.output.port', handle: parsed.data }, '*', event.ports);
});

ipcRenderer.on(IPC.speechCapturePort, (event, raw: unknown) => {
  const parsed = SpeechCaptureHandleSchema.safeParse(raw);
  if (!parsed.success || event.ports.length !== 1) { event.ports.forEach(port => port.close()); return; }
  // DOM MessagePorts cannot be returned through contextBridge. Transfer the port
  // from this private preload event directly to the isolated application's page.
  window.postMessage({ type: 'jojo.speech.capture.port', handle: parsed.data }, '*', event.ports);
});

export const speechPreload: Pick<DesktopApi, 'beginSpeechCapture' | 'attachSpeechCapture' | 'cancelSpeechCapture'
  | 'attachVoiceOutput'
  | 'commitVoiceTurn' | 'readSpeechMessage' | 'readApprovalSpeech' | 'previewScheduleVoice' | 'getScheduleVoicePreparation' | 'clearSpeechCache'
  | 'testSpeechSettings' | 'stopSpeechPlayback' | 'getSpeechStatus' | 'onSpeechEvent'> = {
  beginSpeechCapture: async input => APPLICATION_OPERATIONS['speech.capture.begin'].output.parse(
    await ipcRenderer.invoke(IPC.beginSpeechCapture, APPLICATION_OPERATIONS['speech.capture.begin'].input.parse(input))),
  attachSpeechCapture: async input => { await ipcRenderer.invoke(IPC.attachSpeechCapture,
    APPLICATION_OPERATIONS['speech.capture.attach'].input.parse(input)); },
  attachVoiceOutput: async input => { await ipcRenderer.invoke(IPC.attachVoiceOutput,
    APPLICATION_OPERATIONS['speech.output.attach'].input.parse(input)); },
  cancelSpeechCapture: async input => { await ipcRenderer.invoke(IPC.cancelSpeechCapture,
    APPLICATION_OPERATIONS['speech.capture.cancel'].input.parse(input)); },
  commitVoiceTurn: async input => APPLICATION_OPERATIONS['voice.commit'].output.parse(
    await ipcRenderer.invoke(IPC.commitVoiceTurn, APPLICATION_OPERATIONS['voice.commit'].input.parse(input))),
  readSpeechMessage: async input => {
    try { return APPLICATION_OPERATIONS['speech.readMessage'].output.parse(
      await ipcRenderer.invoke(IPC.readSpeechMessage, APPLICATION_OPERATIONS['speech.readMessage'].input.parse(input))); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : '朗读未完成，请重试。';
      throw new Error(message.replace(/^Error invoking remote method 'speech:read-message': (?:Error: )?/u, ''));
    }
  },
  readApprovalSpeech: async input => APPLICATION_OPERATIONS['speech.readApproval'].output.parse(
    await ipcRenderer.invoke(IPC.readApprovalSpeech, APPLICATION_OPERATIONS['speech.readApproval'].input.parse(input))),
  previewScheduleVoice: async input => APPLICATION_OPERATIONS['speech.previewSchedule'].output.parse(
    await ipcRenderer.invoke(IPC.previewScheduleVoice, APPLICATION_OPERATIONS['speech.previewSchedule'].input.parse(input))),
  getScheduleVoicePreparation: async input => APPLICATION_OPERATIONS['speech.schedulePreparation'].output.parse(
    await ipcRenderer.invoke(IPC.getScheduleVoicePreparation, APPLICATION_OPERATIONS['speech.schedulePreparation'].input.parse(input))),
  clearSpeechCache: async () => { await ipcRenderer.invoke(IPC.clearSpeechCache, APPLICATION_OPERATIONS['speech.cache.clear'].input.parse({})); },
  testSpeechSettings: async input => APPLICATION_OPERATIONS['speech.settings.test'].output.parse(
    await ipcRenderer.invoke(IPC.testSpeechSettings, APPLICATION_OPERATIONS['speech.settings.test'].input.parse(input))),
  stopSpeechPlayback: async input => { await ipcRenderer.invoke(IPC.stopSpeechPlayback,
    APPLICATION_OPERATIONS['speech.playback.stop'].input.parse(input)); },
  getSpeechStatus: async () => APPLICATION_OPERATIONS['speech.status'].output.parse(await ipcRenderer.invoke(IPC.getSpeechStatus)),
  onSpeechEvent: listener => {
    const receive = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const parsed = SpeechEventSchema.safeParse(raw);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(IPC.speechEvent, receive);
    return () => ipcRenderer.removeListener(IPC.speechEvent, receive);
  }
};
