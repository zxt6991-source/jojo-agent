import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  MemoryError,
  type MemoryDocument,
  type MemoryEntry,
  type MemoryKind,
  type MemoryMutationResult,
  type MemoryPatchRequest,
  type MemoryScope,
  type MemorySearchResult,
  type ProjectIdentity
} from '@desktop-agent/contracts';
import { projectScopeDirectoryName } from '../identity.js';
import { MemoryIndex } from '../recall/index.js';
import { guardedMemoryPath } from '../security/path-guard.js';
import { atomicWriteFile } from './atomic-writer.js';
import { parseMemoryDocument, serializeMemoryEntry } from './parser.js';
import { ScopeWriteQueue } from './scope-write-queue.js';

const EMPTY_HASH = createHash('sha256').update('').digest('hex');
const MAX_ENTRY_BYTES = 16 * 1024;
const MAX_TOPIC_BYTES = 128 * 1024;
const MAX_SCOPE_BYTES = 20 * 1024 * 1024;

type RecoveryRecord = {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  expiresAt: string;
  scopeId: string;
  sourceFile: string;
  entryId: string;
  serializedEntry: string;
};

function hash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function safeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/gu, '')}`;
}

function topicSlug(title: string): string {
  return title.normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '').slice(0, 80) || 'memory';
}

async function exists(filename: string): Promise<boolean> {
  try { await stat(filename); return true; } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class MarkdownMemoryStore {
  private readonly queue = new ScopeWriteQueue();

  constructor(readonly root: string, readonly index: MemoryIndex, private recoveryRetentionDays = 30) {}

  updateRecoveryRetentionDays(days: number): void {
    this.recoveryRetentionDays = Math.max(1, Math.min(365, Math.trunc(days)));
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => undefined);
    await mkdir(path.join(this.root, 'global'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.root, 'projects'), { recursive: true, mode: 0o700 });
    await this.ensureScope(this.globalScope());
  }

  globalScope(): MemoryScope {
    return { id: 'global', kind: 'global', directory: path.join(this.root, 'global'), displayName: 'Global' };
  }

  projectScope(identity: ProjectIdentity): MemoryScope {
    return {
      id: identity.id,
      kind: 'project',
      directory: path.join(this.root, 'projects', projectScopeDirectoryName(identity)),
      displayName: identity.displayName,
      projectIdentity: identity
    };
  }

  async scopes(projectIdentity?: ProjectIdentity): Promise<MemoryScope[]> {
    const scopes = [this.globalScope()];
    if (projectIdentity) scopes.push(this.projectScope(projectIdentity));
    for (const scope of scopes) await this.ensureScope(scope);
    return scopes;
  }

  async ensureScope(scope: MemoryScope): Promise<void> {
    await mkdir(scope.directory, { recursive: true, mode: 0o700 });
    await chmod(scope.directory, 0o700).catch(() => undefined);
    for (const directory of ['topics', 'daily', 'recovery']) {
      await mkdir(path.join(scope.directory, directory), { recursive: true, mode: 0o700 });
    }
    const memoryFile = path.join(scope.directory, 'MEMORY.md');
    const scratchpad = path.join(scope.directory, 'SCRATCHPAD.md');
    if (!await exists(memoryFile)) await atomicWriteFile(memoryFile, '# Memory\n');
    if (!await exists(scratchpad)) await atomicWriteFile(scratchpad, '# Scratchpad\n');
    if (scope.kind === 'project') {
      const scopeFile = path.join(scope.directory, 'scope.json');
      if (!await exists(scopeFile)) {
        await atomicWriteFile(scopeFile, `${JSON.stringify({
          schemaVersion: 1,
          id: scope.id,
          displayName: scope.displayName,
          canonicalPath: scope.projectIdentity?.canonicalPath
        }, null, 2)}\n`);
      }
    }
    await this.cleanupRecovery(scope);
  }

  async read(scope: MemoryScope, requestedPath = 'MEMORY.md'): Promise<MemoryDocument> {
    await this.ensureScope(scope);
    const target = await guardedMemoryPath(this.root, scope.directory, requestedPath);
    let content = '';
    let updatedAt = 0;
    try {
      const [bytes, info] = await Promise.all([readFile(target), stat(target)]);
      if (!info.isFile()) throw new MemoryError('memory_permission_denied', 'Memory target is not a file.');
      content = bytes.toString('utf8');
      updatedAt = info.mtimeMs;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { path: requestedPath, content, revision: hash(content), updatedAt };
  }

  async listEntries(scope: MemoryScope): Promise<{ entries: MemoryEntry[]; warnings: string[] }> {
    const documents = await this.markdownDocuments(scope);
    const entries: MemoryEntry[] = [];
    const warnings: string[] = [];
    for (const document of documents) {
      const parsed = parseMemoryDocument(document.content, document.path, scope.id, document.updatedAt);
      entries.push(...parsed.entries.map(({ raw: _raw, rawStart: _start, rawEnd: _end, ...entry }) => entry));
      warnings.push(...parsed.warnings.map((warning) => `${warning.sourceFile}:${warning.line}: ${warning.message}`));
    }
    return { entries, warnings };
  }

  async ensureIndexed(scope: MemoryScope): Promise<number> {
    const scopeHash = await this.scopeHash(scope);
    const status = this.index.scopeStatus(scope.id);
    if (!status || status.hash !== scopeHash || status.dirty) {
      const { entries } = await this.listEntries(scope);
      return this.index.rebuildScope(scope, entries, scopeHash, Boolean(status && status.hash !== scopeHash));
    }
    return status.version;
  }

  async rebuildIndex(scope: MemoryScope): Promise<number> {
    const { entries } = await this.listEntries(scope);
    return this.index.rebuildScope(scope, entries, await this.scopeHash(scope), true);
  }

  async patch(request: MemoryPatchRequest): Promise<MemoryMutationResult> {
    return this.queue.run(request.scope.id, async () => {
      const current = await this.read(request.scope, request.path);
      if (current.revision !== request.expectedRevision) {
        throw new MemoryError('memory_conflict', 'Memory changed after it was read.', {
          expectedRevision: request.expectedRevision,
          actualRevision: current.revision
        });
      }
      let next: string;
      if (request.patch.type === 'replace') {
        const occurrences = request.patch.oldText
          ? current.content.split(request.patch.oldText).length - 1
          : 0;
        if (occurrences !== 1) {
          throw new MemoryError('memory_conflict', 'The exact patch target is missing or is not unique.', {
            reason: occurrences === 0 ? 'old_text_missing' : 'old_text_not_unique'
          });
        }
        next = current.content.replace(request.patch.oldText, request.patch.newText);
      } else if (request.patch.anchor !== undefined) {
        const occurrences = request.patch.anchor ? current.content.split(request.patch.anchor).length - 1 : 0;
        if (occurrences !== 1) {
          throw new MemoryError('memory_conflict', 'The append anchor is missing or is not unique.', {
            reason: occurrences === 0 ? 'anchor_missing' : 'anchor_not_unique'
          });
        }
        next = current.content.replace(
          request.patch.anchor,
          `${request.patch.anchor}${request.patch.content}`
        );
      } else {
        next = `${current.content.replace(/\s*$/u, '')}\n\n${request.patch.content.trim()}\n`;
      }
      if (next === current.content) {
        return {
          previousRevision: current.revision,
          revision: current.revision,
          changed: false,
          scopeVersion: await this.ensureIndexed(request.scope)
        };
      }
      const bytes = Buffer.byteLength(next);
      if (request.path === 'MEMORY.md' && bytes > 25 * 1024) {
        throw new MemoryError('memory_size_exceeded', 'MEMORY.md exceeds 25 KiB; move details into a topic file.');
      }
      if (request.path.startsWith('topics/') && bytes > MAX_TOPIC_BYTES) {
        throw new MemoryError('memory_size_exceeded', 'Topic file exceeds 128 KiB.');
      }
      const currentScopeSize = await this.scopeSize(request.scope);
      if (currentScopeSize - Buffer.byteLength(current.content) + bytes > MAX_SCOPE_BYTES) {
        throw new MemoryError('memory_size_exceeded', 'Memory scope exceeds 20 MiB.');
      }
      const target = await guardedMemoryPath(this.root, request.scope.directory, request.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await atomicWriteFile(target, next);
      const revision = hash(next);
      try {
        const { entries } = await this.listEntries(request.scope);
        const version = this.index.rebuildScope(request.scope, entries, await this.scopeHash(request.scope), true);
        return { previousRevision: current.revision, revision, changed: true, scopeVersion: version };
      } catch {
        try { this.index.markDirty(request.scope.id); } catch { /* Index may be unavailable. */ }
        return {
          previousRevision: current.revision, revision, changed: true,
          scopeVersion: this.index.scopeVersion(request.scope.id), warning: 'memory_index_stale'
        };
      }
    });
  }

  async writeEntry(input: {
    scope: MemoryScope;
    kind: MemoryKind;
    title: string;
    content: string;
    tags?: string[];
    target: 'index' | 'topic' | 'daily' | 'scratchpad';
    expectedRevision: string;
    sourceSessionId?: string;
    sourceOperationId?: string;
    status?: MemoryEntry['status'];
    ruleMode?: 'always' | 'triggered';
    triggers?: string[];
    existingId?: string;
    oldText?: string;
    newText?: string;
  }): Promise<MemoryMutationResult & { entryId: string; path: string }> {
    if (Buffer.byteLength(input.content) > MAX_ENTRY_BYTES) {
      throw new MemoryError('memory_size_exceeded', 'Memory entry exceeds 16 KiB.');
    }
    const entryId = input.existingId ?? safeId('mem');
    let targetPath = input.target === 'index' ? 'MEMORY.md'
      : input.target === 'scratchpad' ? 'SCRATCHPAD.md'
        : input.target === 'daily' ? `daily/${new Date().toISOString().slice(0, 10)}.md`
          : `topics/${topicSlug(input.title)}.md`;
    let patch: MemoryPatchRequest['patch'];
    if (input.oldText !== undefined && input.newText !== undefined) {
      patch = { type: 'replace', oldText: input.oldText, newText: input.newText };
    } else if (input.existingId) {
      const found = await this.findParsedEntry(input.scope, input.existingId);
      if (!found) throw new MemoryError('memory_entry_not_found', `Memory entry not found: ${input.existingId}`);
      targetPath = found.document.path;
      const existing = found.entry;
      const replacement = serializeMemoryEntry({
        id: existing.id, kind: input.kind, title: input.title, content: input.content,
        ...(input.tags ? { tags: input.tags } : {}), status: existing.status,
        ...(existing.sourceSessionId ? { sourceSessionId: existing.sourceSessionId } : {}),
        ...(existing.sourceOperationId ? { sourceOperationId: existing.sourceOperationId } : {}),
        ...(input.ruleMode ?? existing.ruleMode ? { ruleMode: input.ruleMode ?? existing.ruleMode } : {}),
        ...(input.triggers ?? existing.triggers ? { triggers: input.triggers ?? existing.triggers } : {}),
        createdAt: existing.createdAt
      });
      patch = { type: 'replace', oldText: existing.raw, newText: replacement.slice(replacement.indexOf('<!--')) };
    } else {
      const serialized = serializeMemoryEntry({
        id: entryId, kind: input.kind, title: input.title, content: input.content,
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
        ...(input.sourceOperationId ? { sourceOperationId: input.sourceOperationId } : {}),
        status: input.status ?? 'proposed',
        ...(input.kind === 'rule' ? { ruleMode: input.ruleMode ?? (input.triggers?.length ? 'triggered' : 'always') } : {}),
        ...(input.triggers?.length ? { triggers: input.triggers } : {})
      });
      patch = { type: 'append', content: serialized };
    }
    const result = await this.patch({
      scope: input.scope,
      path: targetPath,
      expectedRevision: input.expectedRevision,
      patch
    });
    return { ...result, entryId, path: targetPath };
  }

  async forget(scope: MemoryScope, entryId: string, expectedRevision: string): Promise<MemoryMutationResult & { recoveryId: string }> {
    const found = await this.findParsedEntry(scope, entryId);
    if (!found) throw new MemoryError('memory_entry_not_found', `Memory entry not found: ${entryId}`);
    const recoveryId = safeId('rec');
    const record: RecoveryRecord = {
      schemaVersion: 1,
      id: recoveryId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.recoveryRetentionDays * 86_400_000).toISOString(),
      scopeId: scope.id,
      sourceFile: found.document.path,
      entryId,
      serializedEntry: found.entry.raw
    };
    const recoveryPath = path.join(scope.directory, 'recovery', `${recoveryId}.json`);
    await atomicWriteFile(recoveryPath, `${JSON.stringify(record, null, 2)}\n`);
    const result = await this.patch({
      scope,
      path: found.document.path,
      expectedRevision,
      patch: { type: 'replace', oldText: found.entry.raw, newText: '' }
    });
    return { ...result, recoveryId };
  }

  async restore(scope: MemoryScope, recoveryId: string, expectedRevision?: string): Promise<MemoryMutationResult & { entryId: string }> {
    if (!/^rec_[a-f0-9]+$/u.test(recoveryId)) throw new MemoryError('memory_recovery_expired', 'Invalid recovery id.');
    let record: RecoveryRecord;
    try {
      record = JSON.parse(await readFile(path.join(scope.directory, 'recovery', `${recoveryId}.json`), 'utf8')) as RecoveryRecord;
    } catch {
      throw new MemoryError('memory_recovery_expired', 'Recovery record is unavailable.');
    }
    if (record.scopeId !== scope.id || Date.parse(record.expiresAt) <= Date.now()) {
      throw new MemoryError('memory_recovery_expired', 'Recovery record has expired.');
    }
    if (await this.findParsedEntry(scope, record.entryId)) {
      throw new MemoryError('memory_conflict', 'The memory entry already exists.');
    }
    const document = await this.read(scope, record.sourceFile);
    const result = await this.patch({
      scope,
      path: record.sourceFile,
      expectedRevision: expectedRevision ?? document.revision,
      patch: { type: 'append', content: record.serializedEntry }
    });
    return { ...result, entryId: record.entryId };
  }

  async search(
    projectIdentity: ProjectIdentity | undefined,
    query: string,
    scopeKind: 'global' | 'project' | 'all',
    kinds: MemoryKind[] | undefined,
    limit: number
  ): Promise<MemorySearchResult[]> {
    const scopes = await this.scopes(projectIdentity);
    const selected = scopes.filter((scope) => scopeKind === 'all' || scope.kind === scopeKind);
    for (const scope of selected) await this.ensureIndexed(scope);
    return this.index.search(query, selected.map((scope) => scope.id), kinds, limit);
  }

  private async findParsedEntry(scope: MemoryScope, id: string) {
    for (const document of await this.markdownDocuments(scope)) {
      const parsed = parseMemoryDocument(document.content, document.path, scope.id, document.updatedAt);
      const entry = parsed.entries.find((candidate) => candidate.id === id);
      if (entry) return { document, entry };
    }
    return undefined;
  }

  private async markdownDocuments(scope: MemoryScope): Promise<MemoryDocument[]> {
    await this.ensureScope(scope);
    const paths = ['MEMORY.md', 'SCRATCHPAD.md'];
    for (const directory of ['topics', 'daily']) {
      const files = await readdir(path.join(scope.directory, directory));
      paths.push(...files.filter((file) => file.endsWith('.md')).map((file) => `${directory}/${file}`));
    }
    return Promise.all(paths.sort().map((filename) => this.read(scope, filename)));
  }

  private async scopeHash(scope: MemoryScope): Promise<string> {
    const digest = createHash('sha256');
    for (const document of await this.markdownDocuments(scope)) {
      digest.update(document.path).update('\0').update(document.content).update('\0');
    }
    return digest.digest('hex');
  }

  private async scopeSize(scope: MemoryScope): Promise<number> {
    return (await this.markdownDocuments(scope)).reduce((total, document) => total + Buffer.byteLength(document.content), 0);
  }

  private async cleanupRecovery(scope: MemoryScope): Promise<void> {
    const directory = path.join(scope.directory, 'recovery');
    const files = (await readdir(directory)).filter((file) => file.endsWith('.json'));
    const retained: Array<{ filename: string; size: number; modifiedAt: number }> = [];
    for (const file of files) {
      const filename = path.join(directory, file);
      try {
        const [content, info] = await Promise.all([readFile(filename, 'utf8'), stat(filename)]);
        const record = JSON.parse(content) as { expiresAt?: unknown };
        if (typeof record.expiresAt !== 'string' || Date.parse(record.expiresAt) <= Date.now()) {
          await unlink(filename);
        } else {
          retained.push({ filename, size: info.size, modifiedAt: info.mtimeMs });
        }
      } catch {
        // Invalid recovery records are not trusted as restore sources.
        await unlink(filename).catch(() => undefined);
      }
    }
    let total = retained.reduce((sum, item) => sum + item.size, 0);
    for (const item of retained.sort((left, right) => left.modifiedAt - right.modifiedAt)) {
      if (total <= 100 * 1024 * 1024) break;
      await unlink(item.filename).catch(() => undefined);
      total -= item.size;
    }
  }
}

export { EMPTY_HASH };
