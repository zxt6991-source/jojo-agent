import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createSilentMp3Fixture, createSilentWavFixture } from '../src/testing/speech-audio-fixture';
import { launchElectron } from './helpers/launch-electron';

for (const format of ['mp3', 'wav'] as const) {
test(`isolated production AudioHost decodes bounded offline ${format.toUpperCase()} and ACKs actual ended`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-audio-host-'));
  const { app, page } = await launchElectron(directory);
  const buildDirectory = path.join(process.cwd(), '.vite', 'build');
  try {
    const result = await app.evaluate(async ({ BrowserWindow }, input) => {
      const createRequire = process.getBuiltinModule('module').createRequire;
      const localRequire = createRequire(`${input.buildDirectory}/audio-host.js`);
      const { ElectronAudioHost } = localRequire(`${input.buildDirectory}/audio-host.js`);
      const host = new ElectronAudioHost({ buildDirectory: input.buildDirectory });
      const acks: { type: string; reason?: string }[] = [];
      let resolve!: () => void;
      const finished = new Promise<void>((done) => { resolve = done; });
      const timer = setTimeout(resolve, 15_000);
      host.onAck((ack: { type: string; reason?: string }) => { acks.push(ack); if (ack.type === 'ended' || ack.type === 'error') resolve(); });
      try {
        await host.play({ token: input.token, generation: 1, bytes: new Uint8Array(input.bytes), format: input.format, volume: 0 });
        const audioWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/audio-host.html'))!;
        const isolated = await audioWindow.webContents.executeJavaScript(`({
          keys: Object.keys(window.jojoAudioHost).sort(),
          desktopApi: typeof window.desktopAgent, node: typeof window.require,
          process: typeof window.process
        })`);
        await finished;
        return { acks, isolated, hidden: !audioWindow.isVisible() };
      } finally { clearTimeout(timer); host.close(); }
    }, { buildDirectory, token: randomUUID(), format, bytes: [...(format === 'wav' ? createSilentWavFixture() : createSilentMp3Fixture())] });
    expect(result.hidden).toBe(true);
    expect(result.isolated).toEqual({ keys: ['acknowledge', 'onCommand', 'ready'], desktopApi: 'undefined', node: 'undefined', process: 'undefined' });
    expect(result.acks.map((ack) => ack.type)).toEqual(['started', 'ended']);
    expect(await page.evaluate(() => typeof (window as any).jojoAudioHost)).toBe('undefined');
  } finally { await app.close(); }
});
}

test('production AudioHost reports decode failure without treating accepted playback as played', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-audio-host-error-'));
  const { app } = await launchElectron(directory);
  const buildDirectory = path.join(process.cwd(), '.vite', 'build');
  try {
    const acks = await app.evaluate(async (_electron, input) => {
      const localRequire = process.getBuiltinModule('module').createRequire(`${input.buildDirectory}/audio-host.js`);
      const { ElectronAudioHost } = localRequire(`${input.buildDirectory}/audio-host.js`);
      const host = new ElectronAudioHost({ buildDirectory: input.buildDirectory });
      const acks: { type: string; reason?: string }[] = [];
      let resolve!: () => void;
      const finished = new Promise<void>((done) => { resolve = done; });
      const timer = setTimeout(resolve, 15_000);
      host.onAck((ack: { type: string; reason?: string }) => { acks.push(ack); if (ack.type === 'ended' || ack.type === 'error') resolve(); });
      try {
        await host.play({ token: input.token, generation: 2, bytes: new Uint8Array([0, 1, 2]), volume: 0 });
        await finished; return acks;
      } finally { clearTimeout(timer); host.close(); }
    }, { buildDirectory, token: randomUUID() });
    expect(acks).toEqual([expect.objectContaining({ type: 'error', reason: 'decode_failed' })]);
  } finally { await app.close(); }
});
