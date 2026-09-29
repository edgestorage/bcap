---
name: bcap
description: Operate the local Chromium browser through Playwright and raw CDP - check or launch the browser, run reusable Node browser scripts, read/click/type on pages, extract data, take screenshots. Use for browser automation, web data extraction, site workflows, or any task needing a real browser tab.
---

# bcap — local browser capability

Self-contained skill folder: `SKILL.md` + `scripts/bcap.mjs` (Node CLI, Playwright + raw CDP) + `sites/` (reusable per-site scripts). The CLI drives the TaskHandoff-managed Chromium; the CDP endpoint is auto-discovered (usually `http://127.0.0.1:9201`) and the VNC view is visible in the instance UI.

All commands run from the skill folder:

```bash
cd /workspace/bcap
node scripts/bcap.mjs <command>
```

## Quick start

```bash
node scripts/bcap.mjs status          # endpoint, browser version, open tabs
node scripts/bcap.mjs launch          # start the managed Chromium if not running
node scripts/bcap.mjs list
node scripts/bcap.mjs text --url nodeseek.com
```

## Reuse pattern (core capability)

Write a script once under `sites/<domain>/<action>.js`, run it many times with different `--input`:

- ESM file exporting `export default async function (input) { ... }`.
- Node-side globals inside the script: `page` (Playwright Page), `context`, `browser`, `cdp` (page CDP session), `cap` (`{ page, context, browser, cdp, goto, sleep }`), `input`.
- Return structured JSON; include `ok`, `url`, `title`; expose variable behavior through `input` with sane limits so the same script serves many cases.
- Keep site scripts in `sites/<domain>/` so the library accumulates.

```bash
node scripts/bcap.mjs run sites/examples/read-page-summary.js --new https://example.com --input '{"linkLimit":5}'
node scripts/bcap.mjs run sites/examples/cdp-performance-metrics.js --url example.com
```

Tab selection for page commands: `--url <substr>` (reuse matching tab), `--tab <targetId>`, `--new [url]`, `--nav <url>` (navigate before acting).

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

`exec` runs DOM code inside the page (no Playwright API): a body with `return {...}`, or `export default async function (input) {...}`. `eval` evaluates a single expression.

```bash
node scripts/bcap.mjs exec --script "return { title: document.title, url: location.href }"
node scripts/bcap.mjs eval "document.title"
```

## Safety and hygiene

- Destructive or externally visible actions (post/delete/send/pay): return a preview plan first, execute only after explicit user confirmation or `input.confirm === true` when the user already approved.
- Keep at most 20 browser tabs (workspace rule); close temporary tabs you opened once their data is extracted: `node scripts/bcap.mjs close <targetId>`.
- Pause and ask the user on login, captcha, payment walls, or permission problems.
- Prefer the page's own UI over private/semi-private site APIs unless the user asks for API-level execution.

## Notes

- Legacy `.web-cap/*.js` scripts target the old web-cap in-page runtime (`document`/`location` globals, `cap.goto` re-run). To reuse one with bcap, port it to Node style: `await cap.goto(url)` then continue with `page.*`.
- Install into Codex skills: `bash install.sh` (updates the installed copy). Use `bash install.sh --symlink` to link instead of copy.
