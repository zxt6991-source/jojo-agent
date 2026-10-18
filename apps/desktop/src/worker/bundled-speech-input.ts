import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SpeechSettings } from '@desktop-agent/contracts';
import main from './speech-sidecar/main.py?raw';
import protocol from './speech-sidecar/protocol.py?raw';
import vad from './speech-sidecar/vad.py?raw';
import streamingAsr from './speech-sidecar/streaming_asr.py?raw';
import smartTurn from './speech-sidecar/smart_turn.py?raw';
import { createSpeechSidecarHost } from './speech-sidecar-host';
import { StreamingSpeechAsr } from './streaming-input';

/** Vite bundles the audited Python sources into the Worker, including packaged
 * builds. Only code is materialized; no recordings or transcripts are written. */
export function createBundledSpeechInput(dataDirectory: string, settings: SpeechSettings): StreamingSpeechAsr {
  const sources = { 'main.py': main, 'protocol.py': protocol, 'vad.py': vad, 'streaming_asr.py': streamingAsr, 'smart_turn.py': smartTurn };
  const version = createHash('sha256').update(JSON.stringify(sources)).digest('hex').slice(0, 24);
  const directory = path.join(dataDirectory, 'runtime', 'speech-sidecar', version);
  let preparing: Promise<void> | undefined;
  const prepare = () => preparing ??= (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [name, source] of Object.entries(sources)) await writeFile(path.join(directory, name), source, { mode: 0o600 });
  })().catch(error => { preparing = undefined; throw error; });
  return new StreamingSpeechAsr({ autoEndpoint: settings.streamingInput?.autoEndpoint === true,
    ...(settings.streamingInput?.fallbackTimeoutMs === undefined ? {} : { fallbackTimeoutMs: settings.streamingInput.fallbackTimeoutMs }),
    createClient: () => createSpeechSidecarHost({
    pythonPath: settings.provider.asr.local.pythonPath, scriptPath: path.join(directory, 'main.py'), prepare,
    ...(settings.streamingInput?.vadModel ? { vadModel: settings.streamingInput.vadModel } : {}),
    ...(settings.streamingInput?.paraformerDirectory ? { paraformerDirectory: settings.streamingInput.paraformerDirectory } : {}),
    ...(settings.streamingInput?.smartTurnModel ? { smartTurnModel: settings.streamingInput.smartTurnModel } : {})
  }) });
}
