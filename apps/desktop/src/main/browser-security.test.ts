import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertBrowserUrl,
  browserKeyDefinition,
  chooseBrowserElementCandidate,
  domainAllowsHost,
  formatAccessibilityTree,
  isAllowedBrowserUrl,
  isRetryableBrowserStepError,
  resolveBrowserUploadPaths,
  safeDownloadFilename,
  serializeBrowserEvalValue
} from './browser-security';

describe('browser security helpers', () => {
  it('matches exact and wildcard domains without allowing the wildcard root', () => {
    expect(domainAllowsHost('example.com', 'EXAMPLE.com.')).toBe(true);
    expect(domainAllowsHost('*.example.com', 'app.example.com')).toBe(true);
    expect(domainAllowsHost('*.example.com', 'example.com')).toBe(false);
    expect(domainAllowsHost('*.example.com', 'notexample.com')).toBe(false);
  });

  it('accepts only credential-free HTTP(S) URLs on allowed hosts', () => {
    expect(isAllowedBrowserUrl('https://app.example.com/path', ['*.example.com'])).toBe(true);
    expect(isAllowedBrowserUrl('file:///etc/passwd', ['example.com'])).toBe(false);
    expect(isAllowedBrowserUrl('https://user:secret@example.com/', ['example.com'])).toBe(false);
    expect(() => assertBrowserUrl('javascript:alert(1)')).toThrow(/HTTP or HTTPS/u);
  });

  it('sanitizes download names and compacts accessibility nodes', () => {
    expect(safeDownloadFilename('../bad:name?.txt')).toBe('bad_name_.txt');
    expect(formatAccessibilityTree([
      { role: { value: 'heading' }, name: { value: 'Welcome' } },
      { ignored: true, role: { value: 'button' }, name: { value: 'Hidden' } },
      { role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: 'a@example.com' } }
    ], 10)).toBe('heading: Welcome\ntextbox: Email = a@example.com');
  });

  it('maps supported browser keys to CDP key definitions', () => {
    expect(browserKeyDefinition('Enter')).toMatchObject({ code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    expect(browserKeyDefinition('a')).toEqual({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' });
    expect(browserKeyDefinition('7')).toEqual({ key: '7', code: 'Digit7', windowsVirtualKeyCode: 55, text: '7' });
    expect(() => browserKeyDefinition('Control')).toThrow(/Unsupported browser key/u);
  });

  it('relocates fingerprints by semantic identity and rejects ambiguous matches', () => {
    const fingerprint = {
      origin: 'https://example.com', selector: 'main > button:nth-of-type(2)', tag: 'button', name: 'Save changes'
    };
    expect(chooseBrowserElementCandidate(fingerprint, [
      { selector: 'main > section > button', tag: 'button', name: 'Save changes', visible: true },
      { selector: 'main > button', tag: 'button', name: 'Cancel', visible: true }
    ])).toMatchObject({
      candidate: { selector: 'main > section > button' }, ambiguous: false
    });
    const ambiguous = chooseBrowserElementCandidate(fingerprint, [
      { selector: 'header > button', tag: 'button', name: 'Save changes', visible: true },
      { selector: 'main > button', tag: 'button', name: 'Save changes', visible: true }
    ]);
    expect(ambiguous.ambiguous).toBe(true);
    expect(ambiguous.candidate).toBeUndefined();
    const missing = chooseBrowserElementCandidate(fingerprint, [
      { selector: 'main > button', tag: 'button', name: 'Delete account', visible: true }
    ]);
    expect(missing.ambiguous).toBe(false);
    expect(missing.candidate).toBeUndefined();
  });

  it('prefers stable ids over a stale selector', () => {
    const fingerprint = {
      origin: 'https://example.com', selector: '#old', tag: 'input', id: 'email', fieldName: 'email', inputType: 'email'
    };
    expect(chooseBrowserElementCandidate(fingerprint, [
      { selector: '#old', tag: 'input', id: 'other', fieldName: 'other', inputType: 'text', visible: true },
      { selector: '#email', tag: 'input', id: 'email', fieldName: 'email', inputType: 'email', visible: true }
    ]).candidate?.selector).toBe('#email');
  });

  it('retries only failures that prove the browser mutation did not run', () => {
    expect(isRetryableBrowserStepError(new Error('Element not found'))).toBe(true);
    expect(isRetryableBrowserStepError(new Error('Browser element ref e2 could not be safely relocated.'))).toBe(true);
    expect(isRetryableBrowserStepError(new Error('Timed out after 500 ms waiting for e2 to become visible.'))).toBe(true);
    expect(isRetryableBrowserStepError(new Error('Execution context was destroyed during click.'))).toBe(false);
    expect(isRetryableBrowserStepError(new Error('Browser element ref e2 is ambiguous after the page changed.'))).toBe(false);
  });

  it('resolves regular upload files without allowing workspace escape', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'browser-upload-'));
    const workspace = path.join(temporary, 'workspace');
    try {
      await mkdir(workspace);
      await writeFile(path.join(workspace, 'inside.txt'), 'inside');
      await writeFile(path.join(temporary, 'outside.txt'), 'outside');
      const insidePath = await realpath(path.join(workspace, 'inside.txt'));
      await expect(resolveBrowserUploadPaths(workspace, ['inside.txt']))
        .resolves.toEqual([insidePath]);
      await expect(resolveBrowserUploadPaths(workspace, ['../outside.txt']))
        .rejects.toThrow(/inside the workspace/u);
      await expect(resolveBrowserUploadPaths(workspace, ['.']))
        .rejects.toThrow(/not a regular file/u);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('serializes eval results as JSON-safe text with a size cap', () => {
    expect(serializeBrowserEvalValue({ href: '/docs' })).toEqual({ json: '{"href":"/docs"}', truncated: false });
    expect(serializeBrowserEvalValue(undefined)).toEqual({ json: 'null', truncated: false });
    const huge = 'x'.repeat(70_000);
    const serialized = serializeBrowserEvalValue(huge);
    expect(serialized.truncated).toBe(true);
    expect(serialized.json.endsWith('\n...[truncated]')).toBe(true);
    expect(serialized.json.length).toBeLessThan(70_000);
  });
});
