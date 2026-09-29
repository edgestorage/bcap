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

## 使用

```bash
node scripts/bcap.mjs status     # 端点、浏览器版本、标签页
node scripts/bcap.mjs launch     # 确保受管 Chromium 在运行
node scripts/bcap.mjs run sites/examples/read-page-summary.js --new https://example.com --input '{"linkLimit":5}'
node scripts/bcap.mjs exec --script "return { title: document.title }"
node scripts/bcap.mjs cdp Browser.getVersion
```

完整命令、脚本约定与安全规则见 `SKILL.md`。

## 目录

```
├── SKILL.md                    # skill 定义（name/description + 使用指南）
├── scripts/bcap.mjs            # CLI 入口（status/launch/run/exec/eval/nav/new/close/shot/text/cdp）
├── sites/                      # 可复用站点脚本库（sites/<domain>/<action>.js）
│   └── examples/               # 示例脚本
├── install.sh                  # 安装到 ~/.codex/skills/bcap
└── package.json
```
