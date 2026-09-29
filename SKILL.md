---
name: bcap
description: Operate the local Chromium browser through Playwright and raw CDP - check or launch the browser, run reusable Node browser scripts, read/click/type on pages, extract data, take screenshots. Use for browser automation, web data extraction, site workflows, or any task needing a real browser tab.
---

# bcap — local browser capability

Self-contained skill folder: `SKILL.md` + `scripts/bcap.mjs` (Node CLI, Playwright + raw CDP) + `sites/` (reusable scripts) + `references/` (authoring guide). It drives the TaskHandoff-managed Chromium; the CDP endpoint is auto-discovered (usually `http://127.0.0.1:9201`) and the VNC view is visible in the instance UI.

All commands run from the skill folder:

```bash
cd /workspace/bcap
node scripts/bcap.mjs help
```

## Connection checks

Before the first page automation step in a task, check the browser:

```bash
node scripts/bcap.mjs status   # browser sessions, CDP endpoints, open tabs
node scripts/bcap.mjs launch   # no session running: start one and wait for CDP
```

- No running session → `launch`, then re-check.
- Multiple sessions running → target the matching one with `--session <id>`; do not guess when ambiguous — ask the user.
- Target page not open → `nav` / `new`, or ask the user to open it.

## Browser lifecycle (TaskHandoff-managed)

The browser is a managed app of the TaskHandoff instance — do not spawn a bare Chromium:

- `launch` reuses a running `chromium` app session, or creates one via `POST /api/apps/sessions` (`appId: chromium`), waits until CDP is ready, and prints the endpoint. It is a no-op when a session is already running.
- Multiple browsers can run at once. `status` lists all sessions (the first running one is the default target); add `--session <id>` to target another, `launch --new-session` to start an additional session, and `stop <sessionId>` to end one.
- The managed session exposes CDP at `http://127.0.0.1:9201` and a KasmVNC view in the instance Web UI, so the user can watch and interact with the same tabs.
- API base defaults to `http://127.0.0.1:8080`; override with `--api <url>` or `BCAP_API`. To drive a different Chromium (debugging port already open), use `--cdp <url>` or `BCAP_CDP`.
- Tabs persist inside the session; it keeps running until stopped from the instance UI or `POST /api/apps/sessions/<id>/stop`.
- If `status` reports no endpoint, run `launch` first — script/page commands fail fast with that hint otherwise.

## Run scripts and reuse (core capability)

Choose the lightest form that fits the task:

- Tiny one-off reads (`document.title`, `location.href`, a short text fragment): `exec --script "..."` or `eval "..."`.
- Non-trivial or repeated work: a script file — this is the reusable capability path.

```bash
node scripts/bcap.mjs scripts                                    # list the reusable script library
node scripts/bcap.mjs scripts --domain github.com --match <url>  # filter by domain / by what can run there
node scripts/bcap.mjs run sites/examples/read-page-summary.js --new https://example.com --input '{"linkLimit":5}'
echo '{"linkLimit":3}' | node scripts/bcap.mjs run sites/examples/read-page-summary.js --url example.com --input-file -
```

Reusable script contract:

- ESM `export default async function (input) { ... }`; globals: `page` (Playwright Page), `context`, `browser`, `cdp` (page CDP session), `cap` (`{ page, context, browser, cdp, goto, click, type, press, sleep }`), `input`.
- Return structured JSON (`{ ok, url, title, ... }`), not loose arrays or strings. Do not `console.log` — stdout carries the returned result.
- Pass variable data through `--input '<json>'` / `--input-file <path>`; `--script-file -` and `--input-file -` read from stdin (stdin can only be consumed once — do not combine both).
- Save reusable scripts to `sites/<domain>/<capability-name>.js` (domain = registrable domain, e.g. `github.com`, `docs.openai.com`).
- Interact with `cap.click` / `cap.type` / `cap.press` (real input), not synthetic DOM events — see Real input below.

Before writing a new script:

1. Check the library first: `node scripts/bcap.mjs scripts --domain <domain>` (or `--match <url>`), then read `sites/<domain>/` and its `README.md` when present.
2. Read `references/script-authoring.md` for the header format, naming, the domain README format, multi-page flows and worked examples.

Tab selection for page commands: `--url <substr>` (reuse matching tab), `--tab <targetId>`, `--new [url]`, `--nav <url>` (navigate before acting); browser selection: `--session <id>`.

## Execution controls

- `--timeout <ms>` bounds `run` and `exec` (default 30000, max 120000). On expiry the CLI prints `{ok:false, timedOut:true, error:"... timed out after Xms", url, title}` and exits 1 immediately; page actions the script already dispatched may still settle, so re-check page state before retrying.
- `--evidence [sets]` records what happened during a `run`/`exec` and merges an `evidence` object into the result. Sets: `events` (navigation, console-error/warning, page-error, dialog, download, request-failed, new-tab), `dom` (visible-element diff with stable route keys, plus before/after timing), `common` (= events + dom), `all` (default when no value given). Use it to prove an action took effect and to debug flaky scripts. DOM lists default to 100 entries per list (`counts` and `omitted` are always exact; use `--evidence-limit all` for everything), and evidence briefly waits for the page to settle so async renders are captured.
- `wait` blocks until a page condition is met instead of sleeping: `--until-selector <css>`, `--until-text <str>`, `--until-url <substr>`, `--url-change`; `--poll <ms>` (default 500), `--timeout <ms>` (default 120000). Exit code 1 on timeout.
- `history [--limit N]` (default 20) lists recent executions with script, input, session, url/title, duration and error.

## Real input (clicks, typing, keys)

Drive the UI like a user: Playwright input is trusted by the page (`event.isTrusted === true`), while in-page `element.click()` / `dispatchEvent` is not and many sites ignore it (GitHub's file finder, for example). Prefer real input for anything that reacts to user gestures:

```bash
node scripts/bcap.mjs click 'button.submit'                          # real click
node scripts/bcap.mjs type 'input[name=q]' 'hello world' --delay 40  # click, then real keystrokes
node scripts/bcap.mjs type '#field' 'replace me' --clear             # clear the field first
node scripts/bcap.mjs press Enter --selector 'input[name=q]'         # real key press on an element
node scripts/bcap.mjs press 'Control+K'                              # key press on the focused element
```

Inside scripts use the same helpers on `cap` (`await cap.click(sel)`, `await cap.type(sel, text, { clear, delay })`, `await cap.press(key, { selector })`) or Playwright's own `page.getByRole(...).click()` / `page.keyboard.type(...)`. All three return `{ok, url, title, ...}` and accept `--timeout <ms>` for actionability waits.

## Token economy

stdout is compact single-line JSON by default; add `--pretty` (or `BCAP_FORMAT=pretty`) only when a human will read it. Keep results small:

- Ask for less: `--limit` on `text`/`history`, `--evidence events` when DOM diffs are not needed, and `--evidence-limit <n|all>` for DOM lists (default 100 per list; `counts` are exact and `omitted` reports what was cut).
- DOM evidence entries omit empty fields (`id`, `text`, `rect`), so large diffs stay cheap.
- In scripts, return counts plus capped arrays (`itemCount`, `truncated`) instead of dumping full page text or HTML; never echo raw HTML.

## Playwright usage

Standard Playwright API; prefer role/text locators and event waits over fixed sleeps:

```js
export default async function (input) {
  await page.locator('input[name="q"]').fill(input.query);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.waitForLoadState('domcontentloaded');
  const items = await page.locator('.result').allTextContents();
  return { ok: true, url: page.url(), title: await page.title(), items };
}
```

## Raw CDP

- Inside scripts: `await cdp.send('Network.enable')`; browser-level session via `await browser.newBrowserCDPSession()`.
- From the CLI:

```bash
node scripts/bcap.mjs cdp Browser.getVersion
node scripts/bcap.mjs cdp Page.getFrameTree --url example.com
node scripts/bcap.mjs cdp Page.captureScreenshot --params '{"format":"png"}' --url example.com
```

## One-off scripts

`exec` runs DOM code inside the page (no Playwright API): a body with `return {...}`, or `export default async function (input) {...}`. `eval` evaluates a single expression. Both accept `--script-file <file|->` and stdin `-`.

```bash
node scripts/bcap.mjs exec --script "return { title: document.title, url: location.href }"
node scripts/bcap.mjs eval "document.title"
echo 'return { count: document.querySelectorAll("a").length }' | node scripts/bcap.mjs exec --script-file -
```

## Tab policy

- Reuse the tab the user already has open for the task; do not close or repurpose the user's tabs without need.
- Close only the temporary tabs you opened (lookup, navigation, verification) once their result is captured.
- Keep a tab open when it is the deliverable, when the next step depends on it, or when it is waiting on a user-only action (login, captcha, payment, approval) for handoff.
- If several tabs match, prefer the clear match; ask the user when it is ambiguous.
- Keep at most 20 tabs overall (workspace rule); check `list` before opening new ones on busy tasks.

## Stateful site actions

For actions that change a user's account or site state (post, edit, delete, settings, subscriptions):

- Prefer browser-visible UI operations: use the page's own buttons and inputs, then verify the resulting page state (success message, updated list, URL change).
- Do not call a site's private or semi-private HTTP APIs directly, even from the same-origin page context, unless the user explicitly asks for API-based execution or the UI path is unavailable and the tradeoff is explained first.
- Destructive or externally visible actions (delete/send/pay/post): return a preview plan first; execute only after explicit user confirmation or `input.confirm === true` when the user already approved.
- Pause and ask the user on login, captcha, payment walls, or permission problems; leave that tab open for handoff (see Tab policy).

## Notes

- Legacy `.web-cap/*.js` scripts target the old in-page runtime (`document`/`location` globals, `cap.goto` re-run semantics). See the porting table in `references/script-authoring.md`.
- bcap has no page-userscript concept: every script runs explicitly, nothing is auto-injected on page load.
- Install/update into Codex skills: `bash install.sh` (add `--symlink` to link instead of copy).
