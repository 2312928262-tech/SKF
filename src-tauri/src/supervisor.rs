// Tauri Rust Core ↔ thin CLI bridge ↔ shared Supervisor (M27 management protocol 1).
// Dropping Process closes this frontend bridge only; detached Supervisor keeps running.
// Config/schema handshake and authentication are enforced by cli/client before any write.
// Tauri Rust Core ↔ Node supervisor IPC 桥 (v0.4.4 + M08 IPC v2)
// - 按请求 ID 路由响应（pending map），慢响应不串线
// - chat 超时 300s（GPT-6 慢响应正常），超时不杀 worker；v2 action 全是快速本地操作 15s
// - 白名单 action（v1: ping/chat/provider/history；v2: task.*/events.since/memory.*/budget.status）
// - M08：{event:{eventSeq,...}} 推送帧不是请求响应，emit 到前端 "skf-event"，不进 pending map
// - stderr 写文件（D:\SKF-data\logs\supervisor-stderr.log）
// - cwd/entry 去 \\?\ 前缀（Node 对扩展长度路径敏感）

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager};

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupervisorRequest {
    pub id: String,
    pub action: String,
    /// M08：v2 请求必须带 protocol=2；缺省为 v1 兼容。
    /// M10：None 必须跳过序列化——写成 null 会被 Node 侧当成非法协议版本拒绝。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<u32>,
    #[serde(default)]
    pub data: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SupervisorResponse {
    pub id: String,
    pub ok: bool,
    #[serde(default)]
    pub data: serde_json::Value,
    #[serde(default)]
    pub error: Option<String>,
}

const MAX_FRAME_BYTES: usize = 1_048_576;
const MAX_PAYLOAD_BYTES: usize = 65_536;
/// chat 走大模型，慢是常态：300 秒
const CHAT_TIMEOUT: Duration = Duration::from_secs(300);
/// ping/provider 是本地操作：15 秒
const FAST_TIMEOUT: Duration = Duration::from_secs(15);

type PendingMap = Arc<Mutex<HashMap<String, mpsc::SyncSender<SupervisorResponse>>>>;

struct Process {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: PendingMap,
}

impl Drop for Process {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Clone, Default)]
pub struct SupervisorBridge {
    process: Arc<Mutex<Option<Process>>>,
}

/// 去掉 Windows 扩展长度前缀 `\\?\`
fn clean_path(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => rest.to_string(),
        None => s,
    }
}

impl SupervisorBridge {
    pub fn new() -> Self {
        Self { process: Arc::new(Mutex::new(None)) }
    }

    pub fn start<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let mut slot = self.process.lock().map_err(|_| "BRIDGE_POISONED")?;
        if slot.is_some() {
            return Err("ALREADY_STARTED".into());
        }

        let root = app
            .path()
            .resource_dir()
            .map_err(|_| "RESOURCE_DIR_FAILED")?;

        #[cfg(debug_assertions)]
        let root = std::env::var_os("SKF_RUNTIME_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or(root);

        let node = std::path::PathBuf::from(clean_path(&root.join("runtime").join("node.exe")));
        let entry = std::path::PathBuf::from(clean_path(
            &root.join("runtime").join("dist").join("cli.js"),
        ));
        if !node.is_file() {
            return Err("BUNDLE_INCOMPLETE: missing node.exe".into());
        }
        if !entry.is_file() {
            return Err("BUNDLE_INCOMPLETE: missing dist/cli.js".into());
        }

        let data = crate::data_dir::resolve();
        std::fs::create_dir_all(&data).map_err(|e| format!("DATA_DIR_UNWRITABLE: {}", e))?;

        let log_dir = data.join("logs");
        let _ = std::fs::create_dir_all(&log_dir);
        let stderr_log = log_dir.join("supervisor-stderr.log");

        let cwd = std::path::PathBuf::from(clean_path(&root));

        tracing::info!(
            "SPAWN node={} entry={} cwd={}",
            clean_path(&node),
            clean_path(&entry),
            clean_path(&root)
        );

        let mut command = Command::new(&node);
        command
            .arg(&entry)
            .arg("bridge")
            .current_dir(&cwd)
            .env("NODE_ENV", "production")
            .env("SKF_RUNTIME_DIR", &root)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }

        let mut child = command.spawn().map_err(|e| format!("SPAWN_FAILED: {}", e))?;

        let pipes = (
            child.stdin.take(),
            child.stdout.take(),
            child.stderr.take(),
        );
        let (stdin, stdout, stderr) = match pipes {
            (Some(i), Some(o), Some(e)) => (i, o, e),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("PIPE_FAILED".into());
            }
        };

        let stdin = Arc::new(Mutex::new(stdin));
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let child_handle = Arc::new(Mutex::new(child));

        // stdout reader: JSONL 帧分流 ——
        //   {event:{...}}  M08 事件推送 → emit 到前端（不是任何请求的响应）
        //   {id,ok,...}    响应帧 → 按 id 路由到对应请求的等待者
        let pending_rx = pending.clone();
        let app_events = app.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut frame = Vec::new();
                let result = (&mut reader)
                    .take(MAX_FRAME_BYTES as u64 + 1)
                    .read_until(b'\n', &mut frame);
                match result {
                    Ok(0) | Err(_) => {
                        // M10：子进程死亡在此首先可见（stdout EOF）。此前静默 break，
                        // 桌面端只能看到“supervisor 消失”，无法区分崩溃与干净退出。
                        tracing::error!("supervisor stdout EOF: child process exited or pipe broken");
                        break;
                    }
                    Ok(_) => {}
                }
                if frame.len() > MAX_FRAME_BYTES || frame.last() != Some(&b'\n') {
                    break;
                }
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&frame) {
                    if let Some(event) = value.get("event") {
                        // 事件推送：逐条 eventSeq；接收方去重，断线用 events.since 补。
                        let _ = app_events.emit("skf-event", event.clone());
                        continue;
                    }
                    if let Ok(reply) = serde_json::from_value::<SupervisorResponse>(value) {
                        if let Ok(mut map) = pending_rx.lock() {
                            if let Some(tx) = map.remove(&reply.id) {
                                let _ = tx.send(reply);
                            }
                            // id 不在 pending：迟到的响应（请求方已超时放弃），安全丢弃
                        }
                    }
                }
            }
        });

        // stderr → 文件（诊断用；不进 UI 防凭据泄露）
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if let Ok(mut f) = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&stderr_log)
                        {
                            let _ = f.write_all(line.as_bytes());
                        }
                    }
                }
            }
        });

        *slot = Some(Process { child: child_handle.clone(), stdin, pending });
        tracing::info!("supervisor spawned; IPC readiness not yet verified");

        // M10：子进程退出码监控——区分干净退出(0)/崩溃(非0)/被杀。
        // 此前子进程死了只能等下次请求 WRITE_FAILED 才发现，死因完全不可见。
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_secs(2));
                let status = match child_handle.lock() {
                    Ok(mut c) => c.try_wait(),
                    Err(_) => break,
                };
                match status {
                    Ok(Some(exit)) => {
                        tracing::error!("supervisor child exited: {}", exit);
                        break;
                    }
                    Ok(None) => {}
                    Err(_) => break,
                }
            }
        });
        Ok(())
    }

    /// 白名单 RPC。超时不杀 worker：迟到响应按 id 安全丢弃。
    fn call(&self, request: SupervisorRequest) -> Result<SupervisorResponse, String> {
        let is_chat = request.action == "chat";
        // v1 兼容 + M08 v2 白名单；不开放任意 tool.run 或 SQL 端点。
        const V2_ACTIONS: &[&str] = &[
            "ping",
            "history",
            "session.create",
            "session.list",
            "session.get",
            "session.rename",
            "session.archive",
            "session.restore",
            "session.history",
            "task.start",
            "task.get",
            "task.list",
            "task.cancel",
            "task.resume",
            "task.approve",
            "events.since",
            "memory.search",
            "memory.get",
            "memory.correct",
            "memory.archive",
            "memory.restore",
            "memory.status",
            "memory.backup",
            "budget.status",
            "schedule.create",
            "schedule.list",
            "schedule.get",
            "schedule.update",
            "schedule.enable",
            "schedule.disable",
            "schedule.delete",
            "schedule.firings",
            "learning.status",
            "learning.reviews",
            "learning.experiences",
            "learning.reviewNow",
            "learning.promote",
            "learning.dispute",
            "learning.revise",
            "skill.list",
            "skill.search",
        ];
        let allowed = matches!(request.action.as_str(), "ping" | "chat" | "provider" | "history" | "management")
            || V2_ACTIONS.contains(&request.action.as_str());
        if !allowed {
            return Err("ACTION_DENIED".into());
        }
        if request.protocol.unwrap_or(1) > 2 {
            return Err("PROTOCOL_VERSION_UNSUPPORTED".into());
        }
        if request.id.is_empty() || request.id.len() > 80 {
            return Err("INVALID_ID".into());
        }

        let payload = serde_json::to_vec(&request).map_err(|_| "ENCODE_FAILED".to_string())?;
        if payload.len() > MAX_PAYLOAD_BYTES {
            return Err("REQUEST_TOO_LARGE".into());
        }

        // 拿 stdin + pending 的 Arc 引用，然后释放 slot 锁（等待期间不阻塞其他请求）
        let (stdin, pending) = {
            let slot = self.process.lock().map_err(|_| "BRIDGE_POISONED")?;
            let process = slot.as_ref().ok_or_else(|| "NOT_RUNNING".to_string())?;
            (process.stdin.clone(), process.pending.clone())
        };

        let (tx, rx) = mpsc::sync_channel::<SupervisorResponse>(1);
        {
            let mut map = pending.lock().map_err(|_| "PENDING_POISONED")?;
            if map.contains_key(&request.id) {
                return Err("REQUEST_IN_PROGRESS".into());
            }
            map.insert(request.id.clone(), tx);
        }

        // 写入请求
        {
            let mut w = stdin.lock().map_err(|_| "STDIN_POISONED")?;
            let write_result = w
                .write_all(&payload)
                .and_then(|_| w.write_all(b"\n"))
                .and_then(|_| w.flush());
            if let Err(_) = write_result {
                if let Ok(mut map) = pending.lock() {
                    map.remove(&request.id);
                }
                return Err("WRITE_FAILED: supervisor 管道已断，重启应用".into());
            }
        }

        let timeout = if is_chat { CHAT_TIMEOUT } else { FAST_TIMEOUT };
        match rx.recv_timeout(timeout) {
            Ok(response) => {
                if response.id != request.id {
                    return Err("RESPONSE_ID_MISMATCH".into());
                }
                Ok(response)
            }
            Err(_) => {
                // 超时：清掉等待项即可，不杀 worker。
                // 迟到的响应会因 pending 里没有对应 id 而被安全丢弃。
                if let Ok(mut map) = pending.lock() {
                    map.remove(&request.id);
                }
                if is_chat {
                    Err("TIMEOUT: 模型响应超过 300 秒，请重试或换更快的大脑（/models）".into())
                } else {
                    Err("TIMEOUT: supervisor 无响应，重启应用".into())
                }
            }
        }
    }

    pub fn stop(&self) {
        if let Ok(mut slot) = self.process.lock() {
            *slot = None;
        }
    }
}

#[tauri::command]
pub async fn call_supervisor(
    window: tauri::WebviewWindow,
    bridge: tauri::State<'_, SupervisorBridge>,
    request: SupervisorRequest,
) -> Result<SupervisorResponse, String> {
    if window.label() != "main" {
        return Err("WINDOW_DENIED".to_string());
    }
    let bridge = bridge.inner().clone();
    tauri::async_runtime::spawn_blocking(move || bridge.call(request))
        .await
        .map_err(|_| "BRIDGE_TASK_FAILED".to_string())?
}
