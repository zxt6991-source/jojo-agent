export const DEFAULT_CONFIG_YAML = `# Jojo Agent server configuration
server:
  host: 127.0.0.1
  port: 7788
  allowRemote: false
  # token:
  #   env: JOJO_SERVER_TOKEN

runtime:
  dataDir: ~/.jojo/runtime
  runDir: ~/.jojo/run
  instanceId: default

provider:
  defaultProviderId: openai
  defaultModel: gpt-5-mini
  providers:
    openai:
      type: openai-compatible
      baseUrl: https://api.openai.com/v1
      apiKey:
        env: OPENAI_API_KEY

permissions:
  mode: ask

channels:
  enabled: true

scheduler:
  enabled: true

logging:
  level: info
  format: json

shutdown:
  timeoutMs: 15000
`;
