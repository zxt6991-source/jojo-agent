import { AudioHostPlayer } from './player';
import type { AudioHostBridge } from './ipc';
declare global { interface Window { jojoAudioHost: AudioHostBridge } }

const player = new AudioHostPlayer({
  createAudio: () => new Audio(),
  createUrl: (bytes, format) => URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: format === 'wav' ? 'audio/wav' : 'audio/mpeg' })),
  revokeUrl: (url) => URL.revokeObjectURL(url),
  acknowledge: (ack) => window.jojoAudioHost.acknowledge(ack)
});
const unsubscribe = window.jojoAudioHost.onCommand((command) => player.receive(command));
navigator.mediaDevices?.addEventListener('devicechange', () => player.outputDeviceChanged());
window.addEventListener('pagehide', () => { unsubscribe(); player.dispose(); }, { once: true });
window.jojoAudioHost.ready();
