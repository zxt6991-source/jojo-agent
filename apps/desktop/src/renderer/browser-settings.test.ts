import { describe, expect, it } from 'vitest';
import { browserDomainIssue, parseBrowserDomainList } from './browser-settings';

describe('browser domain helpers', () => {
  it('parses, deduplicates, and normalizes hostnames', () => {
    expect(parseBrowserDomainList('Example.COM.\n*.github.com\nexample.com')).toEqual([
      'example.com',
      '*.github.com'
    ]);
    expect(parseBrowserDomainList('a.com, b.com; c.com')).toEqual(['a.com', 'b.com', 'c.com']);
  });

  it('rejects URLs and invalid hostnames', () => {
    expect(browserDomainIssue('https://example.com')).toMatch(/主机名/u);
    expect(browserDomainIssue('example.com/path')).toMatch(/主机名/u);
    expect(browserDomainIssue('example_com')).toMatch(/无效/u);
    expect(browserDomainIssue('localhost')).toBeNull();
    expect(browserDomainIssue('*.example.com')).toBeNull();
  });
});
