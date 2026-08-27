import { JsonValueSchema, type ExtensionStorage, type JsonValue } from '@desktop-agent/contracts';

export interface ExtensionStorageBackend {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export class MemoryExtensionStorageBackend implements ExtensionStorageBackend {
  private readonly values = new Map<string, JsonValue>();

  async get(key: string): Promise<JsonValue | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async set(key: string, value: JsonValue): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> { this.values.delete(key); }

  async list(prefix: string): Promise<string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

function validKey(key: string, allowEmpty = false): string {
  if (typeof key !== 'string' || key.length > 512 || (!allowEmpty && key.length === 0)) {
    throw new Error('extension_storage_invalid_key');
  }
  if (key.startsWith('/') || key.includes('\\') || key.split('/').some((part) => part === '..')) {
    throw new Error('extension_storage_invalid_key');
  }
  return key;
}

export class NamespacedExtensionStorage implements ExtensionStorage {
  private readonly namespace: string;

  constructor(extensionId: string, private readonly backend: ExtensionStorageBackend) {
    this.namespace = `extension/${extensionId}/`;
  }

  async get(key: string): Promise<JsonValue | undefined> {
    return this.backend.get(this.fullKey(validKey(key)));
  }

  async set(key: string, value: JsonValue): Promise<void> {
    const parsed = JsonValueSchema.parse(value);
    await this.backend.set(this.fullKey(validKey(key)), structuredClone(parsed));
  }

  async delete(key: string): Promise<void> {
    await this.backend.delete(this.fullKey(validKey(key)));
  }

  async list(prefix = ''): Promise<string[]> {
    const validPrefix = validKey(prefix, true);
    const keys = await this.backend.list(this.fullKey(validPrefix));
    return keys.filter((key) => key.startsWith(this.namespace)).map((key) => key.slice(this.namespace.length));
  }

  private fullKey(key: string): string { return `${this.namespace}${key}`; }
}
