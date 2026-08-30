import { CronExpressionParser } from 'cron-parser';
import type { ScheduleSpec } from './types.js';

export interface ScheduleCalculator {
  validate(spec: ScheduleSpec): void;
  nextAfter(spec: ScheduleSpec, after: Date): Date | undefined;
}

function validDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('schedule_invalid_spec: Expected an RFC3339 timestamp.');
  return date;
}

function validateTimezone(timezone: string): void {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); }
  catch { throw new Error(`schedule_invalid_timezone: ${timezone}`); }
}

function validateCronFields(expression: string): void {
  if (expression.trim().split(/\s+/u).length !== 5) {
    throw new Error('schedule_invalid_cron: Only standard 5-field cron expressions are supported.');
  }
}

function strictCronExpression(expression: string): string {
  validateCronFields(expression);
  return `0 ${expression.trim()}`;
}

export class DefaultScheduleCalculator implements ScheduleCalculator {
  validate(spec: ScheduleSpec): void {
    if (spec.kind === 'once') {
      validDate(spec.runAt);
      return;
    }
    if (spec.kind === 'interval') {
      validDate(spec.anchorAt);
      if (!Number.isSafeInteger(spec.intervalMs) || spec.intervalMs < 60_000) {
        throw new Error('schedule_interval_too_short: Intervals must be at least 60000 ms.');
      }
      return;
    }
    validateTimezone(spec.timezone);
    validateCronFields(spec.expression);
    try {
      CronExpressionParser.parse(strictCronExpression(spec.expression), {
        currentDate: new Date(), tz: spec.timezone, strict: true
      }).next();
    } catch (error) {
      throw new Error(`schedule_invalid_cron: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  nextAfter(spec: ScheduleSpec, after: Date): Date | undefined {
    this.validate(spec);
    if (spec.kind === 'once') {
      const runAt = validDate(spec.runAt);
      return runAt.getTime() > after.getTime() ? runAt : undefined;
    }
    if (spec.kind === 'interval') {
      const anchorMs = validDate(spec.anchorAt).getTime();
      const afterMs = after.getTime();
      if (anchorMs > afterMs) return new Date(anchorMs);
      const occurrence = anchorMs + (Math.floor((afterMs - anchorMs) / spec.intervalMs) + 1) * spec.intervalMs;
      return new Date(occurrence);
    }
    try {
      return CronExpressionParser.parse(strictCronExpression(spec.expression), {
        currentDate: after, tz: spec.timezone, strict: true
      }).next().toDate();
    } catch (error) {
      throw new Error(`schedule_invalid_cron: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
