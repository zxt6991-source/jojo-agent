import type { PermissionAuditRecord, PermissionAuditSink } from '../types.js';

export class NoopPermissionAuditSink implements PermissionAuditSink {
  record(): void { /* Intentionally empty. */ }
}

export class MemoryPermissionAuditSink implements PermissionAuditSink {
  readonly records: PermissionAuditRecord[] = [];
  record(record: PermissionAuditRecord): void { this.records.push(record); }
}
