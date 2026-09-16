import { randomUUID } from 'node:crypto';
import { RuntimeError, inputHashOf, type JSONValue } from '../runtime/contracts.js';
import type { TaskService } from '../runtime/task-service.js';
import type { ScheduleRecord, FiringRecord, ScheduleService } from './schedule-service.js';

/**
 * M15 · 调度触发派发（dispatcher）。
 *
 * 把 schedule_firings 行转成 task.start：复用 M03 同事务语义——
 * createTask 同 ID 同输入幂等；不同输入 REQUEST_ID_CONFLICT。
 * 任务 kind='scheduled_firing' 让 task.list 按 kind 过滤；input.cronMeta 写入 cron 字段
 * 供模型与回溯（保留计划时刻、generation、scheduleId）。E/P 副作用仍走 M14 tool approval；
 * schedule.scheduledEffect 仅决定默认的 input.policy.effect，不绕过 M14 审批门。
 *
 * 不变量：firing 标 dispatched 与 task.create 必须在同一事务内；崩溃中断后 firings 仍是
 * pending，重启按 missed 策略补发——唯一键 cron:<sid>:<gen>:<scheduledAtUtc> 保证不重不漏。
 */

export interface DispatchOutcome {
  firingId: string;
  taskId: string;
  created: boolean;
}

export interface DispatcherDeps {
  scheduleService: ScheduleService;
  taskService: TaskService;
  /** 拿到每个 schedule 的本地时钟（默认 Date.now）。测试可注入 deterministic clock。 */
  now?: () => Date;
  logger?: (line: string) => void;
}

export class ScheduleDispatcher {
  private readonly now: () => Date;

  constructor(private deps: DispatcherDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 处理单个 firing：与 createTask 同事务（scheduleService.markFiringDispatched 自身就是
   * 单事务）。firing 已 dispatched 不会再次进入派发（firing.state != pending 抛错）。
   */
  dispatch(firing: FiringRecord, schedule: ScheduleRecord): DispatchOutcome {
    // 调度层授权检查：disabled schedule 不允许派发——即使上游错误地传入了 firing，也在这里挡掉。
    if (!schedule.enabled) {
      this.deps.scheduleService.markFiringSkipped(firing.id, 'schedule_disabled');
      this.deps.logger?.(`[scheduler] dispatch refused: schedule ${schedule.id} disabled`);
      return { firingId: firing.id, taskId: '', created: false };
    }
    const taskService = this.deps.taskService;
    const input: JSONValue = this.composeTaskInput(schedule, firing);
    const taskId = `task-cron-${firing.scheduleId}-${firing.generation}-${firing.scheduledAtUtc.replace(/[^0-9]/g, '')}`;
    const created = taskService.createTask({
      id: taskId,
      input,
      sessionId: schedule.sessionId,
      scope: schedule.scope,
      workspaceRoot: schedule.workspaceRoot,
      provider: schedule.provider,
      model: schedule.model,
    });
    const firedAtUtc = this.now().toISOString();
    this.deps.scheduleService.markFiringDispatched(firing.id, { taskId: created.id, firedAtUtc });
    // 成功后预登记下一次 firing（pending）。从刚 dispatched 的下一计划时刻 + 1ms 开始计算，
    // 避免与刚那行唯一键重复；即使 clock 未推进也能注册下一行。
    const nextSearchStart = new Date(new Date(firing.scheduledAtUtc).getTime() + 1);
    this.deps.scheduleService.enqueueNextFiring(schedule.id, nextSearchStart);
    this.deps.logger?.(`[scheduler] dispatch ${schedule.id} firing=${firing.id} taskId=${created.id} scheduledAt=${firing.scheduledAtUtc}`);
    return { firingId: firing.id, taskId: created.id, created: true };
  }

  private composeTaskInput(schedule: ScheduleRecord, firing: FiringRecord): JSONValue {
    const meta: Record<string, JSONValue> = {
      scheduleId: schedule.id,
      generation: firing.generation,
      scheduledAtUtc: firing.scheduledAtUtc,
      firingId: firing.id,
    };
    if (schedule.input !== null && typeof schedule.input === 'object' && !Array.isArray(schedule.input)) {
      const base = schedule.input as Record<string, JSONValue>;
      // 若 schedule.input 已经声明 kind/policy，保留；否则注入默认 policy。
      const policy: Record<string, JSONValue> = {
        effect: schedule.scheduledEffect,
        ...(base.policy && typeof base.policy === 'object' && !Array.isArray(base.policy)
          ? (base.policy as Record<string, JSONValue>)
          : {}),
      };
      return {
        ...base,
        kind: typeof base.kind === 'string' ? base.kind : 'scheduled_firing',
        cronMeta: meta,
        policy,
      };
    }
    return {
      kind: 'scheduled_firing',
      cronMeta: meta,
      policy: { effect: schedule.scheduledEffect },
      value: schedule.input,
    };
  }

  /**
   * 批量拉 due firings（已按 missed 策略过滤），逐个 dispatch。
   * 错误隔离：单个失败不影响后续 firing 与 schedule 继续运行。
   */
  runOnce(limit = 50): { processed: number; dispatched: number; failed: number } {
    let processed = 0;
    let dispatched = 0;
    let failed = 0;
    const due = this.deps.scheduleService.listDueFirings(this.now(), limit);
    for (const firing of due) {
      processed += 1;
      const schedule = this.deps.scheduleService.getSchedule(firing.scheduleId);
      if (!schedule) {
        // schedule 已删（仅当用户显式 delete 才发生；FK 不会级联）：标 skipped 释放 key。
        this.deps.scheduleService.markFiringSkipped(firing.id, 'schedule_missing');
        failed += 1;
        continue;
      }
      if (!schedule.enabled) {
        this.deps.scheduleService.markFiringSkipped(firing.id, 'schedule_disabled');
        failed += 1;
        continue;
      }
      try {
        this.dispatch(firing, schedule);
        dispatched += 1;
      } catch (error) {
        const code = error instanceof RuntimeError ? error.code : 'DISPATCH_FAILED';
        const detail = error instanceof Error ? error.message : String(error);
        this.deps.logger?.(`[scheduler] dispatch failed ${firing.id}: ${code} ${detail}`);
        // REQUEST_ID_CONFLICT 表示同 taskId 已存在（极少见：跨重启同 firing 走同 taskId）——标 dispatched_failed。
        this.deps.scheduleService.markFiringCompleted(firing.id, { state: 'dispatched_failed', errorCode: code });
        failed += 1;
      }
    }
    return { processed, dispatched, failed };
  }
}

/**
 * 新建 firing 调度成功的后续：登记下一次 firing（pending）让引擎能看到。
 * 不阻塞当前事务：即使崩溃，下一次启动仍能从 listDueFirings 找出已 dispatch 的 firing，
 * 并从其 scheduledAtUtc 之后补登下一次。
 */
export function enqueueNextFiringAfter(
  scheduleService: ScheduleService,
  scheduleId: string,
  fromUtc: Date,
): FiringRecord {
  return scheduleService.enqueueNextFiring(scheduleId, fromUtc);
}

// 暴露给上层做调度循环接线。
export function newFiringIdFor(scheduleId: string, generation: number, scheduledAtUtc: string): string {
  return `cron:${scheduleId}:${generation}:${scheduledAtUtc}`;
}

export function firingIdFromTaskId(taskId: string, scheduleId: string, generation: number, scheduledAtUtc: string): string {
  void taskId;
  return newFiringIdFor(scheduleId, generation, scheduledAtUtc);
}

export { inputHashOf };
