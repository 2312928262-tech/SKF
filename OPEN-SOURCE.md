# SKF 开源发布说明

> 发布前按此清单走一遍，确保不泄露个人数据与身份。

## 1. 发布前必须做的事

1. **人设模板化**：把 `templates/prompts/IDENTITY.md、MEMORY.md、TOOLS.md` 覆盖到 `prompts/`（开源版用通用模板，不含"SKF"身份）。
2. **路径确认**：代码默认值已便携化（数据目录 `~/.skf`、记忆 `~/.skf/vault`、媒体路径走环境变量），无需再改。
3. **依赖清单**：`package.json` 只含 `playwright` 等必要依赖，`node:sqlite` 零第三方数据库。
4. **扫描**：`node scripts/stage-candidate.mjs` 的打包扫描应报 CLEAN（无密钥/无日志/无 .env）。
5. **测试**：`npm test` 全绿（当前 314/314）。

## 2. 必须排除的目录（不入库）

| 目录/文件 | 原因 |
|---|---|
| `evidence/` `designs/` `dev/` `temp/` | 施工过程草稿 |
| `agents/` `runtime-candidate/` `release/` `.work/` | 构建产物/旧版本 |
| `astra-*.md` `handoff-*.mjs` 等 | 个人开发辅助脚本 |
| `.env` `*.sqlite` `config.env` | 密钥/个人数据 |
| `prompts/IDENTITY.md` 等（发布前换模板） | 个人身份 |

## 3. 原生桥依赖（不在仓库内，用户自装）

- UIA：`bin/UiaHelper.exe`（源码 `scripts/uia-helper/UiaHelper.cs`，`scripts/build-uia-helper.mjs` 用 csc.exe 编译）
- 浏览器：`playwright` + chromium（`npx playwright install chromium`）
- 媒体：ComfyUI（127.0.0.1:8188）、faster-whisper、CosyVoice2（各自 venv，路径走 `SKF_*_PYTHON` 环境变量）
- 记忆语义检索：本地 bge-m3（Ollama，可选，离线降级关键词）

## 4. 发布步骤

```bash
# 在干净目录初始化（不要直接用开发目录，避免带入草稿）
git init
# 只 add 核心文件（排除清单见 .gitignore）
git add src/ src-tauri/ ui-preview/ scripts/ tests/ prompts/ templates/ package.json tsconfig.json LICENSE README.md .gitignore
git commit -m "SKF initial release"
git remote add origin <你的仓库>
git push -u origin main
```

## 5. 许可证

MIT（见 LICENSE）。
