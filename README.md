# bcap

一个 Codex skill：通过 Playwright 和原生 CDP 操作本机 Chromium 的浏览器自动化工具，全部用 Node 实现。

- 自包含：`SKILL.md`（skill 定义）+ `scripts/bcap.mjs`（CLI）+ `sites/`（按站点沉淀的可复用脚本）
- 连接任务实例内的受管 Chromium（自动发现 CDP 端点，通常为 `http://127.0.0.1:9201`），也可用 `--cdp` 指向任意已开调试端口的 Chromium
- 脚本复用：脚本文件写一次，之后用 `--input` 反复执行

## 安装

作为 Codex skill 安装：

```bash
bash install.sh            # 拷贝到 ~/.codex/skills/bcap
bash install.sh --symlink  # 或软链到本目录
```

或直接克隆到 skills 目录：

```bash
git clone <repo-url> ~/.codex/skills/bcap
cd ~/.codex/skills/bcap && npm install
```

## 依赖

- Node.js 18+（需要 `fetch` / `AbortSignal.timeout`）
- `playwright-core`（`npm install` 安装，不下载浏览器）

## 浏览器由 TaskHandoff 托管

本 skill 面向 TaskHandoff 受管实例：浏览器是实例的受管 app（`appId=chromium`），不需要自己裸起 Chromium。

```bash
node scripts/bcap.mjs launch   # 复用运行中的会话；没有则创建并等待 CDP 就绪
node scripts/bcap.mjs status   # 查看 CDP 端点、浏览器版本与标签页
```

- 等价的手工调用：`curl -X POST http://127.0.0.1:8080/api/apps/sessions -H 'Content-Type: application/json' -d '{"appId":"chromium"}'`
- 会话同时提供 CDP（默认 `http://127.0.0.1:9201`）和实例 Web UI 中的 KasmVNC 可视窗口，用户可实时看到并操作同一个浏览器
- 支持同时运行多个浏览器会话：`status` 列出全部（默认目标带 default 标记），用 `--session <id>` 指定目标，`launch --new-session` 再开一个，`stop <id>` 停止指定会话
- API 地址默认 `http://127.0.0.1:8080`，用 `--api` / `BCAP_API` 覆盖；连接其它已开调试端口的 Chromium 用 `--cdp` / `BCAP_CDP`
- 停止会话：实例 UI 或 `POST /api/apps/sessions/<id>/stop`

## 使用

```bash
node scripts/bcap.mjs status     # 端点、浏览器版本、标签页
node scripts/bcap.mjs launch     # 确保受管 Chromium 在运行
node scripts/bcap.mjs run sites/examples/read-page-summary.js --new https://example.com --input '{"linkLimit":5}'
node scripts/bcap.mjs cdp Browser.getVersion
```

完整命令、脚本约定与安全规则见 `SKILL.md`。

## 目录

```
├── SKILL.md                    # skill 定义（name/description + 使用指南）
├── references/                 # 脚本编写指南（reuse 规范、命名、域名 README、示例、旧脚本移植）
├── scripts/bcap.mjs            # CLI 入口（status/launch/stop/run/exec/eval/nav/new/close/shot/text/cdp）
├── sites/                      # 可复用站点脚本库（sites/<domain>/<capability-name>.js）
│   └── examples/               # 示例脚本 + 域名 README 示例
├── agents/openai.yaml          # skill UI 元数据
├── install.sh                  # 安装到 ~/.codex/skills/bcap
└── package.json
```
