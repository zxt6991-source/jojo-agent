import { z } from 'zod';

export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

export const SecretSchema = z.union([
  z.object({ env: z.string().regex(ENV_NAME_PATTERN) }).strict(),
  z.object({ literal: z.string().min(1) }).strict(),
  z.string().min(1)
]);

export type Secret = z.infer<typeof SecretSchema>;

const ProviderSchema = z.object({
  type: z.literal('openai-compatible').default('openai-compatible'),
  name: z.string().min(1).optional(),
  baseUrl: z.string().url().default('https://api.openai.com/v1'),
  apiKey: SecretSchema.optional(),
  models: z.array(z.string().trim().min(1)).min(1).optional()
}).strict();

export const ConfigSchema = z.object({
  server: z.object({
    host: z.string().trim().min(1).default('127.0.0.1'),
    port: z.number().int().min(0).max(65_535).default(7788),
    allowRemote: z.boolean().default(false),
    token: SecretSchema.optional()
  }).strict().default({ host: '127.0.0.1', port: 7788, allowRemote: false }),
  runtime: z.object({
    dataDir: z.string().min(1).default('~/.jojo/runtime'),
    runDir: z.string().min(1).default('~/.jojo/run'),
    instanceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u).default('default')
  }).strict().default({ dataDir: '~/.jojo/runtime', runDir: '~/.jojo/run', instanceId: 'default' }),
  provider: z.object({
    defaultProviderId: z.string().min(1).default('openai'),
    defaultModel: z.string().min(1).default('gpt-5-mini'),
    providers: z.record(z.string().min(1), ProviderSchema).default({
      openai: {
        type: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: { env: 'OPENAI_API_KEY' }
      }
    })
  }).strict().default({
    defaultProviderId: 'openai',
    defaultModel: 'gpt-5-mini',
    providers: {
      openai: {
        type: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: { env: 'OPENAI_API_KEY' }
      }
    }
  }),
  permissions: z.object({
    mode: z.enum(['ask', 'auto', 'yolo']).default('ask')
  }).strict().default({ mode: 'ask' }),
  channels: z.object({
    enabled: z.boolean().default(true)
  }).strict().default({ enabled: true }),
  scheduler: z.object({
    enabled: z.boolean().default(true)
  }).strict().default({ enabled: true }),
  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    format: z.enum(['json', 'pretty']).default('json'),
    file: z.string().min(1).optional()
  }).strict().default({ level: 'info', format: 'json' }),
  shutdown: z.object({
    timeoutMs: z.number().int().min(1_000).max(300_000).default(15_000)
  }).strict().default({ timeoutMs: 15_000 })
}).strict();

export type JojoConfig = z.infer<typeof ConfigSchema>;

export type EffectiveConfig = JojoConfig & {
  paths: {
    configFile: string;
    dataDir: string;
    runDir: string;
    logDir: string;
    pidFile: string;
    lockFile: string;
    statusFile: string;
  };
};

export type ConfigOverrides = {
  server?: Partial<JojoConfig['server']>;
  runtime?: Partial<JojoConfig['runtime']>;
  provider?: Partial<JojoConfig['provider']>;
  permissions?: Partial<JojoConfig['permissions']>;
  channels?: Partial<JojoConfig['channels']>;
  scheduler?: Partial<JojoConfig['scheduler']>;
  logging?: Partial<JojoConfig['logging']>;
  shutdown?: Partial<JojoConfig['shutdown']>;
};
