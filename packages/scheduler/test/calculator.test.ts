import { describe, expect, it } from 'vitest';
import { DefaultScheduleCalculator } from '../src/index.js';

const calculator = new DefaultScheduleCalculator();

describe('DefaultScheduleCalculator', () => {
  it('handles once schedules only when the occurrence is in the future', () => {
    const spec = { kind: 'once' as const, runAt: '2026-08-31T00:00:00.000Z' };
    expect(calculator.nextAfter(spec, new Date('2026-08-30T00:00:00.000Z'))?.toISOString()).toBe(spec.runAt);
    expect(calculator.nextAfter(spec, new Date(spec.runAt))).toBeUndefined();
  });

  it('anchors intervals without execution-duration drift', () => {
    const spec = { kind: 'interval' as const, intervalMs: 60 * 60_000, anchorAt: '2026-08-30T00:00:00.000Z' };
    expect(calculator.nextAfter(spec, new Date('2026-08-30T00:00:00.000Z'))?.toISOString())
      .toBe('2026-08-30T01:00:00.000Z');
    expect(calculator.nextAfter(spec, new Date('2026-08-30T01:10:00.000Z'))?.toISOString())
      .toBe('2026-08-30T02:00:00.000Z');
  });

  it('calculates five-field cron in the persisted timezone', () => {
    const shanghai = { kind: 'cron' as const, expression: '0 8 * * *', timezone: 'Asia/Shanghai' };
    const losAngeles = { kind: 'cron' as const, expression: '0 8 * * *', timezone: 'America/Los_Angeles' };
    const after = new Date('2026-08-30T00:30:00.000Z');
    expect(calculator.nextAfter(shanghai, after)?.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(calculator.nextAfter(losAngeles, after)?.toISOString()).toBe('2026-08-30T15:00:00.000Z');
  });

  it('delegates DST gaps and folds to cron-parser', () => {
    const spec = { kind: 'cron' as const, expression: '30 2 * * *', timezone: 'America/Los_Angeles' };
    expect(calculator.nextAfter(spec, new Date('2026-03-08T08:00:00.000Z'))?.toISOString())
      .toBe('2026-03-08T10:30:00.000Z');
    expect(calculator.nextAfter(spec, new Date('2026-11-01T07:00:00.000Z'))?.toISOString())
      .toBe('2026-11-01T10:30:00.000Z');
  });

  it('rejects seconds fields, invalid timezones, and sub-minute intervals', () => {
    expect(() => calculator.validate({ kind: 'cron', expression: '* * * * * *', timezone: 'UTC' }))
      .toThrow('schedule_invalid_cron');
    expect(() => calculator.validate({ kind: 'cron', expression: '0 8 * * *', timezone: 'Asia/Xian123' }))
      .toThrow('schedule_invalid_timezone');
    expect(() => calculator.validate({ kind: 'interval', intervalMs: 59_999, anchorAt: new Date().toISOString() }))
      .toThrow('schedule_interval_too_short');
  });
});
