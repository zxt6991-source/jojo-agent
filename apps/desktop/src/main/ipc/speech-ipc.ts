import { IPC } from '@desktop-agent/contracts';
import { APPLICATION_OPERATIONS } from '@desktop-agent/contracts/application/operations';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { createSpeechSettingsController, type SpeechSettingsContext } from '../speech-settings';
import type { DesktopSpeechHost } from '../speech-host';

interface Context extends SpeechSettingsContext {
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  speechHost?: DesktopSpeechHost | undefined;
}

export function registerSpeechIpc(ctx: Context): void {
  const controller = createSpeechSettingsController(ctx);
  ipcMain.handle(IPC.getSpeechSettings, async (event, raw) => {
    ctx.assertTrusted(event); APPLICATION_OPERATIONS['speech.settings.get'].input.parse(raw ?? {}); return controller.get();
  });
  ipcMain.handle(IPC.saveSpeechSettings, async (event, raw) => {
    ctx.assertTrusted(event); return controller.save(APPLICATION_OPERATIONS['speech.settings.save'].input.parse(raw));
  });
  const host = () => { if (!ctx.speechHost) throw new Error('语音桌面服务尚未就绪。'); return ctx.speechHost; };
  ipcMain.handle(IPC.beginSpeechCapture, async (event, raw) => {
    ctx.assertTrusted(event); return host().begin(APPLICATION_OPERATIONS['speech.capture.begin'].input.parse(raw));
  });
  ipcMain.handle(IPC.attachSpeechCapture, async (event, raw) => {
    ctx.assertTrusted(event); host().attach(APPLICATION_OPERATIONS['speech.capture.attach'].input.parse(raw));
  });
  ipcMain.handle(IPC.cancelSpeechCapture, async (event, raw) => {
    ctx.assertTrusted(event); await host().cancel(APPLICATION_OPERATIONS['speech.capture.cancel'].input.parse(raw));
  });
  ipcMain.handle(IPC.commitVoiceTurn, async (event, raw) => {
    ctx.assertTrusted(event); return host().commit(APPLICATION_OPERATIONS['voice.commit'].input.parse(raw));
  });
  ipcMain.handle(IPC.readSpeechMessage, async (event, raw) => {
    ctx.assertTrusted(event); return host().read(APPLICATION_OPERATIONS['speech.readMessage'].input.parse(raw));
  });
  ipcMain.handle(IPC.testSpeechSettings, async (event, raw) => {
    ctx.assertTrusted(event); return host().test(APPLICATION_OPERATIONS['speech.settings.test'].input.parse(raw));
  });
  ipcMain.handle(IPC.readApprovalSpeech, async (event, raw) => {
    ctx.assertTrusted(event); return host().readApproval(APPLICATION_OPERATIONS['speech.readApproval'].input.parse(raw));
  });
  ipcMain.handle(IPC.previewScheduleVoice, async (event, raw) => {
    ctx.assertTrusted(event); return host().previewSchedule(APPLICATION_OPERATIONS['speech.previewSchedule'].input.parse(raw));
  });
  ipcMain.handle(IPC.getScheduleVoicePreparation, async (event, raw) => {
    ctx.assertTrusted(event); return host().schedulePreparation(APPLICATION_OPERATIONS['speech.schedulePreparation'].input.parse(raw));
  });
  ipcMain.handle(IPC.clearSpeechCache, async (event, raw) => {
    ctx.assertTrusted(event); APPLICATION_OPERATIONS['speech.cache.clear'].input.parse(raw ?? {}); await host().clearCache();
  });
  ipcMain.handle(IPC.stopSpeechPlayback, async (event, raw) => {
    ctx.assertTrusted(event); host().stop(APPLICATION_OPERATIONS['speech.playback.stop'].input.parse(raw));
  });
  ipcMain.handle(IPC.getSpeechStatus, async (event, raw) => {
    ctx.assertTrusted(event); APPLICATION_OPERATIONS['speech.status'].input.parse(raw ?? {}); return host().status();
  });
}
