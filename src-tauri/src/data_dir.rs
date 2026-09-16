// SKF 数据目录解析（便携化）
// =================================
// 默认 %LOCALAPPDATA%\SKF\，环境变量 SKF_DATA_DIR 可覆盖。
// 自动创建子目录：config / memory / logs / jobs / checkpoints / backups。
//
// 优先级：
//   1. $SKF_DATA_DIR（环境变量，最优先）
//   2. %LOCALAPPDATA%\SKF\（跨机器便携默认）

use std::path::{Path, PathBuf};

pub const SUBDIRS: &[&str] = &[
    "config",
    "memory",
    "logs",
    "jobs",
    "checkpoints",
    "backups",
];

/// 解析数据目录。如果 env 已设则用 env；否则按优先级探测 D/C/LocalAppData。
pub fn resolve() -> PathBuf {
    // 1. 显式 env（开发/调试用）
    if let Ok(p) = std::env::var("SKF_DATA_DIR") {
        let p = PathBuf::from(p.trim());
        if !p.as_os_str().is_empty() {
            return ensure(&p);
        }
    }

    // 2. D 盘默认（本机数据）
    let d = PathBuf::from(r"D:\SKF-data");
    if is_writable(&d) {
        return ensure(&d);
    }

    // 3. 便携兜底：用户本地数据目录（非 D 盘环境 / 其他用户）
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(local).join("SKF").join("data");
        return ensure(&p);
    }

    // 4. 最后兜底：当前目录下 data
    ensure(&PathBuf::from("./data"))
}

/// 检测目录是否可写（不存在但父目录可写也算可写）
fn is_writable(path: &Path) -> bool {
    if path.exists() {
        // 已存在，尝试创建 .skf_write_test 文件
        let test = path.join(".skf_write_test");
        match std::fs::write(&test, b"ok") {
            Ok(_) => {
                let _ = std::fs::remove_file(&test);
                return true;
            }
            Err(_) => return false,
        }
    }
    // 不存在，看父目录能不能创建
    if let Some(parent) = path.parent() {
        if parent.exists() {
            // 父目录存在，试着创建
            return std::fs::create_dir_all(path).is_ok();
        }
    }
    false
}

/// 创建目录 + 所有子目录
fn ensure(root: &Path) -> PathBuf {
    if !root.exists() {
        let _ = std::fs::create_dir_all(root);
    }
    for sub in SUBDIRS {
        let p = root.join(sub);
        if !p.exists() {
            let _ = std::fs::create_dir_all(&p);
        }
    }
    root.to_path_buf()
}

/// 辅助：返回子目录绝对路径
pub fn subdir(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_returns_existing_path() {
        let p = resolve();
        assert!(p.exists(), "data dir should be created: {}", p.display());
    }

    #[test]
    fn subdirs_created() {
        // 用独立测试目录避免与其他 test 竞争
        let test_dir = std::env::temp_dir().join("skf-subdirs-test");
        std::env::set_var("SKF_DATA_DIR", &test_dir);
        let p = resolve();
        std::env::remove_var("SKF_DATA_DIR");
        for sub in SUBDIRS {
            assert!(p.join(sub).exists(), "subdir {} missing in {}", sub, p.display());
        }
        let _ = std::fs::remove_dir_all(&p);
    }

    #[test]
    fn env_override_works() {
        let test_dir = std::env::temp_dir().join("skf-env-override-test");
        std::env::set_var("SKF_DATA_DIR", &test_dir);
        let p = resolve();
        assert_eq!(p, test_dir);
        assert!(p.exists());
        std::env::remove_var("SKF_DATA_DIR");
        let _ = std::fs::remove_dir_all(&p);
    }
}
