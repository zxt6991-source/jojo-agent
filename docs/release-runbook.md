# 发布与回滚操作手册

## 自动验证与候选产物

`.github/workflows/release.yml` 支持 `v<package.json.version>` 标签及手动触发。版本标签必须与根目录、Desktop package 和 BUILD_COMPATIBILITY 一致。标签构建要求签名；手动构建默认产出未签名候选包，可开启 signed 输入。

流程：完整测试与 Electron 开发构建回归 → Linux x64 / Windows x64 / macOS arm64 原生 Runner → 两端应用契约测试 → Forge make → 签名校验（启用签名时）→ SPDX SBOM → SHA-256 与版本/提交/格式兼容性清单 → 上传 Actions 候选产物。

三个平台分别产生 `candidate-<platform>-<arch>-<commit>`。下载解压后执行：

```sh
pnpm release:verify /absolute/path/to/candidate
```

校验器拒绝缺失、额外、篡改文件、非法相对路径以及不一致的 SHA256SUMS。清单与校验和都包含在产物中；它们验证传输完整性，不能单独证明发布者身份。应从对应受信任的 Actions run 下载，并核对清单 commit 与 tag。SBOM 来自同一构建工作区的 Syft 扫描，描述源码/锁文件依赖，并非对 ASAR 中每个打包文件的完整二进制归属证明。

当前工作流上传候选包，不自动公开 Release。源码 Electron E2E 成功不能代替签名后安装包启动验证。

## 签名配置

创建受保护的 GitHub Environment `release-signing`，限制可使用它的分支/标签，配置 reviewer 和以下 secrets：

| 平台 | Secrets |
| --- | --- |
| macOS | APPLE_CERTIFICATE_BASE64、APPLE_CERTIFICATE_PASSWORD、APPLE_KEYCHAIN_PASSWORD、APPLE_SIGN_IDENTITY、APPLE_ID、APPLE_APP_PASSWORD、APPLE_TEAM_ID |
| Windows | WINDOWS_CERTIFICATE_BASE64、WINDOWS_CERTIFICATE_PASSWORD |

macOS P12 导入临时 keychain；Windows PFX 放入 Runner 临时目录。证书和临时 keychain 在 always 清理步骤删除，不进入候选包。Forge 启用 osxSign/osxNotarize 及 Windows executable / Squirrel 签名；缺少必要凭据会失败，不降级成未签名发布。工作流随后执行 macOS codesign、spctl、stapler，以及 Windows Authenticode 校验。

本地签名构建可设置同名环境变量和 `JOJO_SIGN_RELEASE=1`；Windows 本地用 `WINDOWS_CERTIFICATE_FILE` 指向证书，macOS 证书须预先导入 keychain。不要将证书密码写入命令行或提交配置。

配置依据：[Forge macOS 签名与公证](https://www.electronforge.io/guides/code-signing/code-signing-macos)、[Forge Windows 签名](https://www.electronforge.io/guides/code-signing/code-signing-windows)、[Syft SBOM Action](https://github.com/anchore/sbom-action)。

## 安装、升级和公开发布门禁

发行负责人在干净 VM/用户目录上验证候选包，记录版本、commit、清单 SHA-256、Actions URL、测试 OS 与证据位置。未完成项目保持 pending，不填写通过：

| Gate | 必须记录的实际结果 |
| --- | --- |
| macOS arm64 ZIP | 解压/安装、Gatekeeper、首次启动、退出重启、safeStorage、Worker、浏览器沙箱 |
| Windows x64 Squirrel | 安装、开始菜单、启动、退出重启、safeStorage、Worker、终端进程树、重装、卸载 |
| Linux x64 Deb | 安装、依赖、桌面启动、Worker、Server/CLI 基本工作流 |
| N-1 → N | 用上一正式安装包生成会话/配置/Memory/权限/MCP trust/Scheduler/Team/Channel/Workflow/Browser recording，退出、备份、安装 N、迁移、运行一轮、重启读回并核对逻辑数据 |
| 回滚 | 恢复升级前备份到新目录，用 N-1 读取；确认原 N 数据目录仍保留 |

仓库已有 schema/JSONL 迁移和 Electron 重启用例，但没有上一正式版本的真实安装产物 fixture，不能将这些测试标为完整 N-1 安装升级验收。代码签名服务和干净 VM 的实际结果需在首次发布配置完成后补齐。

所有 Gate 通过后创建 Draft Release：确认 tag 指向候选 manifest 的 commit，按平台保留完整候选目录（包括 SBOM、manifest、SHA256SUMS），避免同名清单互相覆盖。发布说明列出当前兼容格式、已验证平台、升级和回滚步骤。草稿资产下载后再次运行校验及安装冒烟，再转为公开 Release；不要重建或重签已经验证的资产。更新任何资产均应重新生成校验清单并重跑对应 Gate。

## 离线数据备份与恢复

先退出 Desktop、Server、CLI 和所有后台 Worker，停止 launchd/systemd/计划任务。备份 Desktop userData 和 Server 数据根目录各一份；用户项目及应用外 Memory 根目录也需单独保存。脚本不能证明所有外部写入者已停止，`--offline` 是操作者对这一前置条件的确认。

```sh
pnpm release:snapshot backup /path/to/userData /backup/jojo-before-upgrade --offline
pnpm release:snapshot verify /backup/jojo-before-upgrade
pnpm release:snapshot restore /backup/jojo-before-upgrade /path/to/restored-userData --offline
```

目标父目录必须存在，目标目录必须不存在。脚本复制所有文件（含 WAL/SHM），校验复制前后源数据与副本 SHA-256，拒绝符号链接和覆盖，验证完成后原子更名临时目录。备份可能包含凭据及聊天正文，必须留在受控本地存储；不要上传到 Actions 或 Release。safeStorage 恢复还依赖原操作系统用户/keychain，跨机器复制文件不保证凭据可解密。

回滚时停止 N，保留其数据目录供排查，将备份恢复到新目录，安装 N-1 后切换到恢复目录。不要让旧版直接打开已经迁移的新版 SQLite，也不要原地编辑 schema version。回滚备份后的新数据不会自动合并，须在切换前另行导出。若新版本包已公开出现问题，停止后续分发、撤回问题候选并发布修复版本；保留原始资产 hash 与事件记录。

## 本地门禁

```sh
pnpm typecheck
pnpm lint
pnpm test:architecture
pnpm docs:check
pnpm test:conformance
pnpm test:release
pnpm test
pnpm test:e2e:electron
```

`test:conformance` 中 Desktop 使用真实 Product、DesktopApprovalBroker 和 Desktop Scheduler；Server 使用真实 Headless Host。它们验证应用语义，不能替代全部 renderer IPC、HTTP/WebSocket、CLI 与实际 Channel/Team/Workflow 调度链路的端到端覆盖。
