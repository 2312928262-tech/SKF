// SKF - SKF的工作台
// Tauri lib（主入口）

mod supervisor;
mod telemetry;
mod data_dir;
mod desktop_bridge;

use supervisor::SupervisorBridge;
use desktop_bridge::{desktop_health, desktop_launch, desktop_list_windows, desktop_snapshot};
use telemetry::{get_health, init as init_telemetry, HealthReport};
use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! 欢迎使用 SKF（SKF的工作台）", name)
}

#[tauri::command]
async fn health_check(project_root: String) -> Result<HealthReport, String> {
    get_health(project_root).await
}

/// M10：打开任务产物的本机文件（系统默认关联程序）。
/// 只允许真实存在的普通文件；路径来自 runtime.sqlite 的 artifact 登记
///（M04 已 canonicalize 并限定在任务 workspaceRoot 内）。
/// 拒绝 URL/控制字符/目录/超长路径；用 explorer.exe 传参（不经 shell 解释）。
#[tauri::command]
fn open_artifact(path: String) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 {
        return Err("INVALID_PATH".into());
    }
    if path.chars().any(|c| (c as u32) < 0x20) {
        return Err("INVALID_PATH".into());
    }
    let lower = path.to_ascii_lowercase();
    if lower.starts_with("http:") || lower.starts_with("https:") || lower.starts_with("javascript:") {
        return Err("INVALID_PATH".into());
    }
    let canonical = std::fs::canonicalize(&path).map_err(|_| "PATH_NOT_FOUND".to_string())?;
    let meta = std::fs::metadata(&canonical).map_err(|_| "PATH_NOT_FOUND".to_string())?;
    if !meta.is_file() {
        return Err("NOT_A_FILE".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("OPEN_FAILED: {}", e))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("OPEN_FAILED: {}", e))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 1. 初始化 telemetry（tracing + panic hook + log 目录）
    init_telemetry();

    tracing::info!("SKF 启动中...");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SupervisorBridge::new())
        .setup(|app| {
            // 启动 supervisor 子进程
            let bridge = app.state::<SupervisorBridge>();
            match bridge.start(app.handle()) {
                Ok(_) => tracing::info!("supervisor spawned; IPC readiness not yet verified"),
                Err(e) => tracing::error!("supervisor 启动失败: {}", e),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, supervisor::call_supervisor, health_check, open_artifact, desktop_health, desktop_list_windows, desktop_snapshot, desktop_launch])
        .build(tauri::generate_context!())
        .expect("error while building SKF")
        .run(|app, event| {
            // 应用退出时清理 Node 子进程
            if let tauri::RunEvent::Exit = event {
                if let Some(bridge) = app.try_state::<SupervisorBridge>() {
                    bridge.stop();
                }
            }
        });
}
