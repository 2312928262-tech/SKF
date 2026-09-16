/**
 * 模型 provider 通用类型（旧 think 接口，M02 起为 complete 的兼容封装）
 */

export type ProviderName = 'mock' | 'openrouter' | 'deepseek' | 'astra' | 'kimi' | 'fake' | 'local' | `managed:${string}`;

export interface ThinkRequest {
  userMessage: string;
  context?: string;
  turn: number;
}

export interface ThinkResponse {
  text: string;
  toolCalls?: ToolCall[];
  /** 缺失记 null，不补 0。 */
  usage?: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens?: number | null;
    cost?: number;
    costSource?: 'configured-estimate';
  };
  provider: ProviderName;
  model: string;
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'refusal' | 'unknown';
}

export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

export interface Provider {
  name: ProviderName;
  think(req: ThinkRequest): Promise<ThinkResponse>;
  isReady(): Promise<boolean>;
}
