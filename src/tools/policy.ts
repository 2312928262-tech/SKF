import { RuntimeError, type Effect } from '../runtime/contracts.js';

/**
 * M04 · PolicyGate：任务级授权表（02-CONTRACTS.md E 节）。
 * 用户已授权的本地交付（root 内 read / workspace_write）执行时免重复弹窗；
 * external_write / process 首版没有适配器 → TOOL_UNAVAILABLE，绝不模拟完成。
 * 未来开放这些能力时必须走 approvals 表并绑定参数 hash（M03 已有审批表与
 * APPROVAL_INPUT_CONFLICT 语义）；批准不得从网页或记忆原文提取。
 */

export interface TaskAuthorization {
  /** 任务创建时由可信调用方固定的 root（与 TaskService.tasks.workspaceRoot 一致）。 */
  workspaceRoot: string;
  /** 本任务被授权的效果集合；模型侧参数无法改变它。 */
  allowedEffects: readonly Effect[];
  /**
   * M09：本任务显式授权的 OpenClaw 桥接工具名（逐个点名，来自任务创建时的可信输入）。
   * 缺省/空 = 任何桥接工具都 POLICY_DENIED；不存在“一键透传所有 OpenClaw 工具”。
   */
  allowedBridgeTools?: readonly string[];
  /**
   * M14：本任务显式授权的 MCP 工具名（mcp/<serverId>/<tool> 逐个点名，任务绑定目录快照）。
   * 缺省/空 = 任何 MCP 工具都 POLICY_DENIED。副作用工具（external_write/process）
   * 还须另有 inputHash 绑定的 approved 审批（registry 的 approval gate 复核）。
   */
  allowedMcpTools?: readonly string[];
}

/** 本地文件交付任务的默认授权：读 + 工作区内写。 */
export function localDeliveryAuthorization(workspaceRoot: string): TaskAuthorization {
  return { workspaceRoot, allowedEffects: ['read', 'workspace_write'] };
}

/** 工具执行前的效果授权检查。 */
export function authorizeEffect(effect: Effect, auth: TaskAuthorization): void {
  if (auth.allowedEffects.includes(effect)) return;
  if (effect === 'external_write' || effect === 'process') {
    // 没有适配器：能力是 unavailable，不是“拒绝后再想想办法”。
    throw new RuntimeError('TOOL_UNAVAILABLE', `${effect} has no adapter; requires future approval-bound adapter`);
  }
  throw new RuntimeError('POLICY_DENIED', `${effect} not in task authorization`);
}
