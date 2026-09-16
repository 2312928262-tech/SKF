// SKF - SKF的工作台
// Tauri 主入口
//
// 启动时 spawn Node.js supervisor 子进程（Tauri 主进程 ↔ Node supervisor 通过 stdin/stdout IPC）

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    skf_lib::run();
}

