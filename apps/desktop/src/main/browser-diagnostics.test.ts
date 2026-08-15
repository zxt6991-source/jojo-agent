import { describe, expect, it } from 'vitest';
import {
  createBrowserConsoleRecord,
  createBrowserNetworkRecord,
  createBrowserPageErrorRecord,
  exceptionRecordFromCdp,
  formatBrowserDiagnosticReport,
  formatBrowserExceptionStack,
  isFailedBrowserNetworkRecord,
  isIgnorableBrowserLoadError,
  logErrorRecordFromCdp,
  MAX_BROWSER_CONSOLE_ENTRIES,
  pushBounded,
  recentBrowserErrorHint,
  sanitizeBrowserDiagnosticUrl,
  selectBrowserConsoleRecords,
  selectBrowserErrorRecords,
  selectBrowserNetworkRecords,
  truncateBrowserText,
  upsertBrowserNetworkRecord
} from './browser-diagnostics';

describe('browser diagnostics helpers', () => {
  it('truncates text and strips embedded URL credentials', () => {
    expect(truncateBrowserText('short')).toBe('short');
    expect(truncateBrowserText('abcdefghijklmnopqrstuvwxyz', 20)).toBe('abcdef\n...[truncated]');
    expect(sanitizeBrowserDiagnosticUrl('https://user:secret@example.com/path?q=1'))
      .toBe('https://example.com/path?q=1');
    expect(sanitizeBrowserDiagnosticUrl('not a url')).toBe('not a url');
  });

  it('keeps ring buffers bounded and merges network updates by id', () => {
    const items: number[] = [];
    for (let index = 1; index <= 5; index += 1) pushBounded(items, index, 3);
    expect(items).toEqual([3, 4, 5]);
    expect(MAX_BROWSER_CONSOLE_ENTRIES).toBe(200);

    const records = [
      createBrowserNetworkRecord({ id: '1', method: 'get', url: 'https://example.com/a', pending: true })
    ];
    upsertBrowserNetworkRecord(records, createBrowserNetworkRecord({
      id: '1', url: 'https://example.com/a', status: 500, pending: false
    }));
    upsertBrowserNetworkRecord(records, createBrowserNetworkRecord({
      id: '2', method: 'POST', url: 'https://example.com/b', error: 'net::ERR_FAILED'
    }));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ id: '1', method: 'GET', status: 500 });
    expect(records[0]?.pending).toBeUndefined();
    expect(isFailedBrowserNetworkRecord(records[0]!)).toBe(true);
    expect(isFailedBrowserNetworkRecord(records[1]!)).toBe(true);
  });

  it('filters console, network, and page-error records', () => {
    const consoleRecords = [
      createBrowserConsoleRecord({ level: 'info', text: 'hello', timestamp: 't1' }),
      createBrowserConsoleRecord({ level: 'error', text: 'boom', timestamp: 't2' }),
      createBrowserConsoleRecord({ level: 'warning', text: 'careful', timestamp: 't3' }),
      createBrowserConsoleRecord({ level: 3, text: 'also error', timestamp: 't4' })
    ];
    expect(selectBrowserConsoleRecords(consoleRecords, { level: 'error', limit: 10 }).map((entry) => entry.text))
      .toEqual(['boom', 'also error']);
    expect(selectBrowserConsoleRecords(consoleRecords, { limit: 2 }).map((entry) => entry.text))
      .toEqual(['careful', 'also error']);

    const network = [
      createBrowserNetworkRecord({ id: '1', url: 'https://cdn.example/app.js', resourceType: 'script', status: 200 }),
      createBrowserNetworkRecord({ id: '2', url: 'https://api.example/users', resourceType: 'xhr', status: 404 }),
      createBrowserNetworkRecord({ id: '3', url: 'https://api.example/login', resourceType: 'xhr', error: 'net::ERR_FAILED' })
    ];
    expect(selectBrowserNetworkRecords(network, { failedOnly: true, limit: 10 }).map((entry) => entry.id))
      .toEqual(['2', '3']);
    expect(selectBrowserNetworkRecords(network, { urlContains: '/users', resourceType: 'xhr', limit: 10 }).map((entry) => entry.id))
      .toEqual(['2']);

    const errors = [
      createBrowserPageErrorRecord({ kind: 'log', text: 'cors' }),
      createBrowserPageErrorRecord({ kind: 'exception', text: 'TypeError' }),
      createBrowserPageErrorRecord({ kind: 'failed_load', text: 'net::ERR_NAME_NOT_RESOLVED' })
    ];
    expect(selectBrowserErrorRecords(errors, { kind: 'exception', limit: 10 }).map((entry) => entry.text))
      .toEqual(['TypeError']);
    expect(isIgnorableBrowserLoadError(-3)).toBe(true);
    expect(isIgnorableBrowserLoadError(-105)).toBe(false);
  });

  it('parses CDP exceptions and error logs into bounded records', () => {
    const exception = exceptionRecordFromCdp({
      exceptionDetails: {
        text: 'Uncaught',
        lineNumber: 9,
        columnNumber: 2,
        url: 'https://user:secret@app.example/main.js',
        exception: { description: 'TypeError: x is not a function' },
        stackTrace: {
          callFrames: [
            { functionName: 'submit', url: 'https://app.example/main.js', lineNumber: 9, columnNumber: 2 },
            { functionName: '', url: 'https://app.example/main.js', lineNumber: 20, columnNumber: 0 }
          ]
        }
      }
    });
    expect(exception).toMatchObject({
      kind: 'exception',
      text: 'TypeError: x is not a function',
      url: 'https://app.example/main.js',
      line: 10,
      column: 3
    });
    expect(exception?.stack).toContain('at submit (https://app.example/main.js:10:3)');
    expect(formatBrowserExceptionStack({ callFrames: [] })).toBeUndefined();
    expect(logErrorRecordFromCdp({
      entry: { source: 'network', level: 'error', text: 'Failed to load resource', url: 'https://api.example/x', lineNumber: 0 }
    })).toMatchObject({ kind: 'log', text: '[network] Failed to load resource' });
    expect(logErrorRecordFromCdp({ entry: { level: 'warning', text: 'deprecated' } })).toBeUndefined();
  });

  it('formats diagnostic reports and recent error hints', () => {
    const report = formatBrowserDiagnosticReport(
      { pageId: 7, url: 'https://example.com/', title: 'Example' },
      5,
      [{ text: 'boom' }],
      { failedRequests: 2 }
    );
    expect(JSON.parse(report)).toEqual({
      pageId: 7,
      url: 'https://example.com/',
      title: 'Example',
      captured: 5,
      returned: 1,
      omitted: 4,
      failedRequests: 2,
      entries: [{ text: 'boom' }]
    });
    expect(recentBrowserErrorHint([])).toBe('');
    expect(recentBrowserErrorHint([
      createBrowserPageErrorRecord({ kind: 'exception', text: 'one' }),
      createBrowserPageErrorRecord({ kind: 'exception', text: 'two' })
    ])).toContain('- two');
  });
});
