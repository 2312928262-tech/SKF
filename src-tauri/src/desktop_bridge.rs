// M17 · 桌面工具层 Rust 桥（按 uia-snapshot.md / gui-interact.md 设计；TS 侧见 src/desktop/）
//
// 首版策略：
//   - 不接真实 Windows UIA helper（依赖 COM 会话 + 前台窗口，测试环境不可重现）。
//   - 暴露命令签名 + 占位实现：listWindows/snapshot/launch 一律返回 UIA_UNAVAILABLE /
//     LAUNCH_UNAVAILABLE，TS 侧如实桥接，绝不假装成功。
//   - 保留 helper 进程树管理骨架（Job Object KILL_ON_JOB_CLOSE），与 M14 JobLauncher
//     同源思路；真实启动由后续卡位打开。
//
// 与 TS 的边界：
//   - Rust 不做任何审批/账本/调度；审批门在 TS ToolRegistry.execute（hasApproved(inputHash)）。
//   - TS 侧 FakeUiaBridge/FakeLauncherBridge 已经覆盖全部测试场景；RealUiaBridge 仅作契约占位。

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct DesktopWindowInfo {
    pub ephemeral_id: String,
    pub pid: u32,
    pub title: String,
    pub class_name: String,
    pub is_visible: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DesktopSnapshotRequest {
    pub ephemeral_id: String,
    pub view: Option<String>,
    pub text_policy: Option<String>,
    pub max_nodes: Option<u32>,
    pub max_depth: Option<u32>,
    pub max_bytes: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DesktopSnapshotResponse {
    pub schema_version: u32,
    pub status: String,
    pub message: String,
}

/// Tauri command：列前台顶层窗口（首版永远返回空 + 不可用诊断）。
#[tauri::command]
pub async fn desktop_list_windows(
    _visible_only: Option<bool>,
    _restrict_pids: Option<Vec<u32>>,
    _limit: Option<u32>,
) -> Result<Vec<DesktopWindowInfo>, String> {
    // 首版：未启用 Rust helper 时如实汇报，不假装可用。
    Err("UIA_UNAVAILABLE: Rust helper not enabled in first release".into())
}

/// Tauri command：UIA 快照（首版未启用）。
#[tauri::command]
pub async fn desktop_snapshot(
    _request: DesktopSnapshotRequest,
) -> Result<DesktopSnapshotResponse, String> {
    Err("UIA_UNAVAILABLE: Rust helper not enabled in first release".into())
}

/// Tauri command：启动白名单进程（首版未启用；TS FakeLauncherBridge 已覆盖测试）。
#[tauri::command]
pub async fn desktop_launch(
    _executable: String,
    _args: Option<Vec<String>>,
    _cwd: Option<String>,
    _detached: Option<bool>,
) -> Result<u32, String> {
    Err("LAUNCH_UNAVAILABLE: Rust helper not enabled in first release".into())
}

/// 健康检查（首版永远 unavailable；real helper 启用后此处返回 state）。
#[tauri::command]
pub async fn desktop_health() -> Result<String, String> {
    Ok("unavailable".into())
}
