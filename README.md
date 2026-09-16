# SKF

## 快速开始（M27 候选版；npm 发布仍需 tag 工作流与 owner 凭据）

**前提：Windows x64、Node 24.20.0 + npm。当前实际验证的最低补丁就是 24.20.0；Node 24 更高补丁仍需相应 CI 验证，不宣称 Node 22/25 或 ARM64 已通过。** `node:sqlite`/FTS5 随 Node 提供。CLI/Web 不依赖 Tauri 或 WebView2。

`skf` npm 名已被占用；候选包名改为 **`skf-agent`**。本仓库状态只表示发布元数据已准备，**不证明名称可用/已保留/已发布**。正式发布必须走 tag 触发的 GitHub Actions provenance/OIDC 工作流和 owner 控制的 npm 凭据。

本机完成 `npm pack` 后，先校验下载物，再安装；第三条会启动 Web UI，按终端提示在本机输入一次性配对码，再发送消息。第一轮云回复依赖有效凭据，Ollama 则需要已运行的服务和已下载的模型；本轮验收仅用了 localhost 假模型。

```powershell
Get-FileHash "D:\SKF-Work\evidence\M27\independent-review\pack\skf-agent-0.4.4.tgz" -Algorithm SHA256
# 与对应 evidence pack-checks.json / 发布页公示的 SHA256 核对一致后再安装
npm.cmd install --global --prefix "$env:LOCALAPPDATA\SKF\npm" "D:\SKF-Work\evidence\M27\independent-review\pack\skf-agent-0.4.4.tgz" --omit=dev --ignore-scripts
& "$env:LOCALAPPDATA\SKF\npm\skf.cmd" onboard
& "$env:LOCALAPPDATA\SKF\npm\skf.cmd" start
```

其他机器需把第一行 tarball 路径换为自己收到并核验的候选包路径。npm 可能联网安装生产依赖，但没有安装脚本、模型权重、完整浏览器或后台工具链下载。上述普通用户真实安装、外网依赖获取和首次云回复**未作为已完成验收**；现有证据是本地打包、离线生产依赖重定位、假模型回复与浏览器操作。

### 没有 Node：PowerShell 安装入口

源码入口是 [`scripts/install.ps1`](scripts/install.ps1)：

```powershell
powershell -NoProfile -File .\scripts\install.ps1
```

**当前必定返回 `RELEASE_NOT_CONFIGURED`，不联网、不安装、不改 PATH。** 项目尚未提供官方固定 HTTPS 发行域名、发布者证书/签名权限与真实签名发行包，不能复制一条虚构网址让用户执行。未来只有经发布者审核、固定发行版本/主机/签名指纹并签名的入口，才会校验签名清单、CAT、ZIP SHA256、逐文件哈希及 Node Authenticode，安装在 `%LOCALAPPDATA%\Programs\SKF`，仅合并当前用户 PATH；不要求管理员，不修改执行策略，不碰系统 Node。它不下载模型、CUDA 或完整浏览器。

安装器提供拒绝不可信文件、归档路径防护、用户目录 ACL、旁路保留旧版本及 shim 替换失败回滚；这些有本地故障注入测试。**没有已签名线上安装/升级的验收结论。** 当前无可公布的 GUI 下载链接；源码在 `src-tauri/`，M27 已做离线 Rust 检查和真实浏览器/原生桥测试，未交付新签名 MSI/NSIS，也未启动真实 Tauri 窗口验收。旧里程碑的 GUI 安装包不冒充 M27。

### 两条连接路径

- **云：**`skf.cmd onboard` → 选择 Kimi / DeepSeek / OpenAI（或兼容服务）→ 核实官方端点或明确确认自定义端点 → 在本机隐藏输入框输入 key → 自动发现或手动填写准确模型 ID → 本地数据目录 → 阅读推理测试费用提示，选择跳过也能保存。不要把 key 放入命令参数、URL、聊天、脚本、屏幕录制、日志或仓库。
- **本地：**先自行安装并运行 Ollama、下载一个适合本机的模型，再执行 `skf.cmd onboard` → Ollama → `http://127.0.0.1:11434/v1` → key 可留空 → 选择服务里实际存在的模型 ID → 保存。vLLM / 兼容服务可填本机或自己信任的 HTTPS OpenAI 兼容端点。SKF 不自动安装这类服务，服务可用性与显存需求另行验证。

向导再次运行已配置则跳过；`onboard --force` **保留已有数据并添加替代连接**，不会静默清空旧连接。任意一步取消均不保存未提交内容；模型发现不推理，推理测试需明确同意费用。新增模型工具能力默认关闭，标记模型支持工具也不意味着批准工具。

### 日常命令与 GUI 共存

```text
skf.cmd start --headless       # 不打开浏览器；也可 --no-open / --foreground
skf.cmd status
skf.cmd pair                   # 仅本机交互终端显示短效一次性配对码
skf.cmd chat                   # 在运行中的同一 Supervisor 新建终端会话
skf.cmd model list
skf.cmd model add
skf.cmd model edit <model-id>
skf.cmd model set-default <model-id>
skf.cmd model test <model-id>
skf.cmd model remove <model-id>
skf.cmd model key replace <provider-id>
skf.cmd model provider remove <provider-id>
skf.cmd doctor
skf.cmd stop
```

GUI 的「设置 → 模型与 API」与 CLI 共用同一配置服务。一个数据目录只有一个核心；关闭窗口不等于停止后台。旧会话绑定原模型快照，修改默认只影响新会话；删连接/改端点会让旧绑定明确失败，而不是悄悄换模型。所有写入需要 expectedRevision；旧协议/新 schema 拒绝写入。

高级受控自动化可用 `model key replace <id> --credential-stdin --trust-endpoint` 的**专用非 TTY 输入管道**；只接收一条凭据、限长、拒绝控制字符，不接受参数值或通用 stdin 交互。生产部署由主机凭据系统提供输入，不在终端命令、历史、测试输出中拼接真实 key。一般用户使用隐藏交互输入。

### 数据、凭据与权限

- 默认配置：`%LOCALAPPDATA%\SKF\config\models.json`（无密钥、含 revision）、`config.env`（密钥与路径）。默认数据：`%LOCALAPPDATA%\SKF\data`。安装位置与运行数据分离。
- 参数 > 环境变量 > 文件 > 默认；`--config-dir` / `--data-dir` 与 `SKF_CONFIG_DIR` / `SKF_DATA_DIR` 及旧别名的实际覆盖会在 status/onboard 显示。环境变量覆盖时，UI 不假装已改成功。只显示变量名/来源，不显示值。
- 单写者、跨进程锁、受限临时文件+原子替换与无密钥事务标记负责恢复；Windows 实际 ACL 仅当前用户与 SYSTEM。备份数据不要顺带备份 `config.env` 或 `instance.json`。诊断排除这两类文件、进程环境、请求头、原始服务响应和 heap dump。
- 网络共享、OneDrive 与 symlink/junction 不作为数据目录支持。初始目录已有运行账本、切换已有数据目录或旧配置迁移时需要人工核对，不自动迁移凭据/恢复历史高风险定时任务。
- API 永远只返回统一掩码 `********`，短 key 也全遮；只有替换接口，没有读取接口。自定义或变更端点需重新确认凭据去向。JS/浏览器内存无法保证密码字符串立即物理擦除；不要采集生产 heap dump 或含密码的屏幕/崩溃资料。
- Web 管理接口只监听 loopback，包含 Host/Origin/协议/配对认证/CSRF 校验；不要反代公开。首次界面凭据输入框与 CLI 隐藏输入仅供用户本机使用。

### 排障、升级与卸载（保留数据）

`skf.cmd doctor` 检查 Node、SQLite/FTS5、配置 ACL、实例握手与 PATH，输出脱敏 JSON。未找到 shim 时，用上述完整路径；需要在 PATH 中使用短命令，可在 Windows 当前用户环境设置加入 `%LOCALAPPDATA%\SKF\npm` 后重开终端。不要把用户目录装到系统 Program Files，也不要通过管理员重装解决 PATH 问题。PowerShell 拦截 shim 时用 `skf.cmd` / `npm.cmd`，**不要修改全局执行策略**。

升级前 `skf.cmd stop`，等正在执行的任务结束；忙时 stop 会明确拒绝。核实新包与兼容协议，用相同 prefix 安装新候选 tarball；不复制新旧凭据文件混合恢复。签名安装路线保留旧版本目录，仅最后原子切换 shim；PATH 更新失败恢复原 shim。完整断电/跨版本线上升级仍待发布环境验收。

npm 安装卸载：先停止，再 `npm.cmd uninstall --global --prefix "$env:LOCALAPPDATA\SKF\npm" skf-agent --ignore-scripts`。**不要删除 `%LOCALAPPDATA%\SKF\config` 和 `data`，也不要删除自选的数据目录。** 当前尚无已发布 PowerShell 安装需要卸载；未来签名安装用相同已核验入口的 `-Uninstall`，只按签名清单删除验证过的程序文件，存在未列文件或运行中核心则拒绝并保留。卸载不自动删除会话、记忆或凭据；彻底清理须用户另行明确选择。

“五分钟可用”不包含模型/浏览器/语音资源下载，且并非本轮完成的性能承诺。onboard、设默认和安装不会增加 E/P 审批权限；无人值守发布、外发及高风险动作仍保持原审批门槛。

> 发布阻塞：官方 HTTPS 发布源、签名证书与清单、真实 npm 发布/provenance 执行、vendor 许可证清点、干净普通用户安装、真实 GUI/ARM64 及跨版本生产升级验收。`NOTICE` / `SBOM.json` 为当前如实记录，不代表所有 vendor 资源已获再发布许可。

---

**SKF 是一个 Windows 原生的个人 AI 桌面身体**——不是聊天机器人，而是一个能持久记忆、调用工具、执行任务、自主恢复的个人智能体运行时。

> 定位：像 OpenClaw/Hermes 一样的自建 AI 搭档，但面向 Windows 原生桌面 + 中文 + 严谨的工程可靠性（状态机 / 幂等 / 预算 / 崩溃恢复 / 48h 长稳）。

## 特性

- **统一记忆 v2**：SQLite + FTS5 + 本地 bge-m3 语义检索，事实带来源/信任级/更正链（supersedes），跨框架可迁移
- **多模型大脑**：OpenAI 兼容 provider 协议，支持推理模型（reasoning_content 回传）、工具调用、预算记账
- **持久执行账本**：任务/操作/事件全落 SQLite，CAS 状态机 + fencing lease + 崩溃恢复（副作用 unknown 不自动重放）
- **安全工具层**：路径防护（junction/symlink 拒绝）、create-only + expectedSha256、effect 分级审批门（read 直行 / external_write·process 审批绑定参数 hash）
- **MCP 工具层**：白名单本地 stdio server，Job Object 进程树管理，双阶段防注入
- **cron 持久调度**：`cron:<id>:<gen>:<scheduledAt>` 幂等键，DST/时钟倒退/错过补偿
- **学习闭环**：终态证据快照 → 候选经验 → 运行时检查点（内核强制），首版人工确认不自动晋级
- **桌面/浏览器/媒体工具**：UIA 读屏、浏览器 CDP、ComfyUI 出图、Whisper 转写、CosyVoice 配音
- **预算控制**：整数微货币、并发事务预留、uncertain 保守、strict-money / call-limit / local-only
- **控制台 UI**：多会话、任务卡、记忆检索、技能、定时任务、预算面板、审批中心

## 技术栈

- Tauri 2（Rust 壳）+ 原生 JavaScript 前端（非 React）
- TypeScript 内核 + Node 24（`node:sqlite`，零第三方数据库依赖）
- 记忆运行时 vendored（纯 node:sqlite，无 npm 依赖）

## 架构

```
Tauri/UI ── typed IPC ── TaskService / EventStore
                              │
                       AgentLoop（同一内核）
                       ├─ ContextAdapter → 统一记忆
                       ├─ ModelGateway → BudgetLedger → Provider
                       ├─ ToolRegistry → PolicyGate → Local tools / MCP
                       ├─ ArtifactVerifier
                       └─ Durable checkpoints / operations / outbox
```

## 目录

- `src/runtime/` — 内核：账本、任务服务、AgentLoop、预算、恢复、IPC
- `src/providers/` — 模型适配器（协议、kimi、deepseek、astra、local）
- `src/tools/` / `src/mcp/` / `src/desktop/` / `src/browser/` / `src/media/` / `src/scheduler/` / `src/learning/` — 工具族
- `ui-preview/` — 前端（原生 JS）
- `src-tauri/` — Tauri 壳与原生桥
- `tests/` — 验收测试（含故障注入）

## 许可

MIT
