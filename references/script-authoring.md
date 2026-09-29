# Writing reusable bcap scripts

Scripts are the core of bcap: explore a page once with `exec`/`eval`, codify what works into a script file, then reuse it many times with different `--input`. Aim for a small library under `sites/<domain>/` that grows with every task.

**Read this file before writing any file under `sites/`.**

## Where scripts live

- Library root: `sites/` in this skill folder.
- Script path: `sites/<domain>/<capability-name>.js`.
- `<domain>` is the site's primary registrable domain, without protocol, path, query or fragment: `github.com`, `example.com`, `docs.openai.com`.
- `<capability-name>` names the workflow in lowercase action/object form: `read-page-summary.js`, `extract-issue-list.js`, `create-pr-comment.js`.
- Domain documentation: `sites/<domain>/README.md` (format below).
- Before writing a new script, list `sites/<domain>/` and read its README — reuse beats rewrite.

### Domain README format

Maintain one `README.md` per domain directory:

```markdown
# <domain> bcap Scripts

## Description

<Short description of this domain's reusable scripts.>

## Scripts

### <capability-name>.js

- Description: <what it does>
- Pages: <URL patterns or page types>
- Input: <input fields or none>
- Output: <important result fields>
- State: <required login/page state, or none>
```

## Contract

- File: ESM module exporting `export default async function (input) { ... }` (a named `run` export also works).
- Input: JSON object from `--input '<json>'` or `--input-file <path|->`; defaults to `{}`.
- Globals available at call time:
  - `page` — Playwright `Page` (locators, clicks, typing, evaluate, waits, screenshots)
  - `context` / `browser` — Playwright `BrowserContext` / `Browser`
  - `cdp` — CDP session attached to the target page (`await cdp.send('Domain.method', params)`)
  - `cap` — convenience helper `{ page, context, browser, cdp, goto(url, opts), sleep(ms) }`
  - `input` — same object as the function argument
- Output: the returned value is printed as JSON to stdout. Return a structured object; do not `console.log` — stdout is the result.

## Handle header

Every saved script starts with a JSDoc-style metadata block:

```js
/**
 * bcap script
 *
 * @description Read a compact summary of the current page.
 * @param {object} input
 * @param {number} [input.limit=20] Optional maximum number of items to return.
 * @returns {{ok: boolean, url: string, title: string, items: Array<object>}}
 * @match https://example.com/articles/:articleId, https://example.com/docs/*
 */
export default async function (input) {
  return { ok: true, url: page.url(), title: await page.title() };
}
```


Header requirements:

- JSDoc syntax (`/** ... */`); first content line identifies the file as a `bcap script`.
- `@description` — the reusable capability or workflow.
- `@param` — the input object and its important fields (defaults included).
- `@returns` — when the structured result needs explanation.
- `@match` — where the script can run, using full URL patterns with origin and path:
  - `:name` for variable path segments (`https://github.com/:owner/:repo/issues`),
  - `*` as a broad wildcard (`https://docs.example.com/*`),
  - comma-separate multiple patterns,
  - add page-state notes in words when a URL alone is not enough (login required, tab selected, results loaded).

## Output conventions

- Always include `ok` (boolean), `url` (`page.url()`), and `title` (`await page.title()`) unless there is a good reason not to.
- Return objects, not loose arrays or strings: `{ ok, url, title, items: [...] }` keeps results self-describing.
- On expected failures return `{ ok: false, error: 'message', url, title }`; throw only for programming errors.
- Normalize page text before returning: collapse whitespace, trim, and cap length so results stay readable.
- Make truncation visible: return counts (`itemCount`) or flags (`truncated: true`) when `input.limit` cut the data.

## Authoring checklist

- Drive variation through `input` with sane defaults and clamps (`Math.min(Math.max(limit, 1), 100)`); never hardcode one-off values in the file.
- Wait for events, not time: `waitForLoadState`, `waitForSelector`, `locator.waitFor()`; expose timing in the result when it affects reliability.
- Filter hidden elements (computed style + bounding box) before extracting text/links.
- Handle pagination explicitly; when you stop early, say so in the result (`pagesRead`, `truncated: true`).
- Keep results stable for diffs: trim empty values, sort where order is not meaningful.
- State-changing actions: drive the page's own UI, verify the resulting state after acting, and do not call private/semi-private site APIs unless the user asks or the UI path is unavailable and the tradeoff is explained.
- For destructive or externally visible actions, return a preview plan first (`{ ok: true, preview: [...], needsConfirm: true }`); execute only when `input.confirm === true` or the user explicitly approved.

## Examples

### Read a page (file-based)

`sites/examples/read-page-summary.js` returns title/URL/headings/links/text with `headingLimit`, `linkLimit`, `textLimit`.

```bash
node scripts/bcap.mjs run sites/examples/read-page-summary.js --new https://example.com --input '{"linkLimit":5}'
```

### Form interaction

```js
export default async function (input) {
  await page.locator('input[name="q"]').fill(input.query);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.waitForURL(/search/); // verify the action took effect
  return { ok: true, url: page.url(), title: await page.title() };
}
```

### Repeated item extraction

```js
export default async function (input) {
  const cards = page.locator(input.cardSelector ?? '.card');
  const limit = input.limit ?? 20;
  const items = [];
  for (let index = 0; index < Math.min(await cards.count(), limit); index += 1) {
    const card = cards.nth(index);
    items.push({
      title: ((await card.locator('h2, h3').first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim(),
      href: await card.locator('a').first().getAttribute('href').catch(() => '')
    });
  }
  return { ok: true, url: page.url(), title: await page.title(), itemCount: items.length, items };
}
```

### Raw CDP

`sites/examples/cdp-performance-metrics.js` uses `cdp.send('Performance.enable')` / `Performance.getMetrics`. For browser-level calls: `await (await browser.newBrowserCDPSession()).send('Browser.getVersion')`.

### Destructive action with preview

```js
export default async function (input) {
  const plan = { action: 'delete', target: input.id, url: page.url() };
  if (input.confirm !== true) return { ok: true, preview: plan, needsConfirm: true };
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Confirm' }).click();
  return { ok: true, url: page.url(), title: await page.title(), deleted: input.id };
}
```

## Multi-page workflows

web-cap scripts must re-enter themselves after navigation (`cap.goto(url, nextInput)` navigation continuation), because the in-page execution context is destroyed on page load. bcap scripts run in Node, so they simply navigate in place and continue linearly — the `step`-machine pattern becomes ordinary `await` calls:

```js
/**
 * bcap script
 *
 * @description Search a site, open the first result, and read the detail page.
 * @param {object} input
 * @param {string} input.query Search query.
 * @match https://example.com/*
 */
export default async function (input) {
  await page.locator('input[name="q"]').fill(input.query);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.waitForURL(/search/);

  const href = await page.locator('a.result').first().getAttribute('href');
  if (!href) return { ok: false, error: 'No result link found.', url: page.url(), title: await page.title() };

  await cap.goto(href);
  return { ok: true, query: input.query, href, url: page.url(), title: await page.title() };
}
```

If you do want explicit steps (resumable scripts, or driving by `input.step`), keep it as plain branching — same shape as the web-cap step machine, no re-run machinery needed.

## Porting legacy `.web-cap` scripts

| web-cap (in-page runtime) | bcap (Node) |
| --- | --- |
| Scripts run inside the page: `document`, `location`, `window` are directly available | Scripts run in Node: use `page.evaluate(() => ...)`, `await page.title()`, `await page.url()` |
| `page.locator(...)` executes inside the page | Same Playwright API, called from Node — keep the `await`s |
| `return cap.goto(url, { ...input, ready: true })` navigates and re-runs the script | `await cap.goto(url)` then continue in the same function |
| `input` argument | Same |
| Page userscripts (auto-injected on page load) | Not supported — bcap runs everything explicitly |

## Reuse workflow

1. Explore: use `bcap exec` / `eval` for quick reads of the live page.
2. Check: look in `sites/<domain>/` and its README for an existing script first.
3. Codify: write `sites/<domain>/<capability-name>.js` with the header and conventions above.
4. Run: `bcap run sites/<domain>/<capability-name>.js --input '{...}'` (target the right tab/browser with `--url`, `--tab`, `--session`).
5. Iterate: fix selectors/waits and re-run until stable.
6. Keep and document: leave the script in `sites/` and update the domain README — it is the reusable library.
