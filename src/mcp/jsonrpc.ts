import { RuntimeError, type JSONValue } from '../runtime/contracts.js';

/**
 * M14 · MCP stdio 传输的 JSON-RPC 2.0 帧层（NDJSON，每行一条完整消息）。
 *
 * 纪律：
 * - 单行超过 maxLineBytes = 协议违规（恶意超大输出防护在帧层，不在业务层）；
 *   违规即 fail 全部在途调用并触发 onProtocolViolation（调用方负责杀 server）。
 * - 只关联我们发出的请求 id；未知 id 的响应/通知一律丢弃（防伪造响应）。
 * - server 主动发起的 request（sampling/roots/elicitation 等）一律回 JSON-RPC
 *   方法不存在错误——SKF 绝不被 server 反驱动（绝不替它调模型/读根目录）。
 * - 本层不做 MCP 语义；initialize/tools 语义在 registry/supervisor。
 */

export interface JsonRpcPeerOptions {
  /** 单行帧字节上限（默认 1MB）；超限 = MCP_PROTOCOL_VIOLATION。 */
  maxLineBytes?: number;
  /** server → client 通知（tools/list_changed 等）。 */
  onNotification?: (method: string, params: JSONValue) => void;
  /** 协议违规（帧超限/JSON 解析失败/非法响应形状）。 */
  onProtocolViolation?: (detail: string) => void;
  logger?: (line: string) => void;
}

interface PendingCall {
  method: string;
  resolve: (value: JSONValue) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_MAX_LINE_BYTES = 1_000_000;

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private buffer = Buffer.alloc(0);
  private violated = false;
  private readonly maxLineBytes: number;

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly opts: JsonRpcPeerOptions = {},
  ) {
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    input.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  /** 发出请求并等待响应；超时 reject MCP_CALL_TIMEOUT。 */
  call(method: string, params: JSONValue, timeoutMs: number): Promise<JSONValue> {
    if (this.violated) return Promise.reject(new RuntimeError('MCP_PROTOCOL_VIOLATION', 'peer in violated state'));
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<JSONValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RuntimeError('MCP_CALL_TIMEOUT', `${method} >${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.output.write(message + '\n', (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new RuntimeError('MCP_TRANSPORT_ERROR', error.message));
        }
      });
    });
  }

  /** 发出通知（无响应）。 */
  notify(method: string, params?: JSONValue): void {
    if (this.violated) return;
    this.output.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }) + '\n');
  }

  /** fail 全部在途调用（传输死亡/协议违规时）；幂等。 */
  failAll(code: string, detail: string): void {
    for (const [id, pendingCall] of this.pending) {
      clearTimeout(pendingCall.timer);
      pendingCall.reject(new RuntimeError(code, detail));
      this.pending.delete(id);
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private onData(chunk: Buffer): void {
    if (this.violated) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // 帧层超限防护：还没找到换行就已超限 = 恶意/失控输出，立即违规。
    for (;;) {
      const nl = this.buffer.indexOf(0x0a);
      if (nl === -1) {
        if (this.buffer.length > this.maxLineBytes) return this.violate(`unterminated line >${this.maxLineBytes} bytes`);
        return;
      }
      if (nl > this.maxLineBytes) return this.violate(`line ${nl} bytes >${this.maxLineBytes}`);
      const line = this.buffer.subarray(0, nl);
      this.buffer = this.buffer.subarray(nl + 1);
      this.onLine(line);
      if (this.violated) return;
    }
  }

  private onLine(line: Buffer): void {
    const text = line.toString('utf8').replace(/\r$/, '');
    if (!text.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return this.violate('invalid JSON frame');
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return this.violate('frame not an object');

    // 响应：有 id 且 (有 result 或 error)。只认我们发出的 id。
    if ('id' in message && (('result' in message) || ('error' in message))) {
      const id = message.id;
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) return this.violate('response id not an integer');
      const pendingCall = this.pending.get(id);
      if (!pendingCall) {
        // 未知/过期 id：可能是迟到响应或伪造，丢弃但不违规（超时 id 会被复用前先到）。
        this.opts.logger?.(`mcp rx: dropped response for unknown id ${id}`);
        return;
      }
      this.pending.delete(id);
      clearTimeout(pendingCall.timer);
      if ('error' in message) {
        const err = message.error as { code?: unknown; message?: unknown } | null;
        const detail = err && typeof err === 'object' && typeof err.message === 'string' ? err.message.slice(0, 300) : 'unknown';
        const errCode = err && typeof err === 'object' && typeof err.code === 'number' ? err.code : 0;
        pendingCall.reject(new RuntimeError('MCP_SERVER_ERROR', `${pendingCall.method}: [${errCode}] ${detail}`));
      } else {
        pendingCall.resolve((message.result === undefined ? null : message.result) as JSONValue);
      }
      return;
    }

    // server → client 请求：一律方法不存在，绝不被反驱动。
    if ('id' in message && typeof message.method === 'string') {
      const id = message.id;
      this.opts.logger?.(`mcp rx: refused server-initiated request ${message.method}`);
      this.output.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: SKF never executes server-initiated requests' } }) + '\n');
      return;
    }

    // 通知。
    if (typeof message.method === 'string') {
      this.opts.onNotification?.(message.method, (message.params === undefined ? null : message.params) as JSONValue);
      return;
    }
    this.violate('frame is neither response, request, nor notification');
  }

  private violate(detail: string): void {
    if (this.violated) return;
    this.violated = true;
    this.opts.onProtocolViolation?.(detail);
    this.failAll('MCP_PROTOCOL_VIOLATION', detail);
  }
}
