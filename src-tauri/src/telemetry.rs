// SKF Telemetry — 留心眼系统
// =================================
// 1. 结构化日志（tracing）—— stdout + 文件双输出
// 2. panic hook —— 崩溃自动记录到 crash.log
// 3. 健康检查 —— Doctor 报告（runtime / openclaw / 模型 / 记忆）
// 4. 诊断信息 —— 版本、运行时间、状态

use std::path::PathBuf;
use std::sync::OnceLock;
use tracing::{info, error, warn, Level};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use chrono::Local;
use serde::{Deserialize, Serialize};

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static START_TIME: OnceLock<chrono::DateTime<Local>> = OnceLock::new();

/// 初始化 logging（结构化、双输出、滚动文件）
pub fn init() {
    let log_dir = get_log_dir();
    std::fs::create_dir_all(&log_dir).ok();

    // 文件输出（滚动）
    let file_appender = RollingFileAppender::new(
        Rotation::DAILY,
        &log_dir,
        "skf.log",
    );
    let (file_writer, _guard) = tracing_appender::non_blocking(file_appender);

    // 环境变量控制 RUST_LOG，默认 info + skf_lib=debug
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,skf_lib=debug,tauri=info,supervisor=debug"));

    // stdout：人类可读
    let stdout_layer = tracing_subscriber::fmt::layer()
        .with_target(true)
        .with_thread_ids(false)
        .with_line_number(true)
        .with_file(false)
        .with_ansi(true);

    // 文件：JSON 格式（便于 grep / 分析）
    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(file_writer)
        .with_target(true)
        .with_thread_ids(true)
        .with_line_number(true)
        .with_ansi(false)
        .json();

    tracing_subscriber::registry()
        .with(env_filter)
        .with(stdout_layer)
        .with(file_layer)
        .init();

    START_TIME.get_or_init(|| Local::now());

    info!(
        version = env!("CARGO_PKG_VERSION"),
        log_dir = %log_dir.display(),
        "SKF 启动 — 留心眼系统已激活"
    );

    // 安装 panic hook
    install_panic_hook();
}

/// panic hook —— 崩溃时记录到 crash.log
fn install_panic_hook() {
    let log_dir = get_log_dir();
    std::panic::set_hook(Box::new(move |info| {
        let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let crash_log = log_dir.join("crash.log");
        let bt = std::backtrace::Backtrace::force_capture();
        let msg = format!(
            "\n[{}] ═══ PANIC ═══\n{}\n\nBacktrace:\n{}\n\n",
            timestamp, info, bt
        );
        eprintln!("{}", msg);
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&crash_log)
            .and_then(|mut f| {
                use std::io::Write;
                f.write_all(msg.as_bytes())
            });
        error!(panic_info = %info, "PANIC — 已记录到 crash.log");
    }));
}

fn get_log_dir() -> PathBuf {
    LOG_DIR
        .get_or_init(|| {
            let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
            exe.parent()
                .map(|p| p.join("logs"))
                .unwrap_or_else(|| PathBuf::from("logs"))
        })
        .clone()
}

/// 健康检查报告
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HealthReport {
    pub skf_version: String,
    pub uptime_seconds: u64,
    pub log_dir: String,
    pub log_file: String,
    pub crash_log: String,
    pub openclaw_available: bool,
    pub openclaw_version: Option<String>,
    pub node_available: bool,
    pub node_version: Option<String>,
    pub tsx_available: bool,
    pub memory_files_count: usize,
    pub issues: Vec<HealthIssue>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HealthIssue {
    pub level: String, // "warn" | "error"
    pub message: String,
    pub fix: Option<String>,
}

impl HealthReport {
    pub async fn generate(project_root: &PathBuf) -> Self {
        let mut issues = Vec::new();

        // 检测 openclaw
        let (openclaw_available, openclaw_version) = match std::process::Command::new("openclaw")
            .arg("--version")
            .output()
        {
            Ok(out) if out.status.success() => {
                let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
                (true, Some(v))
            }
            _ => {
                issues.push(HealthIssue {
                    level: "warn".to_string(),
                    message: "openclaw CLI 不可用".to_string(),
                    fix: Some("安装 OpenClaw 或检查 PATH".to_string()),
                });
                (false, None)
            }
        };

        // 检测 node
        let (node_available, node_version) = match std::process::Command::new("node")
            .arg("--version")
            .output()
        {
            Ok(out) if out.status.success() => {
                let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
                (true, Some(v))
            }
            _ => (false, None),
        };

        // 检测 tsx
        let tsx_available = std::process::Command::new("npx")
            .args(&["tsx", "--version"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !tsx_available {
            issues.push(HealthIssue {
                level: "warn".to_string(),
                message: "tsx 不可用".to_string(),
                fix: Some("npm install -g tsx".to_string()),
            });
        }

        // 数记忆文件
        let memory_files_count = count_memory_files(project_root);

        // uptime
        let uptime_seconds = START_TIME
            .get()
            .map(|t| (Local::now() - *t).num_seconds().max(0) as u64)
            .unwrap_or(0);

        let log_dir = get_log_dir();

        HealthReport {
            skf_version: env!("CARGO_PKG_VERSION").to_string(),
            uptime_seconds,
            log_dir: log_dir.display().to_string(),
            log_file: log_dir.join("skf.log").display().to_string(),
            crash_log: log_dir.join("crash.log").display().to_string(),
            openclaw_available,
            openclaw_version,
            node_available,
            node_version,
            tsx_available,
            memory_files_count,
            issues,
        }
    }

    pub fn ok(&self) -> bool {
        self.issues.iter().all(|i| i.level != "error")
    }

    pub fn print(&self) {
        println!("╔═══════════════════════════════════════╗");
        println!("║   SKF 健康检查 · v{}              ║", self.skf_version);
        println!("╚═══════════════════════════════════════╝");
        println!("⏱  uptime:           {}s", self.uptime_seconds);
        println!("📂 log dir:          {}", self.log_dir);
        println!("📄 log file:         {}", self.log_file);
        println!("🚨 crash log:        {}", self.crash_log);
        println!();
        println!("🔧 OpenClaw:         {}", if self.openclaw_available { format!("✅ {}", self.openclaw_version.as_deref().unwrap_or("")) } else { "❌ 不可用".to_string() });
        println!("🟢 Node.js:          {}", if self.node_available { format!("✅ {}", self.node_version.as_deref().unwrap_or("")) } else { "❌ 不可用".to_string() });
        println!("📦 tsx:              {}", if self.tsx_available { "✅ 可用".to_string() } else { "❌ 不可用".to_string() });
        println!("📚 memory files:     {}", self.memory_files_count);

        if !self.issues.is_empty() {
            println!();
            println!("⚠️  Issues:");
            for issue in &self.issues {
                let icon = if issue.level == "error" { "❌" } else { "⚠️" };
                println!("  {} [{}] {}", icon, issue.level, issue.message);
                if let Some(fix) = &issue.fix {
                    println!("     fix: {}", fix);
                }
            }
        }

        if self.ok() {
            println!();
            println!("✅ 一切正常");
        } else {
            println!();
            println!("❌ 有 error 级问题需要处理");
        }
    }
}

fn count_memory_files(project_root: &PathBuf) -> usize {
    let memory_dir = project_root.join("memory");
    if !memory_dir.exists() {
        return 0;
    }
    count_recursive(&memory_dir)
}

fn count_recursive(dir: &std::path::Path) -> usize {
    let mut count = 0;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                count += count_recursive(&p);
            } else if p.is_file() {
                count += 1;
            }
        }
    }
    count
}

#[tauri::command]
pub async fn get_health(project_root: String) -> Result<HealthReport, String> {
    Ok(HealthReport::generate(&PathBuf::from(project_root)).await)
}
