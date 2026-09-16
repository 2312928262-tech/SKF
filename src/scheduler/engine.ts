import { RuntimeError } from '../runtime/contracts.js';
import type { ScheduleService } from './schedule-service.js';
import { ScheduleDispatcher, type DispatcherDeps } from './dispatcher.js';

/**
 * M15 · 调度引擎主循环。
 *
 * 与"先改 nextRun 再内存建任务"的旧范式相反：本引擎每次 tick 都从 firings 表读 due 行，
 * 每个 firing 已持久化为 pending；派发时 mark dispatched 才算认领；同一 firing 重启不重
 * 不漏（唯一键 = cron:<sid>:<gen>:<scheduledAtUtc>）。
 *
 * 进程内只允许一个 engine 实例（acquireLease('scheduler:engine')），多实例下抢不到 lease
 * 的实例退化为只读（仍然能查 schedule/firing），绝不双触发。
 */

export interface EngineDeps extends DispatcherDeps {
  scheduleService: ScheduleService;
  /** 引擎持有的 lease 名；多实例只允许一个 owner。 */
  leaseName?: string;
  /** 引擎 lease TTL（毫秒）；默认 60s。 */
  leaseTtlMs?: number;
  /** 轮询间隔（毫秒）；默认 1000ms。生产可调大，测试可调小。 */
  pollIntervalMs?: number;
  /** instanceId 用于 fencing token；默认 scheduler-engine。 */
  instanceId?: string;
  logger?: (line: string) => void;
}

export interface EngineHandle {
  stop(): void;
  /** 立即触发一轮（测试与 IPC 加速用）。 */
  tick(): { processed: number; dispatched: number; failed: number };
  /** 是否已获 lease；false = 退化为只读模式。 */
  isLeader(): boolean;
}

export function startSchedulerEngine(deps: EngineDeps): EngineHandle {
  const leaseName = deps.leaseName ?? 'scheduler:engine';
  const leaseTtlMs = deps.leaseTtlMs ?? 60_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 1000;
  const dispatcher = new ScheduleDispatcher(deps);
  const logger = deps.logger ?? ((line) => process.stderr.write(line + '\n'));
  let fencingToken: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const tryAcquireLease = (): number | null => {
    try {
      const result = deps.taskService.acquireLease(leaseName, leaseTtlMs);
      return result.fencingToken;
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'LEASE_HELD') return null;
      throw error;
    }
  };

  const renewLease = (token: number): boolean => {
    try {
      deps.taskService.checkFence(leaseName, token);
      deps.taskService.acquireLease(leaseName, leaseTtlMs);
      return true;
    } catch {
      return false;
    }
  };

  const tick = (): { processed: number; dispatched: number; failed: number } => {
    if (fencingToken === null) {
      fencingToken = tryAcquireLease();
      if (fencingToken === null) {
        // 其他实例持有 lease：本实例退化为只读，不跑 dispatcher。
        return { processed: 0, dispatched: 0, failed: 0 };
      }
    } else if (!renewLease(fencingToken)) {
      logger(`[scheduler] lost lease ${leaseName}; becoming read-only`);
      fencingToken = null;
      return { processed: 0, dispatched: 0, failed: 0 };
    }
    // 错过补偿：标记所有 due 且 pending 的 firings。
    try {
      const recovered = deps.scheduleService.recoverMissedFirings(deps.now?.() ?? new Date());
      if (recovered.scanned > 0) {
        logger(`[scheduler] recover missed firings: scanned=${recovered.scanned} skipped=${recovered.skipped} latestKept=${recovered.latestKept} boundedKept=${recovered.boundedKept}`);
      }
    } catch (error) {
      logger(`[scheduler] recover missed firings error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return dispatcher.runOnce(50);
  };

  // 立即跑一轮（启动期抢占错过的），然后启动定时器。
  const initial = tick();
  if (initial.dispatched > 0 || initial.failed > 0) {
    logger(`[scheduler] initial tick: ${JSON.stringify(initial)}`);
  }
  timer = setInterval(() => {
    if (stopped) return;
    try {
      tick();
    } catch (error) {
      logger(`[scheduler] tick error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, pollIntervalMs);
  timer.unref?.();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (fencingToken !== null) {
        try {
          deps.taskService.releaseLease(leaseName, fencingToken);
        } catch {
          // 释放失败不影响停止语义；下次启动会重新抢 lease。
        }
      }
    },
    tick,
    isLeader(): boolean {
      return fencingToken !== null;
    },
  };
}
