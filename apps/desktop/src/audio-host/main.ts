import { StreamingAudioPlayer } from './stream-player';
import { AudioHostPlayer } from './player';
import type { AudioHostBridge } from './ipc';
declare global { interface Window { jojoAudioHost: AudioHostBridge } }

const player = new AudioHostPlayer({
  createAudio: () => new Audio(),
  createUrl: (bytes, format) => URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: format === 'wav' ? 'audio/wav' : 'audio/mpeg' })),
  revokeUrl: (url) => URL.revokeObjectURL(url),
  acknowledge: (ack) => window.jojoAudioHost.acknowledge(ack)
});
const stream = new StreamingAudioPlayer({ createContext: () => new AudioContext(), acknowledge: ack => window.jojoAudioHost.acknowledge(ack) });
const unsubscribe = window.jojoAudioHost.onCommand(command => {
  if (command.type === 'play') { player.dispose(); stream.dispose(); }
  if (command.type === 'play' && !command.stream) player.receive(command);
  else if (command.type === 'stop') { player.receive(command); stream.receive(command); }
  else stream.receive(command);
});
navigator.mediaDevices?.addEventListener('devicechange', () => { player.outputDeviceChanged(); stream.outputDeviceChanged(); });
window.addEventListener('pagehide', () => { unsubscribe(); player.dispose(); stream.dispose(); }, { once: true });
window.jojoAudioHost.ready();
