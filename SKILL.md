---
name: bcap
description: "Use a local Chromium over Playwright/CDP for browser-rendered or authenticated UI tasks: inspect pages, click/type, extract data, screenshot, and save reusable site scripts. Skip static HTTP fetches and source-only analysis."
---

# bcap — local browser capability

Drive a local Chromium over CDP. The same CLI works inside a TaskHandoff instance (managed `chromium` app session) and on a plain machine (reuse an existing debug port or launch local Chrome/Chromium). Output is compact JSON unless `--pretty` is requested.

Run commands from this skill folder (the directory containing this `SKILL.md`):

```bash
cd <skill-folder>
node scripts/bcap.mjs help
```

## Start

```bash
node scripts/bcap.mjs status   # environment, browser, sessions and tabs; may report running:false
node scripts/bcap.mjs launch   # idempotent: reuse a reachable browser, otherwise start one
node scripts/bcap.mjs list     # open page tabs and targetIds
```

- `status` returning `running:false` is a normal check result; run `launch`, then check again.
- More than one browser session and no clear target: ask the user rather than guessing; then pass `--session <id>`.
- `--env taskhandoff|local` or `BCAP_ENV` forces the environment. Use `--env local` when TaskHandoff markers are present but no control plane is reachable and a local browser is the intended target.
- Target tabs with `--url <substring>`, `--tab <targetId>`, `--new [url]`, or navigate before acting with `--nav <url>`.

Environment detection, managed/local browser lifecycle, multi-session handling and recovery are in `references/environments.md`.

## Execution mode

- If the task can finish without a person touching the browser, prefer headless when bcap launches a local browser, using `launch --headless` or `BCAP_HEADLESS=1`. Automated login, tests, extraction and agent-performed visual checks via screenshots are unattended.
- Use the visible browser only when the user must interact with, observe or take over the browser. This includes manual credentials/MFA or CAPTCHA, confirmation, payment, or an explicit request to watch. Override an inherited `BCAP_HEADLESS=1` with `BCAP_HEADLESS=0`.
- `launch` reuses an existing browser. To switch an existing headless local session to visible, run `stop all` (or stop the relevant session), then launch again without headless. In a TaskHandoff instance, use the managed Chromium session and its visible KasmVNC view.
- If the requested mode cannot be provided by the current browser, explain why and ask before stopping a user-controlled browser.

## Choose the lightest tool

- Tiny page reads: `eval "<expression>"` for one expression, or `exec --script "..."` for a small DOM script.
- Visible text, screenshots and tab management: `text`, `shot`, `list`, `nav`, `new`, `close`.
- Trusted user input: `click <selector>`, `type <selector> <text>`, `press <key>`.
- Raw browser protocol: `cdp <Domain.method> --params '<json>'`.
- Non-trivial or repeated work: write a reusable script under `sites/<domain>/` and run it with `run`.

```bash
node scripts/bcap.mjs eval "document.title"
node scripts/bcap.mjs exec --script "return { title: document.title, url: location.href }"
node scripts/bcap.mjs text --limit 4000
node scripts/bcap.mjs shot /tmp/page.png
node scripts/bcap.mjs click 'button[type=submit]'
node scripts/bcap.mjs type 'input[name=q]' 'hello world' --clear --delay 40
node scripts/bcap.mjs press Enter --selector 'input[name=q]'
node scripts/bcap.mjs cdp Browser.getVersion
```

## Work loop

1. Check the browser and identify the tab the user is working in.
2. Explore with `eval` / `exec` / `text`; avoid dumping full HTML or whole-page text.
3. Act through the page's own UI, then verify the resulting URL, DOM, or success message.
4. Check `scripts --domain <domain>` or `scripts --match <url>` before writing a repeated workflow; reuse or update the existing script.
5. Keep a tab open only when it is the deliverable, needed for the next step, or awaiting user-only action. Close temporary tabs you opened.

## Reusable scripts

The script contract is ESM `export default async function (input) { ... }`. Globals: `page`, `context`, `browser`, `cdp`, `cap`, and `input`. Return structured JSON; do not `console.log`, because stdout carries the result.

Save scripts to `sites/<domain>/<capability-name>.js`, include the machine-readable header, and document the domain in its `README.md`. Read `references/script-authoring.md` before writing or changing a script.

```bash
node scripts/bcap.mjs scripts --match https://example.com/
node scripts/bcap.mjs run sites/examples/read-page-summary.js --new https://example.com --input '{"linkLimit":5}'
node scripts/bcap.mjs run sites/<domain>/<capability>.js --url example.com --input-file input.json
```

## Execution controls

- `--timeout <ms>` bounds `run`, `exec`, `eval` and real-input actionability (default 30000; `wait` defaults to 120000; maximum 120000).
- `--evidence [events|dom|common|all]` records navigation, console errors, failed requests and visible-element diffs around `run`/`exec`/input actions. Use it to prove an effect or diagnose flakiness.
- `--evidence-limit <n|all>` caps each DOM list; counts and `omitted` remain exact.
- `wait` blocks on a condition instead of sleeping: `--until-selector`, `--until-text`, `--until-url`, or `--url-change`.
- `history --limit N` shows recent `run`/`exec` entries, including their inputs.

## Token economy

- stdout is compact single-line JSON by default; use `--pretty` only when a human will read it.
- Request less with `--limit`, `--evidence events`, and `--evidence-limit`.
- Return counts plus capped arrays (`itemCount`, `truncated`) from scripts instead of full collections or raw HTML.
- Prefer role/text locators and event waits over fixed sleeps.

## Operating rules

- Never place credentials or secrets in `--input`; execution history persists inputs. Let the user authenticate in the managed tab.
- Prefer browser-visible UI actions over private or semi-private site APIs unless the user asks for API execution or the UI path is unavailable and the tradeoff is explained first.
- For delete/send/pay/post or other destructive or externally visible actions, return a preview plan and wait for explicit confirmation before executing.
- Pause for login, CAPTCHA, payment, approval, or permission problems and leave the tab open for the user.
- Do not leave a human-in-the-loop task in a headless session where the user cannot take over.
- Treat screenshots, page text and DOM evidence as potentially sensitive; return only what the task needs.

Tab policy and state-changing actions are detailed in `references/safety.md`. Environment-specific behavior is in `references/environments.md`.

## References

- `references/environments.md` — environment detection, TaskHandoff vs local browsers, lifecycle, recovery.
- `references/script-authoring.md` — script headers, index, output conventions, multi-page flows, examples.
- `references/safety.md` — tab ownership, state-changing actions, sensitive data.
