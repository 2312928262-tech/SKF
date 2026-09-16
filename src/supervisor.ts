#!/usr/bin/env node
/**
 * SKF · 调度层入口
 * =================================
 * 启动：npm start
 * 交互：终端输入
 *
 * M09：CLI 普通聊天、/astra、IPC v1 chat 全部收敛到 chat-kernel
 * （task-service + model-gateway 同一事件与预算账本）；旧的“单次工具执行后
 * 不回灌”分支已拆除。OpenClaw 桥接是可选增强能力，启动不依赖。
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join as pathJoin, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import ora from 'ora';
import { Brain } from './brain.js';
import { MemoryStore } from './memory/store.js';
import { FactExtractor } from './memory/extractor.js';
import { loadPrompts } from './prompts/loader.js';
import type { ProviderName } from './providers/types.js';
import { loadEnvironment, dataRoot, positiveInt, memoryMode, memoryRoot, memoryScope, memorySessionId, memoryVendorDir, memoryOutboxDir, memoryMaxInputBytes, memorySemantic, budgetMode, budgetDailyMicros, budgetTaskMicros, expensiveProviders, gatewayMaxRetries, openclawBridgeEnabled, openclawBridgeCommand, mcpConfigPath, mcpLauncherPath, learningEnabled, reviewDailyLimit, reviewSuccessSamplePct, reviewRoute } from './runtime/config.js';
import { McpRegistry, loadMcpConfigFile } from './mcp/registry.js';
import { DesktopRegistry, registerDesktopTools } from './desktop/registry.js';
import { InteractService } from './desktop/interact-service.js';
import { buildInteractTools } from './desktop/interact-tools.js';
import { FakeBrowserBridge } from './browser/browser-bridge.js';
import { RealPlaywrightBridge } from './browser/real-playwright-bridge.js';
import { buildBrowserTools } from './browser/registry.js';
import { loadBrowserAllowlist } from './browser/contracts.js';
import { browserEnabled, browserAllowlistConfigPath } from './runtime/config.js';
import { SkillRegistry } from './skill/registry.js';
import { skillDirOf } from './skill/registry.js';
import { FakeWebBridge } from './web/web-bridge.js';
import { buildWebTools } from './web/registry.js';
import { loadWebAllowlist } from './web/contracts.js';
import { webEnabled, webAllowlistConfigPath } from './runtime/config.js';
import { FakeMediaBridge } from './media/media-bridge.js';
import { RealMediaBridge } from './media/real-media-bridge.js';
import { buildMediaTools } from './media/registry.js';
import { mediaEnabled, comfyuiUrl, comfyuiWorkflowPath, whisperPythonPath, whisperScriptPath, ttsPythonPath, ttsScriptPath } from './runtime/config.js';
import { FakeUiaBridge } from './desktop/uia-bridge.js';
import { RealUiaBridge } from './desktop/real-uia-bridge.js';
import { FakeClipboardBridge } from './desktop/clipboard.js';
import { FakeLauncherBridge, RealLauncherBridge, loadLaunchWhitelist } from './desktop/launcher.js';
import { desktopEnabled, desktopLaunchConfigPath, uiaHelperPath, uiaLauncherPath } from './runtime/config.js';
import { runChatTurn, listChatHistory, type ChatKernelDeps } from './runtime/chat-kernel.js';
import { OpenClawBridge } from './tools/openclaw-bridge.js';
import { RuntimeStore } from './runtime/runtime-store.js';
import { TaskService } from './runtime/task-service.js';
import { SessionService } from './runtime/session-service.js';
import type { TaskRecord } from './runtime/task-service.js';
import { ModelGateway } from './runtime/model-gateway.js';
import { MemoryAdapter, MemoryError } from './runtime/memory-adapter.js';
import { assembleContext, formatContextReport, type AssembledContext } from './runtime/context-adapter.js';
import { tariffConfigured, TARIFF_VERSION } from './runtime/usage.js';
import { TaskControllerRegistry, deliverMemoryOutbox, MEMORY_OUTBOX_KIND, type MemoryOutboxEntry } from './runtime/recovery.js';
import type { JSONValue } from './runtime/contracts.js';
import { ToolRegistry } from './tools/registry.js';
import {
  EventBroadcaster,
  IPC_V2_PUBLIC_ERRORS,
  IpcV2Router,
  TaskWorker,
  toPublicErrorCode,
} from './runtime/ipc-v2.js';
import { ScheduleService } from './scheduler/schedule-service.js';
import { startSchedulerEngine, type EngineHandle } from './scheduler/engine.js';
import { LearningService } from './learning/learning-service.js';
import { ConfigService, FileLock } from './config/config-service.js';
import { ManagedModels } from './config/runtime-models.js';

// ─────────────────────────────────────
// 配置（必须在加载 .env 之后求值）
// ─────────────────────────────────────

const IPC_MODE = process.argv.includes('--ipc');

// stdout is reserved for JSONL frames in IPC mode.
if (IPC_MODE) console.log = (...args: unknown[]) => console.error(...args);
loadEnvironment();
const managedDataLock = process.env.SKF_MANAGED_INSTANCE === '1' ? new FileLock(pathJoin(dataRoot(), '.supervisor.lock')) : null;
managedDataLock?.acquire();
process.on('exit', () => managedDataLock?.release());

const MEMORY_MODE = memoryMode(); // 'vault'(默认,只写统一主档) | 'legacy'(回退旧 L1-L5)
const MEMORY_CHANNEL: 'ipc' | 'cli' = process.argv.includes('--ipc') ? 'ipc' : 'cli';

const CONFIG = {
  version: '0.4.4',
  defaultProvider: (process.env.XIAOLIU_PROVIDER ||
    (process.env.SKF_LOCAL === '1' || process.env.SKF_LOCAL_BASE_URL ? 'local' :
     process.env.KIMI_API_KEY ? 'kimi' :
     process.env.OPENAI_API_KEY ? 'astra' :
     process.env.DEEPSEEK_API_KEY ? 'deepseek' :
     process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== 'your-key-here' ? 'openrouter' : 'mock')) as ProviderName,
  debug: process.env.XIAOLIU_DEBUG === '1',
  smartContext: process.env.XIAOLIU_SMART_CONTEXT !== '0',  // 默认开
};

// ─────────────────────────────────────
// 启动 banner
// ─────────────────────────────────────

function printBanner() {
  console.log();
  console.log(chalk.cyan.bold('  ╔═══════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('  ║') + chalk.white.bold('   SKF v' + CONFIG.version + ' · 新身体上线   ') + chalk.cyan.bold('║'));
  console.log(chalk.cyan.bold('  ╚═══════════════════════════════════════╝'));
  console.log(chalk.gray('  用户：') + chalk.white('SKF（我）'));
  console.log(chalk.gray('  大脑：') + chalk.white(CONFIG.defaultProvider) + chalk.gray('（主 kimi / 副 deepseek / 副 GPT-6）'));
  console.log(chalk.gray('  记忆：') + chalk.white(MEMORY_MODE === 'vault' ? '统一主档 D:/Xiaoliu-Memory/vault（唯一真源）' : '旧 L1-L5（legacy 回退模式）'));
  console.log(chalk.gray('  四肢：') + chalk.white('有界 file 工具（任务内）+ 可选 OpenClaw 桥（unavailable 不影响本地）'));
  console.log();
  console.log(chalk.gray('  输入消息开始对话，') + chalk.yellow('Ctrl+C') + chalk.gray(' 退出，') + chalk.yellow('/help') + chalk.gray(' 看指令。'));
  console.log();
}

// ─────────────────────────────────────
// 主循环
// ─────────────────────────────────────

async function main() {
  if (!IPC_MODE) {
    printBanner();
  }

  // 1. 加载 pre-prompts
  const prompts = await loadPrompts();
  if (CONFIG.debug) console.log(chalk.gray('[debug] 加载 prompts：'), Object.keys(prompts));

  // 2./3. 初始化记忆层
  // vault 模式：只接统一主档（MemoryAdapter），旧 L1-L5 完全不初始化、不双写。
  // legacy 模式：旧 MemoryStore 原样运行（回退通道），主档不被触碰。
  let memory: MemoryStore | null = null;
  let extractor: FactExtractor | undefined;
  let adapter: MemoryAdapter | null = null;
  let coreIdentity = '';
  let lastAssembled: AssembledContext | null = null;
  let lastGatherDegraded = false;

  if (MEMORY_MODE === 'legacy') {
    // M06：抽取不再自持 SDK key；启用与否仍由 SKF_FACT_EXTRACTION=1 控制，调用经 ModelGateway。
    extractor = new FactExtractor({
          factsDir: pathJoin(dataRoot(), 'memory', '03-facts'),
          verifyRounds: 3,
        });
    memory = new MemoryStore({ root: pathJoin(dataRoot(), 'memory'), extractor });
    await memory.init();
    coreIdentity = await memory.readCore();
  } else {
    adapter = new MemoryAdapter({
      root: memoryRoot(),
      scope: memoryScope(),
      sessionId: memorySessionId(MEMORY_CHANNEL),
      vendorDir: memoryVendorDir(),
      outboxDir: memoryOutboxDir(),
      semantic: memorySemantic(),
      maxInputBytes: memoryMaxInputBytes(),
    });
    await adapter.init();
    if (!adapter.available) {
      console.error('[memory] 统一主档暂不可用，进入有意识无记忆模式（任务输入保留，写回排队）。');
    }
  }

  // legacy 模式专用别名：标记为 legacyMemory 的路径只在 legacy 模式可达（vault 由 adapter 接管）。
  const legacyMemory = memory as MemoryStore;

  // 会话内最近对话（prepare.recent，最多 8 段；IPC 模式从任务账本取）
  const recentTurns: Array<{ role: string; content: string }> = [];
  const pushRecent = (role: string, content: string) => {
    recentTurns.push({ role, content });
    if (recentTurns.length > 8) recentTurns.splice(0, recentTurns.length - 8);
  };

  // M09：聊天内核的记忆上下文。返回完整 system 文本（brainSystemPrompt + 记忆/检索拼装），
  // 主档不可用时降级为 brainSystemPrompt（与旧行为一致），绝不阻塞聊天。
  const chatPrepareContext = async (task: TaskRecord): Promise<string | null> => {
    lastGatherDegraded = false;
    const inputObj = task.input !== null && typeof task.input === 'object' && !Array.isArray(task.input)
      ? (task.input as Record<string, unknown>)
      : {};
    const query = typeof inputObj.message === 'string' ? inputObj.message : '';
    const channel = typeof inputObj.channel === 'string' ? inputObj.channel : '';
    if (MEMORY_MODE === 'legacy') {
      const gathered = CONFIG.smartContext ? await legacyMemory.gatherSmart(query) : await legacyMemory.gather(query);
      return [brainSystemPrompt, gathered].filter(Boolean).join('\n\n---\n\n');
    }
    if (!adapter!.available) return brainSystemPrompt;
    try {
      // IPC 通道的 recent 从统一账本按会话取最近成功聊天；CLI 用会话内 recentTurns。
      // M23：按 task.sessionId 过滤，A 会话上下文不掺入 B 会话消息。
      const recent = channel === 'ipc' && taskService
        ? listChatHistory(taskService, 30)
            .filter((h) => h.sessionId === task.sessionId)
            .filter((h) => h.id !== task.id && h.state === 'succeeded' && h.text)
            .slice(-4)
            .flatMap((h) => [{ role: 'user', content: h.message }, { role: 'assistant', content: h.text }])
            .slice(-8)
        : recentTurns;
      const { prepared } = await adapter!.prepare({
        requestId: `${adapter!.sessionId}:prepare:${task.id}`,
        query,
        system: brainSystemPrompt,
        recent,
        ...(task.sessionId ? { sessionId: task.sessionId } : {}),
        ...(task.scope ? { scope: task.scope } : {}),
      });
      const assembled = assembleContext(prepared, { maxBytes: memoryMaxInputBytes() });
      lastAssembled = assembled;
      return [brainSystemPrompt, assembled.text].filter(Boolean).join('\n\n---\n\n');
    } catch (err) {
      lastAssembled = null;
      lastGatherDegraded = true;
      const code = err instanceof MemoryError ? err.code : String(err);
      console.error('[memory] 主档不可用，本轮无记忆模式: ' + code);
      return brainSystemPrompt;
    }
  };

  // 4. 初始化大脑
  const brainSystemPrompt = [prompts.IDENTITY, coreIdentity, prompts.MEMORY, prompts.TOOLS].filter(Boolean).join('\n\n---\n\n');
  const brain = new Brain({
    provider: CONFIG.defaultProvider,
    systemPrompt: brainSystemPrompt,
    debug: CONFIG.debug,
  });
  // M12(P02)：预热协议能力缓存（纯本地调用，零网络）；ping 的 toolExecution 与
  // task.start 的工具能力闸门以它为准，provider 不支持工具时如实标 false。
  for (const name of brain.listProviders()) {
    void brain.capabilitiesFor(name).catch(() => null);
  }

  // 5. M09 · 工具面：AgentLoop 唯一可见的是 ToolRegistry（file.* + 显式装配的桥接工具）。
  //    OpenClaw 桥接是可选增强：启动不等待、不依赖；探测失败负缓存 60s，无重连风暴。
  const bridge = new OpenClawBridge({
    enabled: openclawBridgeEnabled(),
    command: openclawBridgeCommand(),
    logger: (line) => console.error(line),
  });

  // 5a. M17 · 桌面工具层（Fake 桥默认装配；Real 桥由 SKF_DESKTOP=1 启用，本卡首版不在生产路径跑 UIA）。
  //     启动白名单按配置加载（缺失 = 空数组 → desktop.launch 永远 LAUNCH_DENIED）。
  let launchWhitelist: ReturnType<typeof loadLaunchWhitelist> = [];
  try {
    if (existsSync(desktopLaunchConfigPath())) {
      launchWhitelist = loadLaunchWhitelist(readFileSync(desktopLaunchConfigPath(), 'utf8'));
      console.error(`[desktop] launch whitelist loaded × ${launchWhitelist.length}`);
    } else {
      console.error('[desktop] launch whitelist not configured; desktop.launch will return LAUNCH_DENIED');
    }
  } catch (err) {
    console.error('[desktop] launch whitelist load failed; LAUNCH_DENIED: ' + (err instanceof Error ? err.message : String(err)));
  }
  const useRealUia = desktopEnabled() && process.platform === 'win32';
  const uiaBridge = useRealUia
    ? new RealUiaBridge({ helperPath: uiaHelperPath(), launcherPath: uiaLauncherPath(), logger: (line) => console.error(line) })
    : new FakeUiaBridge([]);
  if (process.env.SKF_MANAGED_INSTANCE === '1' && uiaBridge instanceof FakeUiaBridge) uiaBridge.setHealth({state:'uia_unavailable',detail:'Desktop helper unavailable in this environment'});
  const fakeClipboard = new FakeClipboardBridge(process.env.SKF_MANAGED_INSTANCE === '1' ? {state:'unavailable',detail:'Native clipboard helper not installed'} : undefined);
  const fakeLauncher = process.env.SKF_MANAGED_INSTANCE === '1' ? new RealLauncherBridge(launchWhitelist) : new FakeLauncherBridge(launchWhitelist);
  const desktop = new DesktopRegistry({
    uia: uiaBridge,
    clipboard: fakeClipboard,
    launcher: fakeLauncher,
  });
  if (useRealUia) {
    console.error('[desktop] SKF_DESKTOP=1; RealUiaBridge（C# UIA helper + JobLauncher）启用');
  }

  const toolRegistry = new ToolRegistry(bridge.specs());
  // M17：装配 desktop.* / clipboard.* 工具（五个 ToolSpec）。SKF_DESKTOP=1 时 UIA 走真实桥，
  // 否则 Fake 桥（测试/dev）。clipboard/launcher 真实实现不在本卡范围，仍为 Fake。
  try {
    registerDesktopTools(toolRegistry, desktop);
    console.error('[desktop] tools registered: desktop.windows, desktop.snapshot, clipboard.read, clipboard.write, desktop.launch');
  } catch (error) {
    console.error('[desktop] 装配失败（不旁路注册，desktop 工具不可用）: ' + (error instanceof Error ? error.message : String(error)));
  }
  void bridge.status().then((s) => {
    if (s.state === 'available') console.error(`[bridge] OpenClaw 桥接可用（${s.version}）`);
    else if (s.state === 'unavailable') console.error(`[bridge] OpenClaw 不可用：${s.reason}（本地功能不受影响）`);
  });

  // 5b. M14 · MCP 工具层（可选）：白名单本地 stdio server 经 JobLauncher（Windows Job
  //     Object）进程树托管；配置缺失 = 零 server（特性关闭）；后台拉起不阻塞启动；
  //     进程退出时 killAllSync 尽力收树（启动器 stdin 断裂亦会触发 Job 收树，双保险）。
  const mcpRegistry = new McpRegistry({ toolRegistry, launcherPath: mcpLauncherPath(), logger: (line) => console.error(line) });
  try {
    for (const serverConfig of loadMcpConfigFile(mcpConfigPath())) {
      try {
        mcpRegistry.registerServer(serverConfig);
      } catch (error) {
        console.error(`[mcp] 注册被拒绝：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    console.error(`[mcp] 配置读取失败（MCP 特性关闭，本地功能不受影响）：${error instanceof Error ? error.message : String(error)}`);
  }
  void mcpRegistry.startAll();
  process.on('exit', () => mcpRegistry.killAllSync());

  // 6. M06 · ModelGateway：所有模型调用的唯一生产出口（预算/路由/重试策略）。
  //    初始化失败 = fail-closed：brain.requireGateway 让云 provider 拒绝调用（BUDGET_UNAVAILABLE），
  //    绝不留一条绕过预算的旁路。
  const dailyLimit = process.env.SKF_MAX_DAILY_CLOUD_CALLS === undefined
    ? undefined : positiveInt('SKF_MAX_DAILY_CLOUD_CALLS', 100);
  // M03/M08：runtime.sqlite 单实例，gateway 与 IPC v2 共用；启动时标识上次崩溃的中断任务
  // （只标识，绝不自动付费重试；interrupted → queued 是用户显式动作，走 M07 预检）。
  let rtStore: RuntimeStore | null = null;
  let taskService: TaskService | null = null;
  let sessionService: SessionService | null = null;
  let scheduleService: ScheduleService | null = null;
  try {
    rtStore = new RuntimeStore(pathJoin(dataRoot(), 'runtime.sqlite'));
    taskService = new TaskService(rtStore);
    scheduleService = new ScheduleService(rtStore);
    // M23：会话持久层；惰性引导默认会话（id=默认 sessionId、scope=默认 memory scope），
    // 让旧聊天任务（沿用历史约定）自然归属默认会话。
    sessionService = new SessionService(rtStore);
    sessionService.ensureDefault(memorySessionId('ipc'), memoryScope());
    const recovered = taskService.recover();
    if (recovered.interrupted.length > 0) {
      console.error(`[runtime] 上次中断任务已标识 interrupted × ${recovered.interrupted.length}（需用户显式恢复）`);
    }
  } catch (err) {
    console.error('[runtime] runtime.sqlite 初始化失败，任务执行与云调用将 fail-closed: ' + (err instanceof Error ? err.message : String(err)));
  }

  // M18：装配 desktop.interact.* 工具（六个 ToolSpec：prepare/execute/status/cancel/reconcile/observe）。
  // InteractService 依赖 runtime.sqlite（execution_plans 表 migration v5）；rtStore 缺失 = interact 工具不注册。
  if (rtStore) {
    try {
      const interactService = new InteractService({
        store: rtStore,
        uia: uiaBridge,
        logger: (line) => console.error(line),
      });
      for (const spec of buildInteractTools({
        service: interactService,
        // 首版指纹解析器：无真实 UIA helper 时返回 null → observe/prepare 如实报 INTERACT_INVALID_INPUT。
        resolveFingerprint: () => null,
      })) {
        toolRegistry.register(spec);
      }
      console.error('[interact] tools registered: desktop.interact.{prepare,execute,status,cancel,reconcile,observe}');
    } catch (error) {
      console.error('[interact] 装配失败（desktop.interact 工具不可用）: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  // M19：装配 browser.* 工具（六个 ToolSpec：navigate/snapshot/text 读 + click/type/fill 写）。
  // SKF_BROWSER=1 时用 RealPlaywrightBridge（playwright + chromium）；否则 FakeBrowserBridge（测试/dev）。
  let realBrowser: RealPlaywrightBridge | null = null;
  {
    try {
      let browserAllowlist: ReturnType<typeof loadBrowserAllowlist> = [];
      if (existsSync(browserAllowlistConfigPath())) {
        browserAllowlist = loadBrowserAllowlist(readFileSync(browserAllowlistConfigPath(), 'utf8'));
        console.error(`[browser] allowlist loaded × ${browserAllowlist.length}`);
      } else {
        console.error('[browser] allowlist not configured; browser.navigate will return BROWSER_DOMAIN_NOT_ALLOWED');
      }
      if (browserEnabled()) {
        realBrowser = new RealPlaywrightBridge({ allowlist: browserAllowlist, logger: (line) => console.error(line) });
        for (const spec of buildBrowserTools({ bridge: realBrowser, currentUrl: () => realBrowser!.getCurrentUrl() })) {
          toolRegistry.register(spec);
        }
        console.error('[browser] SKF_BROWSER=1; RealPlaywrightBridge（playwright+chromium）启用');
      } else {
        const fakeBrowser = new FakeBrowserBridge(browserAllowlist);
        if (process.env.SKF_MANAGED_INSTANCE === '1') fakeBrowser.setHealth({state:'unavailable',detail:'Browser automation is not enabled',allowlistSize:browserAllowlist.length});
        for (const spec of buildBrowserTools({ bridge: fakeBrowser, currentUrl: () => fakeBrowser.getCurrentUrl() })) {
          toolRegistry.register(spec);
        }
      }
      console.error('[browser] tools registered: browser.navigate, browser.snapshot, browser.text, browser.click, browser.type, browser.fill');
    } catch (error) {
      console.error('[browser] 装配失败（browser 工具不可用）: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  // M20：skill 机制（SKILL.md 装载器；只读注入 system 文本，不改权限）。
  // skills 目录 <dataRoot>/skills；缺失 = 零技能。prepareContext 里与 learning bundleText 并列注入。
  const skillRegistry = new SkillRegistry({ dir: skillDirOf(dataRoot()), logger: (line) => console.error(line) });
  const skillLoad = skillRegistry.load();
  console.error(`[skill] loaded ${skillLoad.skills.length} skills, skipped ${skillLoad.skipped.length}`);

  // M22：装配 web.* 工具（web.search / web.fetch，均 read）。FakeWebBridge 默认装配
  // （域名白名单由配置加载；缺失 = 空 = web.fetch WEB_DOMAIN_NOT_ALLOWED）。RealWebBridge 首版未启用。
  {
    try {
      let webAllowlist: ReturnType<typeof loadWebAllowlist> = [];
      if (existsSync(webAllowlistConfigPath())) {
        webAllowlist = loadWebAllowlist(readFileSync(webAllowlistConfigPath(), 'utf8'));
        console.error(`[web] allowlist loaded × ${webAllowlist.length}`);
      } else {
        console.error('[web] allowlist not configured; web.fetch will return WEB_DOMAIN_NOT_ALLOWED');
      }
      const fakeWeb = new FakeWebBridge(webAllowlist);
      if (process.env.SKF_MANAGED_INSTANCE === '1') fakeWeb.setHealth({state:'unavailable',detail:'Web provider is not enabled',allowlistSize:webAllowlist.length});
      for (const spec of buildWebTools({ search: fakeWeb, fetch: fakeWeb })) {
        toolRegistry.register(spec);
      }
      console.error('[web] tools registered: web.search, web.fetch');
      if (webEnabled()) {
        console.error('[web] SKF_WEB=1; RealWebBridge 未启用 → web.* 返回 unavailable');
      }
    } catch (error) {
      console.error('[web] 装配失败（web 工具不可用）: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  // M16：装配 media.* 工具（image/tts/transcribe/vram.manage）。
  // SKF_MEDIA=1 时用 RealMediaBridge（ComfyUI / CosyVoice2 / faster-whisper）；否则 FakeMediaBridge。
  {
    try {
      if (mediaEnabled()) {
        const realMedia = new RealMediaBridge({
          comfyuiUrl: comfyuiUrl(),
          comfyuiWorkflow: comfyuiWorkflowPath(),
          whisperPython: whisperPythonPath(),
          whisperScript: whisperScriptPath(),
          ttsPython: ttsPythonPath(),
          ttsScript: ttsScriptPath(),
          logger: (line) => console.error(line),
        });
        for (const spec of buildMediaTools({ bridge: realMedia })) {
          toolRegistry.register(spec);
        }
        console.error('[media] SKF_MEDIA=1; RealMediaBridge（ComfyUI/TTS/Whisper）启用');
      } else {
        const fakeMedia = new FakeMediaBridge();
        if (process.env.SKF_MANAGED_INSTANCE === '1') fakeMedia.setHealth({state:'unavailable',detail:'Local media services are not enabled'});
        for (const spec of buildMediaTools({ bridge: fakeMedia })) {
          toolRegistry.register(spec);
        }
      }
      console.error('[media] tools registered: media.image, media.tts, media.transcribe, media.vram.manage');
    } catch (error) {
      console.error('[media] 装配失败（media 工具不可用）: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  let gateway: ModelGateway | null = null;
  if (rtStore && taskService) try {
    gateway = new ModelGateway({
      store: rtStore,
      service: taskService,
      config: {
        mode: budgetMode(),
        defaultProvider: CONFIG.defaultProvider,
        expensiveProviders: expensiveProviders(),
        maxRetries: gatewayMaxRetries(),
        dailyCallLimit: dailyLimit,
        dailyBudgetMicros: budgetDailyMicros(),
        taskBudgetMicros: budgetTaskMicros(),
      },
      logger: (line) => console.error(line),
    });
    for (const name of brain.listProviders()) {
      const providerAdapter = brain.adapterFor(name);
      if (!providerAdapter) continue;
      gateway.registerProvider({
        name,
        adapter: providerAdapter,
        model: brain.modelFor(name) ?? name,
        local: name === 'mock' || name === 'fake' || name === 'local',
        // 已实测验证：kimi/deepseek 直连、astra 经代理（9-08 实查）；openrouter/local 未实网验收。
        verified: name === 'kimi' || name === 'deepseek' || name === 'astra',
      });
    }
    brain.setGateway(gateway);
    extractor?.setGateway(gateway);
  } catch (err) {
    gateway = null;
    console.error('[budget] ModelGateway 初始化失败，云调用将 fail-closed（BUDGET_UNAVAILABLE）: ' + (err instanceof Error ? err.message : String(err)));
  }
  brain.requireGateway = true;
  const managedModels = process.env.SKF_MANAGED_INSTANCE === '1' && rtStore && gateway
    ? new ManagedModels(new ConfigService(), rtStore, brain, gateway) : null;
  await managedModels?.refresh();
  if (managedModels && rtStore) {
    const existingSessions = rtStore.db.prepare('SELECT id FROM sessions').all() as {id:string}[];
    for (const session of existingSessions) await managedModels.bind(session.id);
  }

  // M13 · 学习闭环（影子模式）：只观察/记录/评估，不改策略不触发真实任务。
  // rtStore/taskService 缺失 = 特性关闭（learning.* 返回 LEARNING_DISABLED）。
  let learningService: LearningService | null = null;
  if (rtStore && taskService) {
    learningService = new LearningService({
      store: rtStore,
      service: taskService,
      gateway,
      memory:
        MEMORY_MODE === 'vault' && adapter?.available
          ? { record: (input, operationId) => adapter!.record(input, operationId) }
          : null,
      policy: { dailyAutoLimit: reviewDailyLimit(), successSamplePct: reviewSuccessSamplePct() },
      reviewRoute: reviewRoute(),
      enabled: learningEnabled(),
      logger: (line) => console.error(line),
    });
    const requeued = learningService.recoverReviewQueue();
    if (requeued > 0) console.error(`[learning] 接管上次崩溃遗留复盘 × ${requeued}`);
  }

  // ─────────────────────────────────────
  // M09 · 同一聊天内核装配（CLI 交互 / --once / IPC v1 chat 共用一条路径）
  // ─────────────────────────────────────
  const clipText = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

  // 终态记忆写回：vault 与 legacy 各只有一条通道，全路径无双写。
  const flushMemoryOutbox: ((entry: MemoryOutboxEntry) => Promise<void>) | undefined =
    MEMORY_MODE === 'vault' && adapter
      ? async (entry) => {
          const p = entry.payload as {
            taskId?: string; goal?: string; state?: string; errorCode?: string | null;
            sessionId?: string; scope?: string;
            chat?: { message?: string; reply?: string; channel?: string; turn?: number; consult?: string; provider?: string };
          };
          // M23：写回会话自己的 scope/sessionId（隔离边界）；缺省回退 adapter 全局值。
          const sessionId = p.sessionId ?? adapter!.sessionId;
          const scope = p.scope ?? adapter!.scope;
          if (p.chat) {
            const message = p.chat.message ?? '';
            const reply = p.chat.reply ?? '';
            if (p.chat.channel === 'ipc') {
              await adapter!.close({
                operationId: `${sessionId}:close:${entry.taskId}`,
                sessionId,
                scope,
                summary: `SKF IPC 对话: 用户「${clipText(message, 100)}」→ 助手回复 ${reply.length} 字${p.chat.provider ? `（provider=${p.chat.provider}）` : ''}`,
              });
            } else if (p.chat.channel === 'once') {
              await adapter!.close({
                operationId: `${sessionId}:close:${entry.taskId}`,
                sessionId,
                scope,
                summary: `SKF --once 对话: 用户「${clipText(message, 100)}」→ 助手回复 ${reply.length} 字${p.chat.provider ? `（provider=${p.chat.provider}）` : ''}`,
              });
            } else if (p.chat.consult === 'astra') {
              await adapter!.recordEpisode(`Astra 顾问问答: 问「${clipText(message, 100)}」→ 答 ${reply.length} 字`, 'astra-consult', scope);
            } else {
              await adapter!.recordEpisode(`用户: ${clipText(message, 200)}\n助手: ${clipText(reply, 400)}`, `turn-${p.chat.turn ?? entry.taskId}`, scope);
            }
            return;
          }
          await adapter!.close({
            operationId: `${sessionId}:close:${p.taskId ?? entry.taskId}`,
            sessionId,
            scope,
            summary: `SKF 任务 ${p.state ?? 'terminal'}: ${(p.goal ?? '').slice(0, 300)}${p.errorCode ? ` (${p.errorCode})` : ''}`,
          });
        }
      : MEMORY_MODE === 'legacy' && memory
        ? async (entry) => {
            const p = entry.payload as { chat?: { message?: string; reply?: string; turn?: number } };
            if (p.chat) {
              await legacyMemory.writeWork(p.chat.turn ?? 0, { user: p.chat.message ?? '', assistant: p.chat.reply ?? '' });
              await legacyMemory.flush();
            }
          }
        : undefined;

  const controllers = new TaskControllerRegistry();

  let chatDeps: ChatKernelDeps | null = null;
  if (rtStore && taskService && gateway) {
    const chatWorkspaceFor = (sessionId: string): string => {
      const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'default';
      const dir = pathJoin(dataRoot(), 'chat-workspaces', safe);
      try { mkdirSync(dir, { recursive: true }); } catch { /* 写工具将 PATH_ROOT_MISSING，fail-closed */ }
      return dir;
    };
    chatDeps = {
      service: taskService,
      gateway,
      controllers,
      tools: toolRegistry,
      adapterFor: (name) => brain.adapterFor(name as ProviderName),
      prepareContext: chatPrepareContext,
      fallbackSystem: brainSystemPrompt,
      flushMemoryOutbox,
      defaultProvider: () => brain.providerName,
      modelFor: (name) => brain.modelFor(name as ProviderName),
      providerAvailable: (name) => brain.adapterFor(name as ProviderName) !== null,
      workspaceRootFor: chatWorkspaceFor,
      approvalTtlMsFor: (toolName) => {
        const serverId = /^mcp\/([a-z0-9][a-z0-9-]{0,62})\//.exec(toolName)?.[1];
        return serverId ? mcpRegistry.getApprovalTtl(serverId) : 1_800_000;
      },
      bridgeTools: () => bridge.knownTools(),
      mcpTools: () => mcpRegistry.knownToolNames(),
      logger: (line) => console.error(line),
    };
  }

  // M09：旧 tasks/*.json 聊天历史一次性并入统一账本（原文件只读保留；重复导入幂等），
  // 之后 v1 history 与 GUI/CLI 同看一本账；不删用户历史。
  if (taskService) {
    try {
      const legacyImport = taskService.importLegacyChatTasks(pathJoin(dataRoot(), 'tasks'));
      if (legacyImport.imported.length > 0) {
        console.error(`[runtime] 旧聊天历史已并入统一账本 × ${legacyImport.imported.length}（原文件保留）`);
      }
    } catch (err) {
      if ((err as { code?: string })?.code !== 'LEGACY_STORE_UNREADABLE') {
        console.error('[runtime] 旧聊天历史并入失败（不影响启动）: ' + (err instanceof Error ? err.message : String(err)));
      }
    }
    // 启动补投遗留 memory outbox（幂等键固定，重放安全；--test 不写记忆故跳过）。
    if (flushMemoryOutbox && !process.argv.includes('--test')) {
      for (const entry of taskService.pendingOutbox(MEMORY_OUTBOX_KIND, 20)) {
        await deliverMemoryOutbox(taskService, entry as MemoryOutboxEntry, flushMemoryOutbox);
      }
    }
  }

  // ─────────────────────────────────────
  // IPC 模式：stdin JSONL 接收 Tauri 调用，stdout JSONL 回复
  // v1（ping/history/provider/chat）保持兼容；v2（protocol:2）走 M08 路由器：
  // task.start/get/list/cancel/resume/approve、events.since、memory.*、budget.status。
  // 事件推送帧 {event:{eventSeq,...}} 与响应帧 {id,...} 分流；stdout 只发 JSONL。
  // ─────────────────────────────────────
  if (IPC_MODE) {
    // M09：v1 chat 不再走旧 ChatService/tasks.json；与 CLI 共用 chat-kernel
    // （同一 task-service 事件账 + model-gateway 预算账）。
    // M23：按会话串行（同一会话内一次一聊），不同会话可并行——chatBusy 由全局布尔改为按 sessionId 集合。
    const chatBusySessions = new Set<string>();
    const publicErrors = IPC_V2_PUBLIC_ERRORS;

    // M08 · IPC v2 装配：worker（任务异步推进）+ broadcaster（事件推送）+ router（action 白名单）。
    // rtStore/taskService 初始化失败时 v2 不可用（IPC_V2_UNAVAILABLE），v1 聊天仍可降级运行。
    let router: IpcV2Router | null = null;
    let broadcaster: EventBroadcaster | null = null;
    let lifecycleScheduler: EngineHandle | null = null;
    let managedStopping = false;
    if (rtStore && taskService && sessionService) {
      const worker = new TaskWorker({
        service: taskService,
        adapterFor: (name) => brain.adapterFor(name as ProviderName),
        gateway,
        tools: toolRegistry,
        controllers,
        approvalTtlMsFor: (toolName) => {
          const serverId = /^mcp\/([a-z0-9][a-z0-9-]{0,62})\//.exec(toolName)?.[1];
          return serverId ? mcpRegistry.getApprovalTtl(serverId) : 1_800_000;
        },
        // M15：任务终态后调度引擎用它收尾 firing。
        onTaskTerminal: (taskId, terminal) => {
          if (!scheduleService) return;
          try {
            scheduleService.completeFiringForTask(taskId, terminal);
          } catch (error) {
            console.error(`[scheduler] complete firing for task ${taskId} failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          // M13：终态证据快照 → 频率筛选 → 登记复盘（影子模式，不改变原任务终态）。
          if (learningService && terminal.state !== 'waiting_approval') {
            learningService.onTaskTerminal(taskId);
          }
        },
        // M13：AgentLoop 检查点 hooks（影子模式激活时由内核强制执行硬检查点）。
        ...(learningService
          ? {
              learning: {
                onTaskPlanned: (task: TaskRecord) => learningService!.registerTaskCheckpoints(task),
                beforeToolCall: (task: TaskRecord, call: Parameters<LearningService['beforeToolCall']>[1]) => learningService!.beforeToolCall(task, call),
                afterToolCall: (task: TaskRecord, call: Parameters<LearningService['afterToolCall']>[1], operationId: string, ok: boolean) =>
                  learningService!.afterToolCall(task, call, operationId, ok),
                beforeFinalizeSuccess: (task: TaskRecord) => learningService!.beforeFinalizeSuccess(task),
              },
            }
          : {}),
        prepareContext: MEMORY_MODE === 'vault' && adapter
          ? async (task) => {
              if (!adapter!.available) return null;
              try {
                const goal =
                  task.input !== null && typeof task.input === 'object' && !Array.isArray(task.input)
                    ? String((task.input as Record<string, unknown>).goal ?? '')
                    : '';
                const { prepared } = await adapter!.prepare({
                  requestId: `${adapter!.sessionId}:prepare:task:${task.id}`,
                  query: goal || 'SKF 文件交付任务',
                  system: brainSystemPrompt,
                  recent: [],
                  ...(task.sessionId ? { sessionId: task.sessionId } : {}),
                  ...(task.scope ? { scope: task.scope } : {}),
                });
                const memoryText = assembleContext(prepared, { maxBytes: memoryMaxInputBytes() }).text;
                // M13：经验包段（命中注入；标记为不可信数据，candidate 仅参考）。
                const bundleText = learningService?.buildBundleText(task) ?? '';
                // M20：skill 机制（项目声明技能；触发词匹配注入，与 M13 经验分层）。
                const skillText = skillRegistry.bundleFor(goal);
                return [memoryText, bundleText, skillText].filter(Boolean).join('\n\n');
              } catch {
                return null; // 主档暂不可用：最小 system 也能完成文件任务，不阻塞执行
              }
            }
          : undefined,
        flushMemoryOutbox,
        logger: (line) => console.error(line),
      });
      // 上次遗留的 queued 任务（从未开始，重跑无副作用）接管进泵。
      const leftovers = worker.enqueueQueuedLeftovers();
      if (leftovers > 0) console.error(`[worker] 接管上次遗留 queued 任务 × ${leftovers}`);
      const writeFrame = (frame: unknown): boolean => {
        if (output.writableLength > 1_000_000) return false; // 背压：本拍停推，events.since 可补
        return output.write(JSON.stringify(frame) + '\n');
      };
      broadcaster = new EventBroadcaster({ service: taskService, writeFrame });
      broadcaster.start();
      // M15：调度引擎启动（仅在 taskService + scheduleService 可用时）；后台 poll + fence lease。
      let schedulerEngine: EngineHandle | null = null;
      if (scheduleService && gateway) {
        schedulerEngine = startSchedulerEngine({
          scheduleService,
          taskService,
          logger: (line) => console.error(line),
        });
        lifecycleScheduler = schedulerEngine;
        if (!schedulerEngine.isLeader()) {
          console.error('[scheduler] another instance holds the engine lease; running in read-only mode');
        }
      }
      router = new IpcV2Router({
        service: taskService,
        worker,
        controllers,
        memory: MEMORY_MODE === 'vault' ? adapter : null,
        gateway,
        budgetMode: budgetMode(),
        defaultProvider: () => brain.providerName,
        defaultSessionId: memorySessionId('ipc'),
        defaultScope: memoryScope(),
        sessions: sessionService,
        adapterFor: (name) => brain.adapterFor(name as ProviderName),
        modelFor: (name) => brain.modelFor(name as ProviderName),
        bridgeTools: () => bridge.knownTools(),
        mcpTools: () => mcpRegistry.knownToolNames(),
        scheduleService,
        learning: learningService,
        skills: skillRegistry,
        flushMemoryOutbox,
        broadcaster,
        logger: (line) => console.error(line),
        pingData: () => ({
          status: 'ready',
          provider: brain.providerName,
          // M10：当前大脑的默认模型名与预算上限（UI 展示实际配置，不虚构）。
          model: brain.modelFor(brain.providerName) ?? null,
          configured: brain.configured,
          version: CONFIG.version,
          busy: chatBusySessions.size > 0,
          cloudCallsToday: gateway ? gateway.status().daily.calls : 0,
          dailyCloudCallLimit: dailyLimit ?? null,
          dailyMoneyLimitMicros: budgetDailyMicros() ?? null,
          taskMoneyLimitMicros: budgetTaskMicros() ?? null,
          budget: gateway ? ({ mode: budgetMode(), ...gateway.status() } as unknown as JSONValue) : null,
          capabilities: {
            history: true,
            persistentMemory: true,
            toolExecution: brain.cachedCapabilities(brain.providerName)?.tools === true,
            ipcV2: true,
            chatKernel: chatDeps !== null,
            openclawBridge: bridge.peek() as unknown as JSONValue,
            mcp: mcpRegistry.status(),
            memoryMode: MEMORY_MODE,
            memoryScope: MEMORY_MODE === 'vault' ? adapter!.scope : null,
            memoryAvailable: MEMORY_MODE === 'vault' ? adapter!.available : null,
            memoryOutboxPending: MEMORY_MODE === 'vault' ? adapter!.lastOutbox.failed.length : null,
          },
        }),
      });
    }

    const MAX_FRAME_BYTES = 1_000_000;
    const MAX_PENDING_REQUESTS = 64;
    const handle = async (line: string) => {
      let id = '';
      try {
        if (line.length > MAX_FRAME_BYTES) throw new Error('FRAME_TOO_LARGE');
        let req: { id?: unknown; action?: unknown; protocol?: unknown; data?: any };
        try {
          req = JSON.parse(line);
        } catch {
          throw new Error('PARSE_ERROR');
        }
        if (typeof req.id !== 'string' || !req.id.trim() || req.id.length > 80) throw new Error('INVALID_ID');
        id = req.id;
        if (req.protocol !== undefined && req.protocol !== 1 && req.protocol !== 2) {
          throw new Error('PROTOCOL_VERSION_UNSUPPORTED');
        }
        if (managedStopping) throw new Error('BUSY');
        await managedModels?.refresh();
        const data = req.data ?? {};
        let result: unknown;
        if (req.protocol === 2) {
          // M08：v2 全部走路由器白名单；长任务在后台 worker 推进，本请求立即返回。
          if (!router) throw new Error('IPC_V2_UNAVAILABLE');
          result = await router.dispatch(typeof req.action === 'string' ? req.action : '', data);
          if (managedModels && req.action === 'session.create') {
            const created = result as {session:{id:string}};
            await managedModels.bind(created.session.id);
          }
        } else if (req.action === 'ping') {          result = { protocol: 1, status: 'ready', provider: brain.providerName,
            configured: brain.configured, version: CONFIG.version, busy: chatBusySessions.size > 0,
            cloudCallsToday: gateway ? gateway.status().daily.calls : 0, dailyCloudCallLimit: dailyLimit ?? null,
            budget: gateway ? { mode: budgetMode(), ...gateway.status() } : null,
            capabilities: { history: true, persistentMemory: true,
              toolExecution: router !== null && brain.cachedCapabilities(brain.providerName)?.tools === true, ipcV2: router !== null,
              chatKernel: chatDeps !== null, openclawBridge: bridge.peek(),
              memoryMode: MEMORY_MODE, memoryScope: MEMORY_MODE === 'vault' ? adapter!.scope : null,
              memoryAvailable: MEMORY_MODE === 'vault' ? adapter!.available : null,
              memoryOutboxPending: MEMORY_MODE === 'vault' ? adapter!.lastOutbox.failed.length : null } };
        } else if (req.action === 'lifecycle.stop-ready' && managedModels && rtStore) {
          const active = rtStore.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE state IN ('queued','running','waiting_provider','cancelling')").get() as {n:number};
          if (active.n || chatBusySessions.size) throw new Error('BUSY');
          lifecycleScheduler?.stop();
          managedStopping = true;
          result = {ready:true};
        } else if (req.action === 'history') {
          // M09：历史来自统一账本（旧 tasks/*.json 已在启动时幂等并入，原文件保留）。
          result = taskService
            ? { tasks: listChatHistory(taskService, 30).map((h) => ({ id: h.id, message: h.message,
                text: h.text || undefined, provider: h.provider,
                model: h.model, usage: h.usage ?? undefined,
                status: h.state === 'succeeded' ? 'completed' : h.state,
                error: h.errorCode ?? undefined, startedAt: h.createdAt,
                memoryWarning: h.memoryOutboxPending || undefined })) }
            : { tasks: [], degraded: 'RUNTIME_STORE_UNAVAILABLE' };
        } else if (req.action === 'provider') {
          if (managedModels) throw new Error('ACTION_DENIED'); // defaults only through revisioned management API.
          if (chatBusySessions.size > 0) throw new Error('BUSY');
          const target = typeof data.name === 'string' ? data.name.trim() : '';
          if (!['kimi', 'astra', 'deepseek', 'mock', 'local'].includes(target)) throw new Error('PROVIDER_NOT_WHITELISTED');
          try { brain.setProvider(target as ProviderName); } catch { throw new Error('PROVIDER_UNAVAILABLE'); }
          CONFIG.defaultProvider = target as ProviderName;
          // M12(P02)：切换后刷新能力缓存，下一次 ping 的 toolExecution 如实反映新大脑。
          await brain.capabilitiesFor(target as ProviderName).catch(() => null);
          result = { provider: target, switched: true };
        } else if (req.action === 'chat') {
          // M09：与 CLI 同一 chat-kernel；幂等/预算/事件/记忆写回语义完全一致。
          // M23：绑定到具体会话（sessionId + scope）；scope 由服务端从会话记录查得（不采信客户端自报）。
          const reqSessionId = typeof data.sessionId === 'string' && data.sessionId.trim() ? data.sessionId.trim() : null;
          let session = null;
          if (reqSessionId) {
            session = sessionService ? sessionService.getSession(reqSessionId) : null;
            if (!session) throw new Error('SESSION_NOT_FOUND');
          } else if (sessionService) {
            session = sessionService.getSession(memorySessionId('ipc')) ?? sessionService.listSessions({ limit: 1 })[0] ?? null;
          }
          const chatSessionId = session ? session.id : memorySessionId('ipc');
          const chatScope = session ? session.scope : memoryScope();
          if (chatBusySessions.has(chatSessionId)) throw new Error('BUSY');
          const message = typeof data.message === 'string' ? data.message : '';
          if (!message.trim() || message.length > 16000) throw new Error('INVALID_MESSAGE');
          if (brain.providerName === 'mock' && !(process.env.NODE_ENV === 'test' && process.env.SKF_ALLOW_MOCK === '1')) {
            throw new Error('PROVIDER_NOT_CONFIGURED');
          }
          if (!chatDeps) throw new Error('BUDGET_UNAVAILABLE');
          chatBusySessions.add(chatSessionId);
          try {
            const chatTurn = await runChatTurn(chatDeps, {
              id, message, sessionId: chatSessionId, scope: chatScope,
              channel: 'ipc', purpose: 'chat', turn: Date.now(),
              ...(managedModels ? {route: {provider: await managedModels.bind(chatSessionId)}} : {}),
            });
            if (session) sessionService?.touch(chatSessionId);
            if (chatTurn.state === 'waiting_approval') {
              result = {
                state: 'waiting_approval', taskId: chatTurn.taskId,
                sessionId: chatSessionId, scope: chatScope,
                toolCalls: chatTurn.toolCalls, pendingApproval: chatTurn.pendingApproval,
                execution: 'enabled', memoryWarning: false,
              };
            } else {
              result = { state: 'succeeded', text: chatTurn.text, provider: chatTurn.provider, model: chatTurn.model,
                sessionId: chatSessionId, scope: chatScope,
                usage: {
                  inputTokens: chatTurn.usage.inputTokens,
                  outputTokens: chatTurn.usage.outputTokens,
                  cachedInputTokens: chatTurn.usage.cachedInputTokens,
                  ...(chatTurn.cost.amountKnown && chatTurn.cost.settledMicros !== null
                    ? { cost: chatTurn.cost.settledMicros / 1_000_000, costSource: 'configured-estimate' }
                    : {}),
                },
                toolCalls: chatTurn.toolCalls,
                memoryWarning: chatTurn.memoryOutboxPending || lastGatherDegraded,
                proposedToolCount: chatTurn.toolCalls.length, toolCallsIgnored: chatTurn.toolCallsIgnored, execution: 'enabled' };
            }
          } finally {
            chatBusySessions.delete(chatSessionId);
          }
        } else throw new Error('ACTION_DENIED');
        output.write(JSON.stringify({ id, ok: true, data: result, error: null }) + '\n');
      } catch (err) {
        const code =
          err instanceof Error && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
            ? toPublicErrorCode(err)
            : err instanceof Error && publicErrors.has(err.message)
              ? err.message
              : 'REQUEST_FAILED';
        process.stderr.write('[supervisor] request failed: ' + code + '\n');
        output.write(JSON.stringify({ id, ok: false, data: null, error: code }) + '\n');
      }
    };
    const rl = createInterface({ input, crlfDelay: Infinity });
    const pending = new Set<Promise<void>>();
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (pending.size >= MAX_PENDING_REQUESTS) {
        // 背压：超出并行待处理上限的请求立即拒绝，不排队拖垮内存。
        let rejectId = '';
        try { rejectId = String(JSON.parse(line).id ?? ''); } catch { /* id 不可知，原样拒绝 */ }
        output.write(JSON.stringify({ id: rejectId, ok: false, data: null, error: 'BUSY' }) + '\n');
        continue;
      }
      const work = handle(line);
      pending.add(work);
      void work.finally(() => pending.delete(work));
    }
    await Promise.all(pending);
    broadcaster?.stop();
    lifecycleScheduler?.stop();
    if (memory) await memory.flush();
    if (managedModels) process.exit(0); // Parent EOF: never leave an orphan core or release its data lock early.
    return;
  }

  // --once 模式：跑一次就退出（测试用）。M09：同样走 chat-kernel（同一账本）。
  if (process.argv.includes('--once')) {
    const isTest = process.argv.includes('--test');  // --test 隔离测试数据，不写记忆
    const msgIdx = process.argv.indexOf('--once');
    const message = process.argv[msgIdx + 1] || '你好';
    const spinner = ora({ text: '思考中…', color: 'cyan' }).start();
    try {
      if (!chatDeps) throw new Error('BUDGET_UNAVAILABLE');
      // --test：outbox 正常登记但投递为 no-op（标 done），真实主档零接触。
      const onceDeps = isTest ? { ...chatDeps, flushMemoryOutbox: async () => {} } : chatDeps;
      const chatTurn = await runChatTurn(onceDeps, {
        id: `chat-once:${randomUUID()}`,
        message,
        sessionId: memorySessionId('cli'),
        scope: memoryScope(),
        channel: 'once',
        purpose: 'chat',
        turn: 1,
      });
      spinner.stop();
      if (chatTurn.state === 'waiting_approval') {
        console.log(chalk.yellow('  ⚠️ 需要审批（CLI 无审批界面）'));
        process.exit(2);
      }
      console.log(chalk.white('\nSKF › ') + chatTurn.text);
      console.log(chalk.gray(`\n  [provider=${chatTurn.provider} model=${chatTurn.model}]`));

      if (isTest) {
        // 测试模式：不写入记忆，避免污染真实主档
        console.log(chalk.yellow('  🧪 测试模式：不写入记忆库'));
      } else if (chatTurn.memoryOutboxPending) {
        console.log(chalk.yellow('  ⚠️ 主档写回排队（下次自动补写）'));
      } else if (MEMORY_MODE === 'legacy') {
        // 抽 L3 事实（legacy 模式；L2 已由写回通道落盘）
        if (extractor && process.env.SKF_FACT_EXTRACTION === '1') {
          const l3spinner = ora({ text: 'L3 抽事实中（3 轮验证）…', color: 'magenta' }).start();
          const facts = await legacyMemory.extractFacts(message, chatTurn.text, 'turn-000001');
          l3spinner.stop();
          if (facts.length > 0) {
            console.log(chalk.gray(`\n  🧠 L3 抽到 ${facts.length} 条事实（${facts.filter((f) => f.verified).length} 条已验证）：`));
            for (const f of facts) {
              const tag = f.verified ? chalk.green('✓') : chalk.yellow('?');
              const conf = (f.confidence * 100).toFixed(0);
              console.log(`     ${tag} [${chalk.cyan(f.category)}] ${f.text} ${chalk.gray(`(${conf}%)`)}`);
            }
          } else {
            console.log(chalk.gray('\n  🧠 L3 没抽到事实'));
          }
        }
      }
    } catch (err: any) {
      spinner.stop();
      console.error(chalk.red('  ✗ 出错：' + (err?.code || err?.message || String(err))));
      process.exit(1);
    }
    return;
  }

  // ─────────────────────────────────────
  // vault 模式命令映射（旧 /memory /facts /recall /context /forget /decay /graph）
  // search/get/correct/archive/restore；graph 未实现 ⇒ 明确 unavailable。
  // ─────────────────────────────────────
  const handleVaultCommand = async (trimmed: string): Promise<boolean> => {
    if (trimmed === '/memory') {
      try {
        const stats = await adapter!.status();
        console.log();
        console.log(chalk.bold('  📚 统一主档状态（唯一真源）:'));
        console.log(`  ${chalk.cyan('根目录')} · ${adapter!.root}`);
        console.log(`  ${chalk.cyan('scope')} · ${adapter!.scope} · session ${adapter!.sessionId}`);
        for (const r of stats.records) console.log(`  ${chalk.gray('记录')} · ${r.status}/${r.kind} × ${r.count}`);
        for (const t of stats.tasks) console.log(`  ${chalk.gray('任务')} · ${t.state} × ${t.count}`);
        const pending = adapter!.lastOutbox.failed.length;
        console.log(`  ${chalk.cyan('待补写回')} · ${pending ? chalk.yellow(String(pending) + ' 条（下次自动重放）') : '无'}`);
        console.log();
      } catch (err) {
        console.log(chalk.red('  ✗ 主档不可用: ' + (err instanceof MemoryError ? err.code : String(err))));
      }
      return true;
    }
    if (trimmed === '/facts') {
      console.log(chalk.gray('  新主档按来源检索，用 /recall <关键词>；统计见 /memory。'));
      return true;
    }
    if (trimmed.startsWith('/recall ')) {
      const keyword = trimmed.slice(8).trim();
      try {
        const result = await adapter!.search(keyword, { limit: 10 });
        console.log();
        console.log(chalk.bold(`  🧠 「${keyword}」相关记录（${result.hits.length} 条，带来源）:`));
        for (const h of result.hits) {
          console.log(`     ${chalk.cyan(h.id.slice(0, 8))} [${h.kind}/${h.trust}] ${h.text.slice(0, 120)}`);
        }
        if (result.semanticStatus !== 'ready' && result.semanticStatus !== 'disabled') {
          console.log(chalk.gray(`     （语义检索 ${result.semanticStatus}，已用关键词）`));
        }
        console.log();
      } catch (err) {
        console.log(chalk.red('  ✗ 检索失败: ' + (err instanceof MemoryError ? err.code : String(err))));
      }
      return true;
    }
    if (trimmed.startsWith('/forget')) {
      const arg = trimmed.slice(7).trim();
      if (!arg) { console.log(chalk.gray('  用法: /forget <关键词或记录ID>（归档，可 /restore 恢复）')); return true; }
      try {
        let record = await adapter!.get(arg).catch(() => null);
        if (!record) {
          const result = await adapter!.search(arg, { limit: 10 });
          if (!result.hits.length) { console.log(chalk.yellow('  没找到匹配记录')); return true; }
          console.log();
          for (let i = 0; i < result.hits.length; i++) {
            const h = result.hits[i];
            console.log(`     ${chalk.cyan(String(i + 1).padStart(2))}. [${h.kind}/${h.trust}] ${h.text.slice(0, 100)}`);
          }
          const idx = await rl.question(chalk.cyan('\n  归档编号（0 取消）› '));
          const n = parseInt(idx.trim(), 10);
          if (!(n >= 1 && n <= result.hits.length)) { console.log(chalk.gray('  取消')); return true; }
          record = await adapter!.get(result.hits[n - 1].id);
        }
        await adapter!.archive([record.id], { dryRun: true });
        const confirm = await rl.question(chalk.cyan(`  确认归档「${record.text.slice(0, 60)}」？(y/N) › `));
        if (confirm.trim().toLowerCase() !== 'y') { console.log(chalk.gray('  取消')); return true; }
        await adapter!.archive([record.id], { dryRun: false, reason: 'user /forget', operationId: `${adapter!.sessionId}:archive:${record.id}` });
        console.log(chalk.green('  ✓ 已归档（/restore ' + record.id + ' 可恢复）'));
      } catch (err) {
        console.log(chalk.red('  ✗ 归档失败: ' + (err instanceof MemoryError ? err.code : String(err))));
      }
      return true;
    }
    if (trimmed.startsWith('/restore ')) {
      const id = trimmed.slice(9).trim();
      try {
        await adapter!.restore(id);
        console.log(chalk.green('  ✓ 已恢复: ' + id));
      } catch (err) {
        console.log(chalk.red('  ✗ 恢复失败: ' + (err instanceof MemoryError ? err.code : String(err))));
      }
      return true;
    }
    if (trimmed.startsWith('/correct ')) {
      const id = trimmed.slice(9).trim();
      if (!id) { console.log(chalk.gray('  用法: /correct <记录ID>（旧值保留为已更正，不删除历史）')); return true; }
      try {
        const existing = await adapter!.get(id);
        if (!existing) { console.log(chalk.yellow('  记录不存在: ' + id)); return true; }
        console.log(chalk.gray('  当前: ' + existing.text));
        const text = await rl.question(chalk.cyan('  更正为 › '));
        if (!text.trim()) { console.log(chalk.gray('  取消')); return true; }
        const reason = await rl.question(chalk.cyan('  更正原因 › '));
        const result = await adapter!.correct({ id, text: text.trim(), reason: reason.trim() || 'user correction', userLocator: 'session:' + adapter!.sessionId });
        console.log(chalk.green('  ✓ 已更正，新记录: ' + result.id));
      } catch (err) {
        console.log(chalk.red('  ✗ 更正失败: ' + (err instanceof MemoryError ? err.code : String(err))));
      }
      return true;
    }
    if (trimmed === '/decay') {
      try {
        const proposals = await adapter!.maintain();
        console.log();
        console.log(chalk.bold('  ⏳ 老化建议（仅提案，不自动归档）:'));
        const list = proposals?.proposals ?? proposals ?? [];
        if (Array.isArray(list) && list.length) {
          for (const p of list.slice(0, 10)) console.log(`     • ${JSON.stringify(p).slice(0, 120)}`);
        } else {
          console.log(chalk.gray('  当前没有建议'));
        }
        console.log();
      } catch (err) {
        console.log(chalk.red('  ✗ 失败: ' + (err instanceof MemoryError ? err.code : String(err))));
      }
      return true;
    }
    if (trimmed === '/graph' || trimmed.startsWith('/graph ')) {
      console.log(chalk.yellow('  ⚠️ graph 在新主档未实现（unavailable）；旧 L4 图谱只在 legacy 模式只读保留。'));
      return true;
    }
    if (trimmed === '/context') {
      console.log();
      console.log(formatContextReport(adapter!.lastPrepare, lastAssembled));
      console.log();
      return true;
    }
    return false;
  };

  // 交互模式
  const rl = createInterface({ input, output });
  console.log(chalk.green('  ✦ 我在。'));

  let turn = 0;
  while (true) {
    const userInput = await rl.question(chalk.cyan('\n你 › '));
    const trimmed = userInput.trim();
    if (!trimmed) continue;

    // vault 模式：新命令优先接管；未命中再走公共/legacy 逻辑
    if (MEMORY_MODE === 'vault' && (await handleVaultCommand(trimmed))) continue;

    // 内置命令
    if (trimmed === '/exit' || trimmed === '/quit') {
      console.log(chalk.yellow('  ✦ 拜。'));
      break;
    }
    if (trimmed === '/help') {
      printHelp();
      continue;
    }
    if (trimmed === '/memory') {
      await legacyMemory.status();
      continue;
    }
    if (trimmed === '/facts') {
      const facts = await legacyMemory.queryFacts({ verifiedOnly: false, limit: 30 });
      console.log();
      console.log(chalk.bold(`  🧠 L3 事实（共 ${facts.length} 条）：`));
      for (const f of facts) {
        const tag = f.verified ? chalk.green('✓') : chalk.yellow('?');
        const conf = (f.confidence * 100).toFixed(0);
        console.log(`     ${tag} [${chalk.cyan(f.category)}] ${f.text} ${chalk.gray(`(${conf}%)`)}`);
      }
      console.log();
      continue;
    }
    if (trimmed.startsWith('/recall ')) {
      const keyword = trimmed.slice(8).trim();
      const facts = await legacyMemory.queryFacts({ keyword, verifiedOnly: false, limit: 10 });
      console.log();
      console.log(chalk.bold(`  🧠 关键词「${keyword}」相关事实（${facts.length} 条）：`));
      for (const f of facts) {
        const tag = f.verified ? chalk.green('✓') : chalk.yellow('?');
        console.log(`     ${tag} [${chalk.cyan(f.category)}] ${f.text}`);
      }
      console.log();
      continue;
    }
    if (trimmed === '/forget') {
      const facts = await legacyMemory.queryFacts({ verifiedOnly: false, limit: 100 });
      console.log();
      console.log(chalk.bold(`  🧠 准备删除（输入编号，0 取消）：`));
      for (let i = 0; i < facts.length; i++) {
        const f = facts[i];
        const tag = f.verified ? chalk.green('✓') : chalk.yellow('?');
        console.log(`     ${chalk.cyan(String(i + 1).padStart(2))}. ${tag} [${f.category}] ${f.text}`);
      }
      const idx = await rl.question(chalk.cyan('\n  编号 › '));
      const n = parseInt(idx.trim(), 10);
      if (n >= 1 && n <= facts.length) {
        await legacyMemory.deleteFact(facts[n - 1].id);
        console.log(chalk.green(`  ✓ 已删除：${facts[n - 1].text}`));
      } else {
        console.log(chalk.gray('  取消'));
      }
      continue;
    }
    if (trimmed.startsWith('/provider ')) {
      const newProvider = trimmed.slice(10).trim() as ProviderName;
  // 白名单：只允许这三个大脑（kimi / deepseek / astra）+ mock 兜底
      if (!['kimi', 'astra', 'deepseek', 'mock', 'local'].includes(newProvider)) {
        console.log(chalk.red(`  ✗ 不允许的大脑：${newProvider}（白名单：kimi / astra / deepseek / mock / local）`));
        continue;
      }
      try {
        brain.setProvider(newProvider);
        console.log(chalk.green('  ✦ 大脑切换到：' + newProvider));
      } catch (e: any) {
        console.log(chalk.red('  ✗ 切换失败：' + (e?.message || String(e))));
      }
      continue;
    }
    if (trimmed === '/models') {
      const notes: Record<string, string> = {
        kimi: '主模型 · 国内直连 · 2026-09-08 实测连通',
        deepseek: '副模型 · 国内直连 · 2026-09-08 实测连通',
        astra: 'GPT-6 · 仅开代理时用 · 2026-09-08 经代理 ready',
        openrouter: '备用 · 本轮未实测',
        mock: '测试假大脑 · 不花钱',
      };
      console.log();
      console.log(chalk.bold('  🧠 SKF 大脑清单（实际配置与实测状态，非宣传）：'));
      for (const name of ['kimi', 'deepseek', 'astra', 'openrouter', 'mock'] as ProviderName[]) {
        const registered = brain.listProviders().includes(name);
        if (!registered) {
          console.log(`  ${chalk.gray(name.padEnd(10))} · 未注册（缺 key）· ${notes[name]}`);
          continue;
        }
        const caps = await brain.capabilitiesFor(name);
        const price = tariffConfigured(name) ? `价格已配置(v${TARIFF_VERSION})` : '金额未知';
        const tools = caps?.tools ? '工具✓' : '工具✗(仅聊天)';
        const current = brain.providerName === name ? chalk.green(' ◀ 当前') : '';
        console.log(`  ${chalk.cyan(name.padEnd(10))} · ${tools} · ${price} · ${notes[name]}${current}`);
      }
      console.log();
      console.log(chalk.gray('  切换：/provider kimi | /provider deepseek | /provider astra | /provider mock'));
      console.log();
      continue;
    }
    if (trimmed === '/bridge') {
      const status = await bridge.status();
      console.log();
      console.log(chalk.bold('  🌉 OpenClaw 桥接（可选增强，启动不依赖）：'));
      console.log(`  ${chalk.cyan('状态')} · ${status.state}${status.version ? ` · ${status.version}` : ''}${status.reason ? ` · ${status.reason}` : ''}`);
      for (const name of bridge.knownTools()) {
        console.log(`  ${chalk.cyan('工具')} · ${name}（只读 read；任务需 input.bridgeTools 逐个点名授权）`);
      }
      console.log(chalk.gray('  关闭：SKF_OPENCLAW_BRIDGE=0；unavailable 时本地任务不受影响，显式桥接任务如实报 TOOL_UNAVAILABLE。'));
      console.log();
      continue;
    }
    if (trimmed === '/astra' || trimmed.startsWith('/astra ')) {
      const question = trimmed === '/astra' ? '你好，自我介绍一下' : trimmed.slice(7).trim();
      console.log(chalk.gray('  调 GPT-6 Astra...'));
      try {
        if (!chatDeps) throw new Error('BUDGET_UNAVAILABLE');
        // M09：/astra 也走同一内核；purpose=review，用户显式输入即昂贵授权（M06 语义）。
        const resp = await runChatTurn(chatDeps, {
          id: `astra-cli:${turn}:${randomUUID().slice(0, 8)}`,
          message: question,
          sessionId: memorySessionId('cli'),
          scope: memoryScope(),
          channel: 'cli',
          purpose: 'review',
          route: { provider: 'astra', allowExpensive: true },
          consult: 'astra',
          systemOverride: '你是用户的 AI co-architect 顾问。SKF 项目上下文：统一记忆主档 + 可选 OpenClaw 桥接 + D 盘数据。\n\n问题：' + question,
          turn,
        });
        console.log();
        console.log(chalk.cyan.bold('  Astra › ') + resp.text);
        const cost = resp.cost.amountKnown && resp.cost.settledMicros !== null ? (resp.cost.settledMicros / 1_000_000).toFixed(4) : '未知';
        console.log(chalk.gray('  [Astra ' + resp.model + ' ' + (resp.usage.inputTokens ?? '?') + '+' + (resp.usage.outputTokens ?? '?') + ' tok $' + cost + '（估算非账单）]'));
        if (resp.memoryOutboxPending) console.log(chalk.yellow('  ⚠️ 主档写回排队（下次自动补写）'));
      } catch (err: any) {
        const msg = err?.code || err?.message || String(err);
        console.log(chalk.red(msg === 'PROVIDER_UNAVAILABLE' ? '  Astra provider 未注册（检查 OPENAI_API_KEY）' : '  Astra 调用失败: ' + msg));
      }
      console.log();
      continue;
    }
    if (trimmed === '/graph') {
      const gs = await legacyMemory.getGraphStatus();
      console.log();
      console.log(chalk.bold('  🕸️  L4 时序图谱：'));
      console.log(`  ${chalk.cyan('实体')} · ${gs.entities} 个`);
      console.log(`  ${chalk.cyan('关系')} · ${gs.relations} 条`);
      if (gs.topEntities.length > 0) {
        console.log(`  ${chalk.gray('  Top 10：')}`);
        for (const e of gs.topEntities) {
          console.log(`     • ${e.displayName} [${e.type}] (访问 ${e.accessCount})`);
        }
      }
      console.log();
      continue;
    }
    if (trimmed.startsWith('/graph ')) {
      const entity = trimmed.slice(7).trim();
      const result = await legacyMemory.queryGraph(entity, 2);
      if (!result) {
        console.log(chalk.yellow(`  ⚠️  图谱里没找到「${entity}」`));
      } else {
        console.log();
        console.log(chalk.bold(`  🕸️  以「${result.root.displayName}」为中心的关系网：`));
        for (const node of result.nodes.slice(1)) {
          const relDesc = node.viaRelation ? `${node.viaRelation.type} (w=${node.viaRelation.weight.toFixed(2)})` : 'self';
          console.log(`     ${chalk.cyan('→')} ${node.entity.displayName} [${node.entity.type}] depth=${node.depth} via ${relDesc}`);
        }
        console.log(chalk.gray(`\n  总计：${result.totalEntities} 实体 / ${result.totalRelations} 关系\n`));
      }
      continue;
    }
    if (trimmed === '/decay') {
      console.log(chalk.gray('  ⏳ 跑 L5 衰减归档...'));
      const report = await legacyMemory.runDecayPass();
      console.log();
      console.log(chalk.bold('  ⏳ L5 衰减报告：'));
      console.log(`  ${chalk.cyan('扫描')} · ${report.scanned} 条事实`);
      console.log(`  ${chalk.green('保留')} · ${report.fresh} 条`);
      console.log(`  ${chalk.yellow('归档')} · ${report.archived} 条`);
      console.log(`  ${chalk.red('过期')} · ${report.expired} 条`);
      if (report.topArchived.length > 0) {
        console.log(`  ${chalk.gray('  已归档 Top 5：')}`);
        for (const f of report.topArchived) {
          console.log(`     • ${f.text} ${chalk.gray(`(score=${f.score.toFixed(3)})`)}`);
        }
      }
      console.log(chalk.gray(`\n  耗时：${report.durationMs}ms\n`));
      continue;
    }
    if (trimmed === '/context') {
      const result = await legacyMemory.contextManager.buildContext('诊断当前上下文');
      console.log();
      console.log(legacyMemory.contextManager.formatReport(result));
      console.log();
      continue;
    }

    turn++;
    const spinner = ora({ text: '思考中…', color: 'cyan' }).start();

    try {
      if (!chatDeps) {
        spinner.stop();
        console.error(chalk.red('  ✗ 聊天内核不可用（BUDGET_UNAVAILABLE）：检查 runtime.sqlite 与预算网关初始化日志'));
        continue;
      }
      // M09：普通聊天走同一 chat-kernel；记忆写回经终态 outbox（不再散写）。
      const chatTurn = await runChatTurn(chatDeps, {
        id: `chat-cli:${turn}:${randomUUID().slice(0, 8)}`,
        message: trimmed,
        sessionId: memorySessionId('cli'),
        scope: memoryScope(),
        channel: 'cli',
        purpose: 'chat',
        turn,
      });

      spinner.stop();
      if (chatTurn.state === 'waiting_approval') {
        const pa = chatTurn.pendingApproval;
        console.log(chalk.yellow(`  ⚠️ 需要审批：${pa?.tool ?? '工具'}（${pa?.effect ?? ''}）— 请在桌面 UI 内批准后继续`));
        console.log(chalk.gray('  CLI 通道无审批界面；有外部副作用的操作请走桌面 UI。'));
        continue;
      }
      console.log(chalk.white('\nSKF › ') + chatTurn.text);

      // B：聊天已能执行工具；展示每个工具调用（名称+effect+状态+摘要）。
      for (const tc of chatTurn.toolCalls) {
        const mark = tc.status === 'ok' ? '✓' : '✗';
        console.log(chalk.gray(`  🔧 ${tc.tool} [${tc.effect}] ${mark} ${tc.summary}`));
      }
      if (chatTurn.memoryOutboxPending) {
        console.log(chalk.yellow('  ⚠️ 主档写回排队（下次自动补写）'));
      }
      if (lastGatherDegraded) {
        console.log(chalk.yellow('  ⚠️ 本轮记忆降级（主档暂不可用，回复未带记忆上下文）'));
      }

      if (MEMORY_MODE === 'vault') {
        pushRecent('user', trimmed);
        pushRecent('assistant', chatTurn.text);
      }

      // 抽 L3（仅 legacy 模式，异步显示，不阻塞）
      if (MEMORY_MODE === 'legacy' && extractor && process.env.SKF_FACT_EXTRACTION === '1') {
        legacyMemory.extractFacts(trimmed, chatTurn.text, `turn-${String(turn).padStart(6, '0')}`).then(async (facts) => {
          if (facts.length > 0) {
            const verifiedCount = facts.filter((f) => f.verified).length;
            console.log(chalk.magenta(`\n  🧠 L3 抽到 ${facts.length} 条事实（${verifiedCount} 条已验证）`));
            for (const f of facts.slice(0, 5)) {
              const tag = f.verified ? chalk.green('✓') : chalk.yellow('?');
              console.log(`     ${tag} [${chalk.cyan(f.category)}] ${f.text}`);
            }
          }
        }).catch((e) => {
          console.error(chalk.red('  ✗ L3 抽取失败：' + (e?.message || String(e))));
        });
      }
    } catch (err: any) {
      spinner.stop();
      console.error(chalk.red('  ✗ 出错：' + (err?.code || err?.message || String(err))));
      if (CONFIG.debug) console.error(err);
    }
  }

  rl.close();
  if (MEMORY_MODE === 'vault') {
    try {
      await adapter!.close({
        operationId: `${adapter!.sessionId}:close:${Date.now()}`,
        summary: `SKF CLI 交互会话结束: 共 ${turn} 轮对话`,
      });
    } catch (err) {
      console.error(chalk.yellow('  ⚠️ 会话写回排队（下次自动补写）: ' + (err instanceof MemoryError ? err.code : String(err))));
    }
  } else {
    await legacyMemory.flush();
  }
}

function printHelp() {
  console.log();
  console.log(chalk.bold('  内置指令：'));
  console.log('  ' + chalk.cyan('/help') + '        — 看这个帮助');
  if (MEMORY_MODE === 'vault') {
    console.log('  ' + chalk.cyan('/memory') + '      — 统一主档状态（唯一真源）');
    console.log('  ' + chalk.cyan('/recall <词>') + ' — 检索带来源的记忆');
    console.log('  ' + chalk.cyan('/correct <id>') + '— 更正一条记录（旧值保留历史）');
    console.log('  ' + chalk.cyan('/forget <词|id>') + '— 归档记录（可恢复）');
    console.log('  ' + chalk.cyan('/restore <id>') + '— 恢复已归档记录');
    console.log('  ' + chalk.cyan('/decay') + '       — 看老化建议（仅提案）');
    console.log('  ' + chalk.cyan('/graph') + '       — 未实现（unavailable）');
    console.log('  ' + chalk.cyan('/context') + '     — 上次上下文装配报告（字节口径）');
  } else {
    console.log('  ' + chalk.cyan('/memory') + '      — 看 统一记忆状态（含 L4/L5）');
    console.log('  ' + chalk.cyan('/facts') + '       — 看 L3 事实层');
    console.log('  ' + chalk.cyan('/recall <词>') + ' — 关键词检索事实');
    console.log('  ' + chalk.cyan('/forget') + '      — 手动删除错误事实');
    console.log('  ' + chalk.cyan('/graph') + '       — 看 L4 时序图谱');
    console.log('  ' + chalk.cyan('/graph <实体>') + ' — 查实体关系网');
    console.log('  ' + chalk.cyan('/decay') + '       — 跑 L5 衰减归档');
    console.log('  ' + chalk.cyan('/context') + '     — 看上下文组装报告（token 用量）');
  }
  console.log('  ' + chalk.cyan('/provider X') + '  — 切换大脑（kimi / deepseek / astra / mock）');
  console.log('  ' + chalk.cyan('/models') + '      — 看三个大脑的成本和用法');
  console.log('  ' + chalk.cyan('/astra [Q]') + '  — 问 GPT-6 Astra（co-architect 顾问）');
  console.log('  ' + chalk.cyan('/bridge') + '      — OpenClaw 桥接状态（可选增强，启动不依赖）');
  console.log('  ' + chalk.cyan('/exit') + '        — 退出');
  console.log();
  console.log(chalk.gray('  说明：聊天通道不执行工具；文件交付走桌面任务（task.start），与 GUI 同一事件与预算账本。'));
  console.log();
}

// ─────────────────────────────────────

// M10：异步崩溃必须先留痕再退出（此前 unhandledRejection/uncaughtException 直接杀死
// 进程且 stderr 可能未落盘，桌面端只能看到「supervisor 消失」）。退出码语义不变。
process.on('unhandledRejection', (err) => {
  console.error('[fatal] unhandledRejection: ' + (err instanceof Error && err.stack ? err.stack : String(err)));
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException: ' + (err instanceof Error && err.stack ? err.stack : String(err)));
  process.exit(1);
});

// M10：supervisor 生命周期跟随 stdin 管道：应用持有管道时 stdin 引用计数保活事件循环，
// 管道关闭（应用退出）时进程自然退出。不要加常驻心跳——runtime 基线测试与 Rust Drop 都依赖「stdin 关 → 进程退」。

main().catch((err) => {
  console.error(chalk.red('  ✗ 启动失败：' + (err?.message || String(err))));
  if (CONFIG.debug) console.error(err);
  process.exit(1);
});
