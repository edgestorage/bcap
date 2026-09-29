#!/usr/bin/env node
/**
 * bcap — browser capability CLI for the local Chromium.
 *
 * Talks to the TaskHandoff-managed Chromium over CDP. Provides reusable
 * script execution (Playwright API in Node), one-off in-page scripts, raw
 * CDP calls, tab management, screenshots and page reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_API = process.env.BCAP_API || 'http://127.0.0.1:8080';
const DEFAULT_CDP_CANDIDATES = [process.env.BCAP_CDP || 'http://127.0.0.1:9201'];
const TAB_LIMIT = 20;
const VALUE_FLAGS = new Set(['cdp', 'api', 'session', 'tab', 'url', 'input', 'input-file', 'params', 'nav', 'script', 'script-file', 'limit']);
const OPTIONAL_VALUE_FLAGS = new Set(['new']);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq !== -1) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--') && (VALUE_FLAGS.has(name) || OPTIONAL_VALUE_FLAGS.has(name))) {
      flags[name] = next;
      i += 1;
    } else if (OPTIONAL_VALUE_FLAGS.has(name)) {
      flags[name] = true;
    } else {
      flags[name] = true;
    }
  }
  return { flags, positional };
}

function print(value) {
  const json = JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? item.toString() : item), 2);
  process.stdout.write((json === undefined ? 'null' : json) + '\n');
}

function fail(message) {
  print({ ok: false, error: String(message) });
  process.exitCode = 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    throw new Error(`playwright-core is not installed. Run: cd ${SKILL_ROOT} && npm install`);
  }
}

const normalizeEndpoint = (value) => String(value).replace(/\/+$/, '');

async function httpJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status} for ${url}`);
  return body;
}

async function probeCdp(endpoint) {
  try {
    const response = await fetch(`${normalizeEndpoint(endpoint)}/json/version`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function listManagedChromiums(api) {
  const state = await httpJson(`${api}/api/apps/sessions/state`);
  const sessions = (state?.data?.snapshot?.sessions ?? []).filter((item) => item.appId === 'chromium' && item.status === 'running');
  const result = [];
  for (const session of sessions) {
    let endpoint = session.automation?.endpoint ? normalizeEndpoint(session.automation.endpoint) : null;
    if (!endpoint) {
      const automation = await httpJson(`${api}/api/apps/sessions/${session.id}/automation`).catch(() => null);
      const raw = automation?.data?.endpoint || (automation?.data?.port ? `http://127.0.0.1:${automation.data.port}` : null);
      endpoint = raw ? normalizeEndpoint(raw) : null;
    }
    if (endpoint) result.push({ sessionId: session.id, endpoint, createdAt: String(session.createdAt ?? '') });
  }
  return result.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

async function resolveEndpoint(flags) {
  const api = flags.api ? String(flags.api) : DEFAULT_API;
  if (flags.cdp) return normalizeEndpoint(flags.cdp);
  const sessions = await listManagedChromiums(api).catch(() => []);
  if (flags.session) {
    const wanted = String(flags.session);
    const hit = sessions.find((item) => item.sessionId === wanted);
    if (!hit) throw new Error(`No running browser session with id ${wanted}. Run "status" to list sessions.`);
    return hit.endpoint;
  }
  if (process.env.BCAP_CDP) return normalizeEndpoint(process.env.BCAP_CDP);
  if (sessions.length && (await probeCdp(sessions[0].endpoint))) return sessions[0].endpoint;
  for (const candidate of DEFAULT_CDP_CANDIDATES) {
    if (candidate && (await probeCdp(candidate))) return normalizeEndpoint(candidate);
  }
  throw new Error('No running browser CDP endpoint found. Start it with: node scripts/bcap.mjs launch');
}

async function connect(endpoint) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error(`No default browser context available at ${endpoint}`);
  }
  return { browser, context };
}

async function targetIdOf(context, page) {
  try {
    const session = await context.newCDPSession(page);
    try {
      const { targetInfo } = await session.send('Target.getTargetInfo');
      return targetInfo.targetId;
    } finally {
      await session.detach().catch(() => {});
    }
  } catch {
    return '';
  }
}

async function listPages(context) {
  const pages = context.pages();
  const items = [];
  for (const page of pages) {
    items.push({ page, targetId: await targetIdOf(context, page), url: page.url(), title: await page.title().catch(() => '') });
  }
  return items;
}

async function selectPage(context, flags) {
  if (flags.new !== undefined) {
    if (context.pages().length >= TAB_LIMIT) throw new Error(`Tab limit reached (${TAB_LIMIT}). Close unused tabs first (list / close).`);
    const page = await context.newPage();
    const url = typeof flags.new === 'string' ? flags.new : '';
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    return page;
  }
  const items = await listPages(context);
  if (flags.tab) {
    const hit = items.find((item) => item.targetId === String(flags.tab));
    if (!hit) throw new Error(`No tab with targetId ${flags.tab}. Run "list" to see open tabs.`);
    return hit.page;
  }
  if (flags.url) {
    const needle = String(flags.url);
    const hit = items.find((item) => item.url.includes(needle));
    if (!hit) throw new Error(`No tab whose URL contains "${needle}". Run "list" to see open tabs.`);
    return hit.page;
  }
  if (!items.length) return context.newPage();
  return items[0].page;
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function readInput(flags) {
  if (flags['input-file']) {
    const ref = String(flags['input-file']);
    const text = ref === '-' ? readStdin() : fs.readFileSync(path.resolve(process.cwd(), ref), 'utf8');
    return JSON.parse(text);
  }
  if (flags.input !== undefined) {
    if (flags.input === true) throw new Error('--input needs a JSON value, e.g. --input \'{"limit":10}\'');
    return JSON.parse(String(flags.input));
  }
  return {};
}

async function cmdStatus(flags) {
  const api = flags.api ? String(flags.api) : DEFAULT_API;
  const sessions = await listManagedChromiums(api).catch(() => []);
  let endpoint = null;
  let selectedSessionId = null;
  if (flags.cdp) {
    endpoint = normalizeEndpoint(flags.cdp);
  } else if (flags.session) {
    const hit = sessions.find((item) => item.sessionId === String(flags.session));
    if (!hit) throw new Error(`No running browser session with id ${flags.session}.`);
    endpoint = hit.endpoint;
    selectedSessionId = hit.sessionId;
  } else if (process.env.BCAP_CDP) {
    endpoint = normalizeEndpoint(process.env.BCAP_CDP);
  } else if (sessions.length) {
    endpoint = sessions[0].endpoint;
    selectedSessionId = sessions[0].sessionId;
  } else {
    for (const candidate of DEFAULT_CDP_CANDIDATES) {
      if (candidate && (await probeCdp(candidate))) { endpoint = normalizeEndpoint(candidate); break; }
    }
  }
  if (!endpoint || !(await probeCdp(endpoint))) {
    throw new Error('Browser is not running. Start it with: node scripts/bcap.mjs launch');
  }
  const version = await httpJson(`${endpoint}/json/version`);
  const tabs = (await httpJson(`${endpoint}/json/list`))
    .filter((item) => item.type === 'page')
    .map((item) => ({ id: item.id, title: item.title, url: item.url }));
  print({
    ok: true,
    endpoint,
    sessionId: selectedSessionId,
    sessions: sessions.map((item) => ({ sessionId: item.sessionId, endpoint: item.endpoint, default: item.sessionId === selectedSessionId })),
    browser: version.Browser,
    tabCount: tabs.length,
    tabs
  });
}

async function cmdLaunch(flags) {
  const api = flags.api ? String(flags.api) : DEFAULT_API;
  let session = flags['new-session'] ? null : ((await listManagedChromiums(api).catch(() => []))[0] ?? null);
  if (!session) {
    const response = await fetch(`${api}/api/apps/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: 'chromium' }),
      signal: AbortSignal.timeout(30000)
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error?.message || `launch failed (HTTP ${response.status})`);
    const automation = body?.data?.automation ?? {};
    const endpoint = automation.endpoint || (automation.port ? `http://127.0.0.1:${automation.port}` : null);
    if (!endpoint) throw new Error('launch succeeded but no CDP endpoint was returned');
    session = { sessionId: body.data.id, endpoint: normalizeEndpoint(endpoint) };
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await probeCdp(session.endpoint)) break;
    await sleep(500);
  }
  if (!(await probeCdp(session.endpoint))) throw new Error(`CDP endpoint ${session.endpoint} did not become ready`);
  const version = await httpJson(`${session.endpoint}/json/version`);
  print({ ok: true, sessionId: session.sessionId, endpoint: session.endpoint, browser: version.Browser });
}

async function cmdStop(flags, positional) {
  const sessionId = positional[0] ?? (flags.session ? String(flags.session) : null);
  if (!sessionId) throw new Error('usage: bcap stop <sessionId> (or --session <id>)');
  const api = flags.api ? String(flags.api) : DEFAULT_API;
  const response = await fetch(`${api}/api/apps/sessions/${sessionId}/stop`, { method: 'POST', signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `stop failed (HTTP ${response.status})`);
  print({ ok: true, sessionId, status: body?.data?.status ?? 'stopping' });
}

async function cmdList(flags) {
  const endpoint = await resolveEndpoint(flags);
  const tabs = (await httpJson(`${endpoint}/json/list`))
    .filter((item) => item.type === 'page')
    .map((item) => ({ id: item.id, title: item.title, url: item.url }));
  print({ ok: true, endpoint, tabCount: tabs.length, tabs });
}

async function withBrowser(flags, handler) {
  const endpoint = await resolveEndpoint(flags);
  const { browser, context } = await connect(endpoint);
  try {
    return await handler({ browser, context, endpoint });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function cmdRun(flags, positional) {
  let file = positional[0] ?? null;
  let stdinSource = null;
  if (!file && flags['script-file'] !== undefined) {
    if (flags['script-file'] === true) throw new Error('--script-file needs a path or "-"');
    const ref = String(flags['script-file']);
    if (ref === '-') stdinSource = readStdin();
    else file = ref;
  }
  if (!file && stdinSource === null) throw new Error("usage: bcap run <script-file> [--input JSON] [--tab id | --url substr | --new [url]] [--nav url]");
  if (stdinSource !== null && flags['input-file'] === '-') throw new Error('stdin can only be consumed once; do not combine --script-file - with --input-file -');
  const abs = file ? path.resolve(process.cwd(), file) : null;
  if (abs && !fs.existsSync(abs)) throw new Error(`script file not found: ${abs}`);
  const input = readInput(flags);
  await withBrowser(flags, async ({ browser, context }) => {
    const page = await selectPage(context, flags);
    if (flags.nav) await page.goto(String(flags.nav), { waitUntil: 'domcontentloaded' });
    const cdp = await context.newCDPSession(page);
    const cap = {
      page,
      context,
      browser,
      cdp,
      async goto(url, options = {}) {
        await page.goto(url, { waitUntil: options.waitUntil ?? 'domcontentloaded' });
        return { ok: true, url: page.url(), title: await page.title() };
      },
      sleep
    };
    globalThis.page = page;
    globalThis.context = context;
    globalThis.browser = browser;
    globalThis.cdp = cdp;
    globalThis.cap = cap;
    globalThis.input = input;
    try {
      const moduleUrl = stdinSource !== null
        ? `data:text/javascript;base64,${Buffer.from(stdinSource).toString('base64')}`
        : `${pathToFileURL(abs).href}?t=${Date.now()}`;
      const module = await import(moduleUrl);
      const fn = module.default ?? module.run;
      if (typeof fn !== 'function') throw new Error('script must export default async function (input) {...}');
      const result = await fn(input);
      print(result === undefined ? null : result);
    } finally {
      await cdp.detach().catch(() => {});
    }
  });
}

function buildPageExpression(source, input) {
  const trimmed = source.trim();
  const inputJson = JSON.stringify(input ?? {});
  const match = trimmed.match(/^export\s+default\s+/);
  if (match) {
    const rest = trimmed.slice(match[0].length).trim().replace(/;\s*$/, '');
    return `(${rest})(${inputJson})`;
  }
  return `(async () => { ${source} })()`;
}

async function cmdExec(flags) {
  let source = null;
  if (flags['script-file'] !== undefined) {
    if (flags['script-file'] === true) throw new Error('--script-file needs a path or "-"');
    const ref = String(flags['script-file']);
    source = ref === '-' ? readStdin() : fs.readFileSync(path.resolve(process.cwd(), ref), 'utf8');
    if (ref === '-' && flags['input-file'] === '-') throw new Error('stdin can only be consumed once; do not combine --script-file - with --input-file -');
  } else if (flags.script !== undefined && flags.script !== true) {
    source = String(flags.script);
  }
  if (source === null) throw new Error('usage: bcap exec --script "<js>" | --script-file <file|->');
  const input = readInput(flags);
  await withBrowser(flags, async ({ context }) => {
    const page = await selectPage(context, flags);
    if (flags.nav) await page.goto(String(flags.nav), { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(buildPageExpression(source, input));
    print(result === undefined ? null : result);
  });
}

async function cmdEval(flags, positional) {
  const expression = positional.join(' ').trim();
  if (!expression) throw new Error('usage: bcap eval "<expression>"');
  await withBrowser(flags, async ({ context }) => {
    const page = await selectPage(context, flags);
    const result = await page.evaluate(expression);
    print(result === undefined ? null : result);
  });
}

async function cmdNav(flags, positional) {
  const url = positional[0];
  if (!url) throw new Error('usage: bcap nav <url> [--url substr | --tab id | --new]');
  await withBrowser(flags, async ({ context }) => {
    const page = await selectPage(context, flags);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    print({ ok: true, targetId: await targetIdOf(context, page), url: page.url(), title: await page.title() });
  });
}

async function cmdNew(flags, positional) {
  const url = positional[0] ?? (typeof flags.new === 'string' ? flags.new : '');
  flags.new = url || true;
  await withBrowser(flags, async ({ context }) => {
    const page = await selectPage(context, flags);
    print({ ok: true, targetId: await targetIdOf(context, page), url: page.url(), title: await page.title() });
  });
}

async function cmdClose(flags, positional) {
  const targetId = positional[0] ?? (flags.tab ? String(flags.tab) : null);
  if (!targetId) throw new Error('usage: bcap close <targetId>');
  const endpoint = await resolveEndpoint(flags);
  const response = await fetch(`${endpoint}/json/close/${targetId}`, { signal: AbortSignal.timeout(10000) });
  const body = await response.text().catch(() => '');
  if (!response.ok) throw new Error(`close failed: ${body || response.status}`);
  print({ ok: true, targetId, result: body.trim() });
}

async function cmdShot(flags, positional) {
  const outPath = path.resolve(process.cwd(), positional[0] ?? `bcap-shot-${Date.now()}.png`);
  await withBrowser(flags, async ({ context }) => {
    const page = await selectPage(context, flags);
    await page.screenshot({ path: outPath, fullPage: Boolean(flags.full) });
    print({ ok: true, path: outPath, url: page.url(), title: await page.title() });
  });
}

async function cmdText(flags) {
  const limit = Number(flags.limit ?? 20000);
  await withBrowser(flags, async ({ context }) => {
    const page = await selectPage(context, flags);
    const text = await page.evaluate((max) => (document.body ? document.body.innerText.replace(/[ \t]+\n/g, '\n').slice(0, max) : ''), limit);
    print({ ok: true, url: page.url(), title: await page.title(), text });
  });
}

async function cmdCdp(flags, positional) {
  const method = positional[0];
  if (!method) throw new Error('usage: bcap cdp <Domain.method> [--params JSON] [--browser] [--tab id | --url substr]');
  const params = flags.params && flags.params !== true ? JSON.parse(String(flags.params)) : {};
  await withBrowser(flags, async ({ browser, context }) => {
    const session = flags.browser ? await browser.newBrowserCDPSession() : await context.newCDPSession(await selectPage(context, flags));
    try {
      const result = await session.send(method, params);
      print(result === undefined ? null : result);
    } finally {
      await session.detach().catch(() => {});
    }
  });
}

function usage() {
  process.stdout.write(`bcap — local browser capability (Playwright + CDP)

Usage: node scripts/bcap.mjs <command> [options]

Commands:
  status                 Show browser sessions, CDP endpoints and open tabs
  launch                 Ensure a managed Chromium is running (--new-session to start another)
  stop <sessionId>       Stop a managed browser session
  list                   List open page tabs
  run <script.js>        Run a reusable Node script (globals: page, context, browser, cdp, cap, input)
                         --script-file <path|-> also works; "-" reads the script from stdin
  exec --script "<js>"   Run a one-off in-page DOM script (or --script-file <file|->)
  eval "<expression>"    Evaluate one expression in the page and print the result
  nav <url>              Navigate the selected tab
  new [url]              Open a new tab
  close <targetId>       Close a tab
  shot <file.png>        Screenshot the selected tab (--full for full page)
  text                   Read visible text of the selected tab (--limit N)
  cdp <Domain.method>    Raw CDP call (--params JSON, --browser for browser-level)

Tab selection (for page commands):
  --url <substr>   Use the tab whose URL contains <substr>
  --tab <id>       Use the tab with this targetId (see list)
  --new [url]      Open and use a new tab
  --nav <url>      Navigate the selected tab before running

Common options:
  --session <id>   Target a specific managed browser session (see status; default: first running)
  --input JSON     Input object passed to the script (run/exec)
  --input-file F   Read input JSON from a file ("-" reads stdin; cannot be combined with --script-file -)
  --cdp URL        Override the CDP endpoint (default: auto-discover, e.g. http://127.0.0.1:9201)
  --api URL        TaskHandoff API base (default: ${DEFAULT_API})
`);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional.shift();
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      usage();
      return;
    case 'status': await cmdStatus(flags); return;
    case 'launch': await cmdLaunch(flags); return;
    case 'stop': await cmdStop(flags, positional); return;
    case 'list': await cmdList(flags); return;
    case 'run': await cmdRun(flags, positional); return;
    case 'exec': await cmdExec(flags); return;
    case 'eval': await cmdEval(flags, positional); return;
    case 'nav': await cmdNav(flags, positional); return;
    case 'new': await cmdNew(flags, positional); return;
    case 'close': await cmdClose(flags, positional); return;
    case 'shot': await cmdShot(flags, positional); return;
    case 'text': await cmdText(flags); return;
    case 'cdp': await cmdCdp(flags, positional); return;
    default:
      usage();
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((error) => fail(error?.message || error));
