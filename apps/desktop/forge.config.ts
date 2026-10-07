import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const signedRelease = process.env.JOJO_SIGN_RELEASE === '1';
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Signed release requires ${name}`);
  return value;
}
const windowsSign = signedRelease && process.platform === 'win32' ? {
  certificateFile: required('WINDOWS_CERTIFICATE_FILE'),
  certificatePassword: required('WINDOWS_CERTIFICATE_PASSWORD')
} : undefined;
const macSign = signedRelease && process.platform === 'darwin' ? {
  osxSign: { identity: required('APPLE_SIGN_IDENTITY') },
  osxNotarize: {
    appleId: required('APPLE_ID'), appleIdPassword: required('APPLE_APP_PASSWORD'), teamId: required('APPLE_TEAM_ID')
  }
} : {};

const config: ForgeConfig = {
  packagerConfig: { asar: true, executableName: 'DesktopAgent', ...macSign, ...(windowsSign ? { windowsSign } : {}) },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({ name: 'DesktopAgent', authors: 'Desktop Agent', description: 'Desktop AI agent', ...windowsSign }), new MakerZIP({}, ['darwin', 'win32']),
    new MakerDeb({ options: { name: 'desktop-agent', productName: 'Desktop Agent', bin: 'DesktopAgent', description: 'Desktop AI agent', maintainer: 'Desktop Agent' } })
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/file-attachments-worker.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
        { entry: 'src/worker/worker.ts', config: 'vite.worker.config.ts', target: 'main' }
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }]
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true
    })
  ]
};

export default config;
