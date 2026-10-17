import { contextBridge, ipcRenderer } from 'electron';
import { AUDIO_HOST_ACK, AUDIO_HOST_COMMAND, AUDIO_HOST_READY, isAudioHostAck, isAudioHostCommand,
  type AudioHostBridge } from '../audio-host/ipc';

const bridge: AudioHostBridge = {
  onCommand(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isAudioHostCommand(value)) listener(value);
    };
    ipcRenderer.on(AUDIO_HOST_COMMAND, receive);
    return () => ipcRenderer.removeListener(AUDIO_HOST_COMMAND, receive);
  },
  acknowledge(ack) { if (isAudioHostAck(ack)) ipcRenderer.send(AUDIO_HOST_ACK, ack); },
  ready() { ipcRenderer.send(AUDIO_HOST_READY); }
};
contextBridge.exposeInMainWorld('jojoAudioHost', bridge);
