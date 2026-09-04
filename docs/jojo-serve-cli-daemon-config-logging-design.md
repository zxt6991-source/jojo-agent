# Jojo Agent `jojo serve` / CLI / 守护运行 / 配置 / 日志完善技术方案

> 适用仓库：`zxt6991-source/jojo-agent`  
> 基线：`main`，commit `ea29baebde8de4a560935bd32e136da205214760`（2026-09-01）  
> 目标：在**不重写现有 Headless Server / Runtime** 的前提下，将现有 `apps/server` 产品化为可安装、可配置、可守护、可诊断、可审计的 `jojo serve` 服务。

---

## 1. 背景与现状

Jojo Agent 当前已经具备完整的无界面 Server 组合能力：

- `apps/server/src/index.ts`
  - `createHeadlessServer()`
  - `createNetworkServer()`
- `packages/runtime-composition`
  - 统一创建 `AgentRuntime`
  - Provider / Permission / Store / Tools / Hooks / Memory / Telemetry 等通过组合层注入
- `packages/server-core`
  - Server 业务核心
- `packages/server-http`
  - Fastify REST + WebSocket
  - `/healthz`
  - `/readyz`
  - `/api/v1/*`
- `packages/storage`
  - Server State / Runtime 数据持久化
- `packages/channel-runtime`
  - Telegram / Feishu 等 Channel
- `packages/scheduler`
  - Headless Scheduler

现有 `createNetworkServer()` 已经承担正确的 Runtime 组合职责，因此**不建议把 CLI、daemon、配置解析、日志逻辑继续塞进 `apps/server/src/index.ts`**。

当前缺失的主要是产品层：

1. 没有独立 `jojo` 命令；
2. 没有 `jojo serve`；
3. 没有稳定的配置文件规范；
4. 没有 env / CLI / config 的统一优先级；
5. 没有 daemon/service 管理命令；
6. 没有 PID / instance lock；
7. 没有统一结构化日志；
8. Fastify 当前 `logger: false`；
9. 没有 `jojo logs`、`jojo status`、`jojo doctor`；
10. 没有生产级 shutdown、启动失败分类、退出码约定；
11. README 已明确将“`jojo serve` 独立 CLI 产品化”列为未实现项。

因此，本方案定义一层新的：

```text
CLI Product Layer
       │
       ▼
Bootstrap / Config / Logging / Service Manager
       │
       ▼
apps/server createNetworkServer()
       │
       ▼
server-core / server-http / scheduler / channels
       │
       ▼
runtime-composition
       │
       ▼
AgentRuntime
```

---

# 2. 设计原则

## 2.1 CLI 只负责产品化，不重新实现 Runtime

`jojo serve` 应当最终调用：

```ts
const server = await createNetworkServer(options);
const address = await server.listen();
```

CLI 不直接构造：

- AgentRuntime
- ServerCore
- Scheduler
- ChannelManager

这些职责继续留在现有组合层。

---

## 2.2 前台运行是基础能力，守护运行交给 OS 服务管理器

推荐：

```bash
jojo serve
```

始终作为标准 foreground process。

生产环境：

- Linux → systemd
- macOS → launchd
- Windows → Windows Service（后续）

不要实现 Unix double-fork 风格的传统 daemon。

原因：

- systemd / launchd 已经负责重启、stdout/stderr、权限、资源限制；
- Node 自己 daemonize 会增加 PID、stdio、僵尸进程、升级重启复杂度；
- 容器环境同样要求前台进程。

所以：

```text
jojo serve
    = 前台服务进程

jojo service install
    = 安装 OS service

jojo service start
    = 调用 systemd / launchd
```

---

# 3. 建议目录结构

建议新增：

```text
apps/
├── server/
│   └── src/
│       ├── index.ts
│       └── scheduler-runtime.ts
│
└── cli/
    ├── package.json
    └── src/
        ├── bin.ts
        ├── cli.ts
        ├── context.ts
        │
        ├── commands/
        │   ├── serve.ts
        │   ├── status.ts
        │   ├── stop.ts
        │   ├── logs.ts
        │   ├── doctor.ts
        │   ├── config.ts
        │   └── service.ts
        │
        ├── bootstrap/
        │   ├── server-bootstrap.ts
        │   ├── shutdown.ts
        │   ├── instance-lock.ts
        │   └── readiness.ts
        │
        ├── config/
        │   ├── schema.ts
        │   ├── defaults.ts
        │   ├── paths.ts
        │   ├── env.ts
        │   ├── loader.ts
        │   ├── merge.ts
        │   └── redact.ts
        │
        ├── logging/
        │   ├── logger.ts
        │   ├── transport.ts
        │   ├── context.ts
        │   └── redact.ts
        │
        ├── service/
        │   ├── service-manager.ts
        │   ├── systemd.ts
        │   ├── launchd.ts
        │   └── windows.ts
        │
        └── diagnostics/
            ├── doctor.ts
            └── process-info.ts
```

另外建议新增独立基础包：

```text
packages/
├── config/
│   └── ...
└── logging/
    └── ...
```

如果短期只给 `jojo serve` 使用，可以先放在 `apps/cli`。

当 Desktop 也需要复用时再抽到 package。

---

# 4. `jojo` CLI 总体设计

推荐命令：

```text
jojo
├── serve
├── status
├── stop
├── logs
├── doctor
├── config
│   ├── path
│   ├── show
│   ├── validate
│   └── init
└── service
    ├── install
    ├── uninstall
    ├── start
    ├── stop
    ├── restart
    └── status
```

后续可以再增加：

```text
jojo session ...
jojo channel ...
jojo schedule ...
jojo model ...
```

但第一阶段不要扩大范围。

---

# 5. `jojo serve`

## 5.1 使用方式

```bash
jojo serve
```

典型：

```bash
jojo serve \
  --host 127.0.0.1 \
  --port 7788
```

指定配置：

```bash
jojo serve --config ~/.jojo/config.yml
```

远程监听：

```bash
jojo serve \
  --host 0.0.0.0 \
  --allow-remote \
  --token-env JOJO_SERVER_TOKEN
```

调试：

```bash
jojo serve --log-level debug --log-format pretty
```

一次性覆盖数据目录：

```bash
jojo serve --data-dir /var/lib/jojo
```

---

## 5.2 推荐参数

```text
--config <path>
--data-dir <path>

--host <host>
--port <port>
--allow-remote

--token <token>             不推荐，仅兼容
--token-env <name>

--log-level <level>
--log-format <json|pretty>
--log-file <path>

--instance-id <id>

--pid-file <path>

--shutdown-timeout <ms>

--print-effective-config
--check
```

其中：

### `--check`

只执行：

1. 配置加载
2. Schema 校验
3. 路径权限检测
4. Token / secret 引用检测
5. Provider 配置检测
6. 端口基础检测

不启动服务。

```bash
jojo serve --check
```

非常适合 systemd：

```ini
ExecStartPre=/usr/bin/jojo serve --check
```

---

# 6. CLI 技术实现

建议依赖：

```json
{
  "dependencies": {
    "commander": "^14",
    "zod": "^4",
    "yaml": "^2",
    "pino": "^9"
  }
}
```

也可以使用 `cac`，但 Jojo 目前大量使用 Zod，因此：

```text
Commander + Zod
```

更直接。

CLI 参数负责解析字符串，Zod 负责最终类型校验。

---

## 6.1 package.json

```json
{
  "name": "@desktop-agent/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "jojo": "./dist/bin.js"
  },
  "dependencies": {
    "@desktop-agent/server": "workspace:*",
    "commander": "^14.0.0",
    "pino": "^9.0.0",
    "yaml": "^2.8.0",
    "zod": "^4.0.0"
  }
}
```

---

## 6.2 `bin.ts`

```ts
#!/usr/bin/env node

import { runCli } from './cli.js';

runCli(process.argv).catch((error) => {
  process.stderr.write(`${formatFatalError(error)}\n`);
  process.exitCode = 1;
});
```

`bin.ts` 不做 Runtime 初始化。

---

# 7. 配置系统

## 7.1 推荐格式

建议 YAML：

```text
~/.jojo/config.yml
```

原因：

- Jojo Hooks 已经采用 YAML；
- 比 JSON 更适合手写；
- 支持注释；
- service 配置可读性好。

---

## 7.2 默认路径

Linux：

```text
~/.config/jojo/config.yml
~/.local/share/jojo/
~/.local/state/jojo/
```

macOS：

```text
~/Library/Application Support/Jojo/config.yml
~/Library/Application Support/Jojo/
~/Library/Logs/Jojo/
```

但 Jojo 现有代码已经大量使用：

```text
~/.jojo/
```

为了兼容现有产品，第一阶段建议统一：

```text
~/.jojo/config.yml
~/.jojo/runtime/
~/.jojo/logs/
~/.jojo/run/
~/.jojo/memory/
~/.jojo/hooks.yml
```

即：

```text
~/.jojo/
├── config.yml
├── runtime/
│   ├── server-state.sqlite
│   ├── channels.sqlite
│   └── ...
├── logs/
│   └── jojo-server.log
├── run/
│   ├── server.pid
│   └── server.lock
├── memory/
└── hooks.yml
```

---

# 8. 配置 Schema

建议：

```yaml
server:
  host: 127.0.0.1
  port: 7788
  allowRemote: false
  token:
    env: JOJO_SERVER_TOKEN

runtime:
  dataDir: ~/.jojo/runtime
  instanceId: default

provider:
  defaultProviderId: openai
  defaultModel: gpt-5

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
  file: ~/.jojo/logs/jojo-server.log

shutdown:
  timeoutMs: 15000
```

---

## 8.1 Secret 不允许明文作为推荐配置

错误：

```yaml
server:
  token: abc123
```

推荐：

```yaml
server:
  token:
    env: JOJO_SERVER_TOKEN
```

Provider：

```yaml
apiKey:
  env: OPENAI_API_KEY
```

Channel：

```yaml
secretRefs:
  appSecret:
    env: JOJO_FEISHU_APP_SECRET
```

第一阶段可以兼容 literal，但启动时：

```text
WARN config.secret.literal
```

并在 `jojo config validate` 中给 warning。

---

# 9. 配置优先级

必须明确固定：

```text
CLI
  >
Environment
  >
指定 config 文件
  >
默认 config 文件
  >
程序默认值
```

例如：

```text
--port 9000
JOJO_SERVER_PORT=8000
config.yml: 7788
default: 7788
```

最终：

```text
9000
```

推荐实现：

```ts
const effectiveConfig = ConfigSchema.parse(
  deepMerge(
    defaults,
    fileConfig,
    envConfig,
    cliConfig
  )
);
```

---

# 10. Environment 命名

统一：

```text
JOJO_CONFIG
JOJO_DATA_DIR
JOJO_INSTANCE_ID

JOJO_SERVER_HOST
JOJO_SERVER_PORT
JOJO_SERVER_ALLOW_REMOTE
JOJO_SERVER_TOKEN

JOJO_PROVIDER
JOJO_MODEL

JOJO_LOG_LEVEL
JOJO_LOG_FORMAT
JOJO_LOG_FILE

JOJO_SHUTDOWN_TIMEOUT_MS
```

Provider Secret 继续使用原 Provider 自己的 env：

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
```

不要把所有 secret 复制进 `JOJO_*`。

---

# 11. `EffectiveConfig`

启动以后只向下游传一个完成解析的配置对象：

```ts
export type EffectiveConfig = z.infer<typeof EffectiveConfigSchema>;
```

不能让下层继续读取：

```ts
process.env
```

否则优先级会失控。

正确：

```text
process.env
    │
    ▼
ConfigLoader
    │
    ▼
EffectiveConfig
    │
    ├── logger
    ├── provider
    ├── server
    ├── scheduler
    └── channel
```

---

# 12. Server Bootstrap

新增：

```text
apps/cli/src/bootstrap/server-bootstrap.ts
```

职责：

```text
load config
    ↓
create logger
    ↓
create runtime dependencies
    ↓
createNetworkServer()
    ↓
listen()
    ↓
write pid/status
    ↓
register shutdown hooks
```

伪代码：

```ts
export async function serve(config: EffectiveConfig): Promise<void> {
  const logger = createLogger(config.logging);

  const lock = await acquireInstanceLock({
    instanceId: config.runtime.instanceId,
    runDir: config.paths.runDir
  });

  try {
    const dependencies = await createRuntimeDependencies(config, logger);

    const server = await createNetworkServer({
      ...dependencies,

      dataDir: config.runtime.dataDir,
      instanceId: config.runtime.instanceId,

      http: {
        host: config.server.host,
        port: config.server.port,
        allowRemote: config.server.allowRemote,
        token: resolveSecret(config.server.token)
      }
    });

    const address = await server.listen();

    logger.info({
      event: 'server.started',
      address,
      pid: process.pid
    });

    await waitForShutdownSignal(server, logger, config.shutdown);
  } finally {
    await lock.release();
  }
}
```

---

# 13. 与现有 `createNetworkServer()` 的关系

现有函数：

```ts
createNetworkServer(options)
```

已经完成：

```text
createHeadlessServer
    ↓
Server State Store
    ↓
Approval Broker
    ↓
Channel Manager
    ↓
createJojoRuntime
    ↓
Server Recovery
    ↓
AppService
    ↓
Scheduler
    ↓
ServerCore
    ↓
createJojoHttpServer
```

因此 CLI 只应该创建：

```text
providers
permissions
store
tools
hooks
memory
telemetry
secret resolver
路径
network options
```

然后交给 `createNetworkServer()`。

---

# 14. HTTP Server 建议改造

当前 `packages/server-http`：

```ts
Fastify({
  bodyLimit: ...,
  requestIdHeader: 'x-request-id',
  logger: false
});
```

不建议直接：

```ts
logger: true
```

因为这样会出现两套日志系统。

改成允许注入：

```ts
export type JojoHttpServerOptions = {
  ...
  logger?: FastifyBaseLogger;
};
```

然后：

```ts
const app = Fastify({
  ...
  loggerInstance: options.logger
});
```

或者：

```ts
logger: options.fastifyLoggerOptions
```

更推荐：

```text
统一 Pino root logger
     │
     ├── CLI
     ├── server
     ├── http
     ├── scheduler
     └── channels
```

---

# 15. 日志系统

## 15.1 统一使用 Pino

推荐日志等级：

```text
trace
debug
info
warn
error
fatal
```

默认：

```text
info
```

生产默认：

```text
JSON
```

开发：

```text
pretty
```

---

## 15.2 JSON 示例

```json
{
  "level": 30,
  "time": "2026-09-02T13:20:11.551Z",
  "service": "jojo",
  "component": "server",
  "instanceId": "default",
  "pid": 30214,
  "event": "server.started",
  "host": "127.0.0.1",
  "port": 7788
}
```

---

## 15.3 必须统一的公共字段

所有日志：

```text
service
component
instanceId
pid
version
event
```

请求：

```text
requestId
method
route
statusCode
durationMs
```

Agent：

```text
sessionId
runId
laneId
actorId
```

Scheduler：

```text
scheduleId
scheduleRunId
```

Channel：

```text
channelInstanceId
channelKind
deliveryId
```

---

# 16. 日志事件命名

不要大量写自然语言日志：

```ts
logger.info('server started');
```

推荐：

```ts
logger.info({
  event: 'server.started',
  host,
  port
});
```

建议事件：

```text
server.starting
server.started
server.stopping
server.stopped
server.start_failed

runtime.initializing
runtime.ready
runtime.close_failed

config.loaded
config.invalid
config.secret_literal

http.request.completed
http.request.failed

scheduler.started
scheduler.stopped
scheduler.run.failed

channel.started
channel.stopped
channel.delivery.failed

process.signal
process.uncaught_exception
process.unhandled_rejection
```

---

# 17. 敏感字段脱敏

必须全局 redact：

```text
authorization
cookie
set-cookie
token
accessToken
refreshToken
apiKey
secret
appSecret
verificationToken
encryptKey
password
```

Pino：

```ts
pino({
  redact: {
    paths: [
      '*.authorization',
      '*.token',
      '*.apiKey',
      '*.secret',
      '*.appSecret',
      'req.headers.authorization'
    ],
    censor: '[REDACTED]'
  }
});
```

同时要避免：

```ts
logger.error({ config });
```

应当：

```ts
logger.debug({
  config: redactConfig(config)
});
```

---

# 18. 文件日志策略

CLI 前台模式：

```text
stdout/stderr
```

systemd：

```text
journald
```

macOS launchd：

```text
~/Library/Logs/Jojo/...
```

如果启用应用内日志文件：

```yaml
logging:
  file: ~/.jojo/logs/jojo-server.log
```

推荐 rolling：

```text
jojo-server.log
jojo-server.log.1
...
```

但第一阶段可以先：

```text
stdout + journald
```

不要自己实现复杂 rotation。

---

# 19. `jojo logs`

Linux systemd：

```bash
jojo logs
```

等价：

```bash
journalctl --user -u jojo.service -f
```

支持：

```bash
jojo logs --follow
jojo logs --lines 200
jojo logs --level error
```

应用文件模式：

```bash
jojo logs --file
```

---

# 20. Graceful Shutdown

必须处理：

```text
SIGINT
SIGTERM
```

可选：

```text
SIGHUP
```

流程：

```text
SIGTERM
  ↓
标记 shutting-down
  ↓
停止接受新请求
  ↓
停止 scheduler 拉取新任务
  ↓
停止 channel intake
  ↓
等待 active run
  ↓
server.close()
  ↓
flush logs
  ↓
release lock
  ↓
exit 0
```

现有 `HeadlessServer.close()` 已经具有：

```text
channelApproval.stop()
channelManager.stop()
core.close()
```

`NetworkServer.close()` 还会关闭：

```text
http.app.close()
```

CLI 应复用这些生命周期。

---

# 21. Shutdown Timeout

配置：

```yaml
shutdown:
  timeoutMs: 15000
```

实现：

```ts
await Promise.race([
  server.close(),
  timeout(15_000)
]);
```

超时：

```text
ERROR server.shutdown_timeout
exit 2
```

不要无限等待。

---

# 22. 未捕获异常

注册：

```ts
process.on('uncaughtException', ...)
process.on('unhandledRejection', ...)
```

行为：

```text
记录 fatal
尝试 close()
退出
```

但不要：

```text
捕获后继续运行
```

因为 Runtime 状态可能已经不一致。

---

# 23. Instance Lock

必须避免：

```bash
jojo serve
jojo serve
```

两个进程同时使用：

```text
~/.jojo/runtime/server-state.sqlite
~/.jojo/runtime/channels.sqlite
```

建议 lock：

```text
~/.jojo/run/<instanceId>.lock
```

内容：

```json
{
  "pid": 12345,
  "instanceId": "default",
  "startedAt": "2026-09-02T13:00:00Z",
  "version": "0.1.0"
}
```

最好使用真实文件锁库，而不是单纯 PID 文件。

例如：

```text
proper-lockfile
```

或者 Unix `flock`。

---

# 24. PID 文件

PID 文件用于：

```text
status
stop
diagnostics
```

不是互斥机制。

```text
~/.jojo/run/default.pid
```

---

# 25. `jojo status`

输出：

```text
Jojo Server

Status:       running
PID:          30214
Instance:     default
Version:      0.1.0
Address:      http://127.0.0.1:7788
Health:       ok
Ready:        ready
Data Dir:     /home/user/.jojo/runtime
Config:       /home/user/.jojo/config.yml
Uptime:       01:42:13
```

`--json`：

```bash
jojo status --json
```

```json
{
  "status": "running",
  "pid": 30214,
  "health": "ok",
  "ready": true
}
```

实现优先：

1. service manager 状态
2. pid 存活检测
3. `/healthz`
4. `/readyz`
5. `/api/v1/server`

---

# 26. `jojo stop`

如果 foreground：

用户 Ctrl+C。

如果手工后台运行：

```bash
jojo stop
```

流程：

```text
读取 pid
确认该 pid 的 identity
SIGTERM
等待
超时后报错
```

不要默认：

```text
SIGKILL
```

如果需要：

```bash
jojo stop --force
```

---

# 27. 不建议实现 `jojo serve --daemon`

推荐不支持。

如确实想兼容：

```bash
jojo serve --daemon
```

其内部也不要 double-fork，而是提示：

```text
Use:
  jojo service install
  jojo service start
```

这样跨平台行为更一致。

---

# 28. Linux systemd

推荐 user service：

```text
~/.config/systemd/user/jojo.service
```

模板：

```ini
[Unit]
Description=Jojo Agent Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple

ExecStart=/usr/bin/jojo serve --config %h/.jojo/config.yml
ExecStartPre=/usr/bin/jojo serve --config %h/.jojo/config.yml --check

Restart=on-failure
RestartSec=3

KillSignal=SIGTERM
TimeoutStopSec=20

Environment=NODE_ENV=production

NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
```

启用：

```bash
systemctl --user daemon-reload
systemctl --user enable --now jojo.service
```

查看：

```bash
systemctl --user status jojo
journalctl --user -u jojo -f
```

---

# 29. `jojo service install`

CLI 自动生成上述 service：

```bash
jojo service install
```

输出：

```text
Installed:
  ~/.config/systemd/user/jojo.service

Run:
  jojo service start
```

支持：

```bash
jojo service install --system
```

但第一阶段只做：

```text
user service
```

避免 sudo 权限问题。

---

# 30. macOS launchd

建议：

```text
~/Library/LaunchAgents/dev.jojo.agent.plist
```

核心：

```xml
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/jojo</string>
  <string>serve</string>
  <string>--config</string>
  <string>/Users/xxx/.jojo/config.yml</string>
</array>

<key>RunAtLoad</key>
<true/>

<key>KeepAlive</key>
<true/>
```

`jojo service install` 根据：

```ts
process.platform
```

选择：

```text
linux  → systemd
darwin → launchd
win32  → Windows Service（后续）
```

---

# 31. ServiceManager 抽象

```ts
export interface ServiceManager {
  install(options: ServiceInstallOptions): Promise<void>;
  uninstall(): Promise<void>;

  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;

  status(): Promise<ServiceStatus>;
}
```

CLI 不直接散落：

```text
systemctl
launchctl
```

---

# 32. `jojo config`

## `jojo config path`

```bash
jojo config path
```

输出：

```text
/home/lzp/.jojo/config.yml
```

---

## `jojo config init`

生成：

```yaml
server:
  host: 127.0.0.1
  port: 7788
  allowRemote: false

runtime:
  dataDir: ~/.jojo/runtime

provider:
  defaultProviderId: openai

logging:
  level: info
  format: json
```

不写 secret。

---

## `jojo config validate`

```bash
jojo config validate
```

输出：

```text
OK config schema
OK data directory
OK server bind policy
OK provider config
WARN OPENAI_API_KEY is not available
```

---

## `jojo config show`

必须默认 redact：

```yaml
server:
  token: "[REDACTED]"
```

支持：

```bash
jojo config show --effective
```

展示 merge 后配置。

---

# 33. Remote Binding 安全策略

现有 HTTP Server 已经有正确的安全原则：

```text
默认 127.0.0.1
非 loopback：
  allowRemote=true
  + token
```

CLI 应保留这一原则。

错误：

```bash
jojo serve --host 0.0.0.0
```

输出：

```text
Refusing remote bind.

To listen on a non-loopback address, configure both:
  server.allowRemote=true
  server.token
```

不要隐式开启。

---

# 34. Token 生成

建议增加：

```bash
jojo config generate-token
```

或者：

```bash
jojo token generate
```

实现：

```ts
randomBytes(32).toString('base64url')
```

但不自动写入明文 config。

可以输出：

```bash
export JOJO_SERVER_TOKEN='...'
```

---

# 35. `jojo doctor`

这是生产排查非常重要的一层。

执行：

```bash
jojo doctor
```

检查：

```text
Node version
Jojo version
config
data directory
run directory
log directory
SQLite writable
server port
provider secret presence
sandbox backend
hooks
memory
channels
scheduler
service manager
health endpoint
```

示例：

```text
Jojo Doctor

✓ Node 24.10.1
✓ Jojo 0.1.0
✓ Config valid
✓ Runtime directory writable
✓ SQLite available
✓ Server 127.0.0.1:7788 reachable
✓ /healthz
✓ /readyz

! OPENAI_API_KEY missing
! systemd service not installed
```

支持：

```bash
jojo doctor --json
```

---

# 36. Exit Code

建议稳定定义：

```text
0  success
1  generic failure
2  invalid configuration
3  already running
4  bind/listen failure
5  secret/provider configuration error
6  storage initialization failure
7  service-manager failure
8  shutdown timeout
```

例如 systemd 可以清楚记录：

```text
status=4
```

比统一 exit 1 更容易诊断。

---

# 37. Error 类型

建议：

```ts
class JojoCliError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}
```

示例：

```text
CONFIG_INVALID
INSTANCE_ALREADY_RUNNING
SERVER_BIND_FAILED
SERVER_REMOTE_TOKEN_REQUIRED
PROVIDER_SECRET_MISSING
STORAGE_INIT_FAILED
```

---

# 38. Server Startup 状态

建议启动生命周期：

```text
boot
config
logging
lock
storage
runtime
channels
scheduler
http
ready
```

日志：

```text
server.bootstrap.begin
config.loaded
instance.lock.acquired
runtime.ready
scheduler.started
channels.started
http.listening
server.ready
```

这样出现卡死时能准确知道卡在哪。

---

# 39. Readiness 语义完善

当前 `/readyz` 主要依据：

```text
app.server.listening
```

建议逐步升级：

```text
ready =
  HTTP listening
  AND Runtime initialized
  AND State recovery completed
  AND Scheduler initialized
  AND required Channel initialization completed
```

可以建立：

```ts
type ReadinessState = {
  runtime: boolean;
  storage: boolean;
  scheduler: boolean;
  channels: boolean;
  http: boolean;
};
```

返回：

```json
{
  "status": "ready",
  "components": {
    "runtime": "ready",
    "storage": "ready",
    "scheduler": "ready",
    "channels": "ready"
  }
}
```

---

# 40. Liveness 与 Readiness 区分

```text
/healthz
```

只判断：

```text
process / event loop / HTTP server 活着
```

```text
/readyz
```

判断：

```text
是否可以接受正常业务请求
```

不要把外部 LLM Provider 暂时网络失败直接变成 liveness failure。

否则 systemd/K8s 会反复重启。

---

# 41. Runtime Dependency Factory

当前 `createNetworkServer()` 需要：

```text
providers
permissions
store?
tools?
summarizer?
memory?
hooks?
runContext?
telemetry?
capabilities?
```

建议 CLI 新建：

```text
createServerRuntimeDependencies(config)
```

例如：

```ts
const dependencies = await createServerRuntimeDependencies({
  config,
  logger
});

await createNetworkServer({
  ...dependencies,
  dataDir,
  instanceId,
  http
});
```

这样：

```text
CLI 参数
```

不会污染 Server Runtime API。

---

# 42. Provider 配置

CLI 需要把 Desktop Settings 里的 Provider 构造逻辑抽成可复用 factory。

推荐：

```text
packages/providers
├── config.ts
├── resolver.ts
└── openai-compatible.ts
```

Server config：

```yaml
providers:
  openai:
    type: openai-compatible
    baseUrl: https://api.openai.com/v1
    apiKey:
      env: OPENAI_API_KEY

defaults:
  provider: openai
  model: gpt-5
```

不要在 CLI 中直接：

```ts
new OpenAI(...)
```

---

# 43. Permission 配置

Server Headless 必须显式定义默认策略。

建议默认：

```yaml
permissions:
  mode: ask
```

但 Headless 没有 Desktop 弹窗，因此必须明确：

```text
需要人工审批的 run：
    等待 remote approval
```

而不是：

```text
自动 allow
```

这与现有 Server Approval Broker 模型一致。

---

# 44. Channel Secret Resolver

当前 `createHeadlessServer()` Channel 需要：

```ts
ChannelSecretResolver
```

CLI 可以实现：

```text
EnvChannelSecretResolver
```

只解析：

```text
secret://env/NAME
```

后续再加：

```text
secret://keychain/...
secret://file/...
```

推荐配置：

```yaml
channels:
  instances:
    feishu:
      secretRefs:
        appSecret: secret://env/JOJO_FEISHU_APP_SECRET
```

---

# 45. 日志注入 Runtime

`JojoRuntimeCompositionOptions` 已有：

```ts
telemetry?: TelemetrySink;
```

日志和 telemetry 不应完全混在一起：

```text
logger
  = 运维事件

telemetry
  = Runtime 结构化运行事件/指标
```

但可以做桥接：

```text
TelemetrySink
   ↓
logger.child({ component: 'runtime' })
```

短期足够。

---

# 46. Metrics 预留

本阶段不必做 Prometheus。

但日志字段应为以后 metrics 留空间：

```text
durationMs
queueDepth
activeRuns
pendingApprovals
schedulerLagMs
```

后续可以增加：

```text
/metrics
```

---

# 47. Request Logging

Fastify request：

```text
http.request.started
http.request.completed
```

建议只默认打印 completed：

```json
{
  "event": "http.request.completed",
  "requestId": "...",
  "method": "POST",
  "route": "/api/v1/sessions/:sessionId/runs",
  "statusCode": 202,
  "durationMs": 21
}
```

不要打印完整 request body。

因为 prompt、secret、附件 metadata 可能包含敏感信息。

---

# 48. Crash Log

fatal：

```json
{
  "level": 60,
  "event": "process.uncaught_exception",
  "error": {
    "type": "Error",
    "message": "...",
    "stack": "..."
  }
}
```

禁止：

```text
dump 整个 Runtime state
dump Environment
```

---

# 49. `--log-format pretty`

本地开发：

```bash
jojo serve --log-format pretty
```

示例：

```text
22:40:10 INFO  server.starting     instance=default
22:40:11 INFO  runtime.ready
22:40:11 INFO  http.listening      address=http://127.0.0.1:7788
22:40:11 INFO  server.ready
```

生产默认仍是 JSON。

---

# 50. 配置热加载

第一阶段：

```text
不支持
```

原因：

Provider、Permission、Channel、Scheduler、Runtime Capability 的重新组合不是简单 reload。

`SIGHUP` 第一阶段只：

```text
打印“不支持 hot reload”
```

或者触发：

```text
log reopen
```

后续才做：

```bash
jojo reload
```

---

# 51. 多实例

天然支持：

```bash
jojo serve --instance-id work
jojo serve --instance-id personal
```

但必须隔离：

```text
runtimeDir
pid
lock
logs
port
```

默认：

```text
instanceId=default
```

目录：

```text
~/.jojo/instances/default/
~/.jojo/instances/work/
```

如果短期不需要多实例，可以：

```text
只保留 instanceId
数据目录仍由用户显式指定
```

---

# 52. 推荐配置目录最终形态

单实例兼容：

```text
~/.jojo/
├── config.yml
├── runtime/
├── logs/
└── run/
```

未来多实例：

```text
~/.jojo/
├── config.yml
├── instances/
│   ├── default/
│   │   ├── runtime/
│   │   ├── logs/
│   │   └── run/
│   └── work/
└── memory/
```

---

# 53. 开发模式

仓库脚本增加：

```json
{
  "scripts": {
    "dev:server": "pnpm --filter @desktop-agent/cli dev -- serve",
    "jojo": "pnpm --filter @desktop-agent/cli jojo"
  }
}
```

运行：

```bash
pnpm jojo serve
```

或：

```bash
pnpm --filter @desktop-agent/cli dev -- serve
```

---

# 54. 发布方式

构建后：

```text
dist/bin.js
```

package bin：

```json
{
  "bin": {
    "jojo": "./dist/bin.js"
  }
}
```

安装：

```bash
npm install -g @desktop-agent/cli
```

或者项目发布后：

```bash
npm install -g jojo-agent
```

最终：

```bash
jojo --version
jojo serve
```

---

# 55. 测试设计

新增：

```text
apps/cli/test/
├── cli.test.ts
├── serve.test.ts
├── config.test.ts
├── logger.test.ts
├── shutdown.test.ts
├── instance-lock.test.ts
└── service-manager.test.ts
```

---

## 55.1 Config Tests

覆盖：

```text
defaults
file
env
CLI
priority
invalid YAML
invalid schema
secret redaction
~ expansion
relative path resolution
```

---

## 55.2 Serve Tests

测试：

```text
jojo serve
```

启动随机 port：

```text
port=0
```

验证：

```text
/healthz
/readyz
/api/v1/server
```

---

## 55.3 Remote Security Tests

必须：

```text
127.0.0.1 without token → OK
0.0.0.0 without allowRemote → reject
0.0.0.0 allowRemote without token → reject
0.0.0.0 allowRemote + token → OK
```

复用现有 server-http 约束。

---

## 55.4 Shutdown Tests

模拟：

```text
SIGTERM
```

验证：

```text
HTTP closed
Channel stopped
Scheduler stopped
State flushed
lock removed
exit=0
```

---

## 55.5 Already Running

第一次：

```text
jojo serve
```

第二次：

```text
jojo serve
```

必须：

```text
INSTANCE_ALREADY_RUNNING
exit 3
```

---

## 55.6 Log Redaction Test

输入：

```text
Authorization: Bearer abc
apiKey: sk-xxx
appSecret: xxx
```

日志：

```text
[REDACTED]
```

禁止出现明文。

---

# 56. 与现有测试体系整合

仓库现有：

```text
packages/runtime-composition/test/headless-runtime.test.ts
apps/server/src/server-runtime.test.ts
packages/server-http/test/http.test.ts
packages/client/test/e2e.test.ts
```

新增 CLI 测试应位于这些测试的上层：

```text
Runtime Composition
        ↑
Server Runtime
        ↑
HTTP Transport
        ↑
CLI Serve
```

这样不要重复测试底层 Agent 行为。

---

# 57. 配置 Schema 示例

```ts
import { z } from 'zod';

const SecretRefSchema = z.object({
  env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/)
});

export const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(7788),
    allowRemote: z.boolean().default(false),
    token: SecretRefSchema.optional()
  }).default({}),

  runtime: z.object({
    dataDir: z.string().default('~/.jojo/runtime'),
    instanceId: z.string().default('default')
  }).default({}),

  logging: z.object({
    level: z.enum([
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal'
    ]).default('info'),

    format: z.enum([
      'json',
      'pretty'
    ]).default('json'),

    file: z.string().optional()
  }).default({}),

  shutdown: z.object({
    timeoutMs: z.number()
      .int()
      .min(1000)
      .default(15000)
  }).default({})
});
```

---

# 58. Config Loader 示例

```ts
export async function loadConfig(
  input: LoadConfigInput
): Promise<EffectiveConfig> {
  const defaults = createDefaults();

  const filePath =
    input.configPath ??
    process.env.JOJO_CONFIG ??
    defaultConfigPath();

  const file = await readConfigIfExists(filePath);

  const env = parseEnvironment(process.env);

  const merged = deepMerge(
    defaults,
    file,
    env,
    input.cliOverrides
  );

  const parsed = ConfigSchema.parse(merged);

  return normalizeConfigPaths(parsed, {
    configFile: filePath
  });
}
```

---

# 59. Logger Factory 示例

```ts
export function createLogger(
  config: LoggingConfig,
  context: {
    instanceId: string;
    version: string;
  }
) {
  return pino({
    level: config.level,

    base: {
      service: 'jojo',
      instanceId: context.instanceId,
      version: context.version,
      pid: process.pid
    },

    redact: {
      censor: '[REDACTED]',
      paths: [
        '*.authorization',
        '*.token',
        '*.apiKey',
        '*.secret',
        '*.appSecret',
        '*.verificationToken',
        '*.encryptKey'
      ]
    }
  });
}
```

---

# 60. Child Logger

```ts
const serverLog =
  logger.child({ component: 'server' });

const httpLog =
  logger.child({ component: 'http' });

const schedulerLog =
  logger.child({ component: 'scheduler' });

const channelLog =
  logger.child({ component: 'channel' });
```

避免每次手写：

```text
component
```

---

# 61. Shutdown Controller 示例

```ts
export function installShutdownHandlers(
  close: () => Promise<void>,
  logger: Logger,
  timeoutMs: number
): void {
  let shuttingDown = false;

  const shutdown = async (
    signal: NodeJS.Signals
  ) => {
    if (shuttingDown) return;

    shuttingDown = true;

    logger.info({
      event: 'server.stopping',
      signal
    });

    try {
      await withTimeout(
        close(),
        timeoutMs
      );

      logger.info({
        event: 'server.stopped'
      });

      process.exitCode = 0;
    } catch (error) {
      logger.error({
        event: 'server.stop_failed',
        error
      });

      process.exitCode = 8;
    }
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
```

生产实现最好不要直接在 helper 内 `process.exit()`。

---

# 62. CLI 输出与日志区分

CLI 用户输出：

```text
Jojo server started:
  http://127.0.0.1:7788
```

系统日志：

```json
{
  "event":"server.started"
}
```

二者不要混为一套。

建议：

```text
stdout
  CLI / machine-readable output

stderr
  human error

logger
  operational logs
```

如果 JSON log 输出 stdout，则命令型 JSON 输出需避免冲突。

因此：

```text
jojo serve
  stdout = logs

jojo status --json
  stdout = result
```

`status` 本身不要初始化长期 log transport。

---

# 63. `--quiet`

建议：

```bash
jojo serve --quiet
```

只保留：

```text
warn+
```

而：

```bash
jojo status --quiet
```

只输出状态字符串。

---

# 64. 版本信息

```bash
jojo --version
```

建议：

```text
jojo 0.1.0
protocol 1
node 24.10.1
```

`/api/v1/server` 同样应该暴露：

```text
server version
protocol version
instance ID
```

方便 Client 诊断。

---

# 65. 启动 Banner

不要使用大型 ASCII art。

生产默认：

```text
Jojo Agent 0.1.0
Server: http://127.0.0.1:7788
Config: /home/user/.jojo/config.yml
Data:   /home/user/.jojo/runtime
```

如果 JSON log：

可以完全不输出 banner。

---

# 66. 推荐实施阶段

## M1：CLI 基础

新增：

```text
apps/cli
```

完成：

```text
jojo --version
jojo serve
jojo config validate
```

`serve` 直接复用 `createNetworkServer()`。

---

## M2：统一配置

完成：

```text
config.yml
env overrides
CLI overrides
EffectiveConfig
secret refs
path normalization
```

验收：

```bash
jojo serve --check
```

---

## M3：日志

引入：

```text
Pino
root logger
child logger
redaction
Fastify logger bridge
```

完成：

```bash
jojo serve --log-level debug
```

---

## M4：生命周期

完成：

```text
SIGINT
SIGTERM
shutdown timeout
instance lock
pid
exit codes
uncaught fatal
```

---

## M5：状态与诊断

完成：

```text
jojo status
jojo stop
jojo doctor
jojo logs
```

---

## M6：OS Service

完成：

```text
jojo service install
jojo service start
jojo service stop
jojo service restart
jojo service status
```

Linux：

```text
systemd --user
```

macOS：

```text
launchd
```

---

# 67. 推荐开发顺序

最小可用链：

```text
1. apps/cli
2. jojo serve
3. config loader
4. runtime dependency factory
5. Pino
6. signal shutdown
7. instance lock
8. status
9. doctor
10. systemd
11. launchd
```

不要一开始就做：

```text
Windows Service
hot reload
Prometheus
remote config
多实例 UI
复杂日志 rotation
```

---

# 68. 需要修改的现有文件

## `apps/server/src/index.ts`

原则：

```text
尽量少改
```

可能增加：

```ts
logger?
readiness?
```

但不引入 CLI。

---

## `packages/server-http/src/server.ts`

建议修改：

```ts
JojoHttpServerOptions
```

增加日志注入：

```ts
logger?
```

替换：

```ts
logger: false
```

为统一 Logger Bridge。

---

## `packages/runtime-composition/src/runtime.ts`

已有：

```ts
telemetry?: TelemetrySink
```

通常无需为了 CLI 修改。

---

## root `package.json`

增加：

```json
{
  "scripts": {
    "dev:server": "...",
    "jojo": "..."
  }
}
```

---

## `pnpm-workspace.yaml`

当前 workspace 已覆盖：

```text
apps/*
packages/*
```

通常无需额外修改。

---

# 69. 不建议的架构

## 不建议 1

```text
apps/server/src/index.ts
```

直接：

```ts
parse process.argv
read process.env
read config.yml
create logger
write pid
systemd
launchd
```

这会让 Server Library 失去可嵌入性。

---

## 不建议 2

另写：

```text
JojoCliServer
```

重复 Runtime 装配。

现有：

```text
createHeadlessServer
createNetworkServer
```

应该是唯一 Server composition。

---

## 不建议 3

`jojo serve --daemon` 自己 fork。

优先：

```text
systemd
launchd
```

---

## 不建议 4

把 Provider Secret 写入：

```text
config.yml
```

默认应使用：

```text
env / secure secret reference
```

---

## 不建议 5

每个 package 自建日志格式。

必须统一 Root Logger。

---

# 70. 最终架构

```text
                  ┌────────────────────┐
                  │      jojo CLI      │
                  └─────────┬──────────┘
                            │
       ┌────────────────────┼────────────────────┐
       │                    │                    │
       ▼                    ▼                    ▼
 Config Loader         Logger Factory       Service Manager
       │                    │                    │
       └────────────┬───────┘                    │
                    ▼                            │
           Server Bootstrap                     │
                    │                            │
                    ▼                            │
         createNetworkServer()                  │
                    │                            │
        ┌───────────┼─────────────┐              │
        ▼           ▼             ▼              │
   Server Core   Scheduler    Channel Runtime    │
        │           │             │              │
        └───────────┼─────────────┘              │
                    ▼                            │
          Runtime Composition                   │
                    │                            │
                    ▼                            │
               AgentRuntime                     │
                                                 │
                    ┌────────────────────────────┘
                    ▼
           systemd / launchd
```

---

# 71. 最终用户体验

安装：

```bash
npm install -g jojo-agent
```

初始化：

```bash
jojo config init
```

检查：

```bash
jojo doctor
```

前台启动：

```bash
jojo serve
```

服务安装：

```bash
jojo service install
jojo service start
```

状态：

```bash
jojo status
```

日志：

```bash
jojo logs --follow
```

停止：

```bash
jojo service stop
```

---

# 72. 验收标准

`jojo serve` 产品化完成至少满足：

- [ ] `jojo` 可作为标准 bin 安装；
- [ ] `jojo serve` 可 foreground 运行；
- [ ] 直接复用现有 `createNetworkServer()`；
- [ ] 默认监听 `127.0.0.1:7788`；
- [ ] Remote bind 必须 `allowRemote + token`；
- [ ] YAML 配置可用；
- [ ] CLI / env / config / default 优先级固定；
- [ ] secret 默认使用引用而非明文；
- [ ] `jojo serve --check` 可用于启动前检查；
- [ ] Pino 统一结构化日志；
- [ ] Fastify 接入统一 logger；
- [ ] requestId 可关联 HTTP 日志；
- [ ] Agent 日志可关联 sessionId / runId；
- [ ] secret 自动 redact；
- [ ] SIGINT / SIGTERM graceful shutdown；
- [ ] shutdown timeout；
- [ ] instance lock；
- [ ] PID / runtime status；
- [ ] `jojo status`；
- [ ] `jojo logs`；
- [ ] `jojo doctor`；
- [ ] systemd user service；
- [ ] macOS launchd；
- [ ] service 自动 restart on failure；
- [ ] 配置、daemon、shutdown、日志脱敏有自动化测试。

---

# 73. 结论

基于 Jojo Agent 当前代码，`jojo serve` 的核心 Server 能力实际上已经基本存在：

```text
Runtime
Server Core
REST
WebSocket
State Recovery
Scheduler
Channels
```

现在真正缺的是一个**产品运行层**。

因此最佳方案不是新增另一套 Server，而是：

```text
新增 apps/cli
    ↓
统一 Config
    ↓
统一 Logging
    ↓
Server Bootstrap
    ↓
createNetworkServer()
    ↓
OS Service Manager
```

其中最关键的边界是：

```text
apps/server
    = 可嵌入 Server Library

apps/cli
    = 可执行产品入口

runtime-composition
    = Runtime 装配

server-http
    = Transport

systemd / launchd
    = 守护进程
```

这样未来 Electron Desktop、Headless Server、Docker、NAS、远程机器甚至 system service 都能继续复用同一套 Jojo Runtime，而不会让 CLI / daemon 逻辑侵入 Agent 核心。
