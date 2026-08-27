import { describe, expect, it } from 'vitest';
import {
  ContributionOwnerSchema,
  ExtensionManifestSchema,
  ExtensionSettingsSchema
} from '../src/index.js';
import { ExtensionSettingsSchema as CompatibilitySettingsSchema } from '../src/extensions.js';

describe('extension API contracts', () => {
  it('keeps integration settings separate while preserving the compatibility export', () => {
    const input = { mcpServers: [], skills: { directories: [], disabled: [] }, browser: { enabled: false } };
    expect(CompatibilitySettingsSchema.parse(input)).toEqual(ExtensionSettingsSchema.parse(input));
  });

  it('validates reverse-domain external identities, capabilities, and permissions', () => {
    expect(ExtensionManifestSchema.parse({
      id: 'com.acme.jira',
      name: 'Jira',
      version: '1.2.3',
      apiVersion: '1',
      capabilities: ['tool', 'context'],
      permissions: ['network', 'credentials.read']
    })).toMatchObject({ id: 'com.acme.jira', capabilities: ['tool', 'context'] });
    expect(() => ExtensionManifestSchema.parse({
      id: 'Invalid Extension', name: 'Invalid', version: '1', apiVersion: '1', capabilities: []
    })).toThrow();
    expect(ContributionOwnerSchema.parse({ id: 'browser', version: '1', source: 'builtin' })).toEqual({
      id: 'browser', version: '1', source: 'builtin'
    });
  });
});
