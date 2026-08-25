import { describe, expect, it, vi } from 'vitest';
import {
  browserFramePathKey,
  expressionInBrowserFrame,
  mergeBrowserFramePaths,
  resolveBrowserFrameRoute
} from './browser-frame-routing';

describe('browser frame routing', () => {
  it('merges recorder-local paths with an outer OOPIF path', () => {
    expect(mergeBrowserFramePaths(
      { selectors: ['iframe[name="payment"]'] },
      { selectors: ['iframe.receipt'] }
    )).toEqual({ selectors: ['iframe[name="payment"]', 'iframe.receipt'] });
    expect(browserFramePathKey(undefined)).toBe('[]');
  });

  it('keeps same-origin frames in one execution context', async () => {
    const evaluate = vi.fn(async (_sessionId: string | undefined, _expression: string) => (
      { found: true, sameOrigin: true, src: '/frame' }
    ));
    const route = await resolveBrowserFrameRoute(
      { selectors: ['iframe#one', 'iframe#two'] },
      [],
      evaluate
    );
    expect(route).toEqual({ localSelectors: ['iframe#one', 'iframe#two'] });
    expect(evaluate.mock.calls[1]?.[1]).toContain('iframe#one');
  });

  it('switches to a flattened CDP session at an OOPIF boundary', async () => {
    const evaluate = vi.fn(async (sessionId: string | undefined) => sessionId
      ? { found: true, sameOrigin: true, src: '/nested' }
      : { found: true, sameOrigin: false, src: 'https://pay.example.test/form' });
    const route = await resolveBrowserFrameRoute(
      { selectors: ['iframe[name="payment"]', 'iframe.receipt'] },
      [{ sessionId: 'oopif-1', targetId: 'frame-1', url: 'https://pay.example.test/form' }],
      evaluate
    );
    expect(route).toEqual({ sessionId: 'oopif-1', localSelectors: ['iframe.receipt'] });
    expect(evaluate.mock.calls[1]?.[0]).toBe('oopif-1');
  });

  it('fails deterministically when the OOPIF target is unavailable or ambiguous', async () => {
    const evaluate = async () => ({ found: true, sameOrigin: false, src: 'https://pay.example.test/' });
    await expect(resolveBrowserFrameRoute({ selectors: ['iframe'] }, [], evaluate))
      .rejects.toThrow(/not attached/iu);
    await expect(resolveBrowserFrameRoute({ selectors: ['iframe'] }, [
      { sessionId: 'a', targetId: 'a', url: 'https://pay.example.test/' },
      { sessionId: 'b', targetId: 'b', url: 'https://pay.example.test/' }
    ], evaluate)).rejects.toThrow(/ambiguous/iu);
  });

  it('wraps DOM work without interpolating selectors into executable source', () => {
    const source = expressionInBrowserFrame(['iframe[name="quoted\\"value"]'], 'return document.title;');
    expect(source).toContain('frameDocument.querySelector(selector)');
    expect(source).toContain('return document.title');
  });
});
