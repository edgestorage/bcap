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
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const HISTORY_FILE = path.join(SKILL_ROOT, '.state', 'history.jsonl');
const HISTORY_MAX_BYTES = 2_000_000;
const HISTORY_KEEP_LINES = 500;

const VALUE_FLAGS = new Set(['cdp', 'api', 'session', 'tab', 'url', 'input', 'input-file', 'params', 'nav', 'script', 'script-file', 'limit', 'timeout', 'until-selector', 'until-text', 'until-url', 'poll', 'domain', 'match', 'selector', 'delay', 'format', 'evidence-limit']);
const OPTIONAL_VALUE_FLAGS = new Set(['new', 'evidence']);

let forceExit = false;

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

let outputFormat = (process.env.BCAP_FORMAT || '').toLowerCase() === 'pretty' ? 'pretty' : 'compact';

function print(value) {
  const indent = outputFormat === 'pretty' ? 2 : undefined;
  const json = JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? item.toString() : item), indent);
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

async function resolveTarget(flags) {
  const api = flags.api ? String(flags.api) : DEFAULT_API;
  if (flags.cdp) return { endpoint: normalizeEndpoint(flags.cdp), sessionId: null };
  const sessions = await listManagedChromiums(api).catch(() => []);
  if (flags.session) {
    const wanted = String(flags.session);
    const hit = sessions.find((item) => item.sessionId === wanted);
    if (!hit) throw new Error(`No running browser session with id ${wanted}. Run "status" to list sessions.`);
    return { endpoint: hit.endpoint, sessionId: hit.sessionId };
  }
  if (process.env.BCAP_CDP) return { endpoint: normalizeEndpoint(process.env.BCAP_CDP), sessionId: null };
  if (sessions.length && (await probeCdp(sessions[0].endpoint))) return { endpoint: sessions[0].endpoint, sessionId: sessions[0].sessionId };
  for (const candidate of DEFAULT_CDP_CANDIDATES) {
    if (candidate && (await probeCdp(candidate))) return { endpoint: normalizeEndpoint(candidate), sessionId: null };
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

async function safeTitle(page) {
  return withTimeout(page.title(), 2000, 'title').catch(() => '');
}

function mergeEvidence(result, evidence) {
  const value = result === undefined ? null : result;
  if (evidence === null) return value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ...value, evidence };
  return { result: value, evidence };
}

function parseTimeout(flags, fallback = DEFAULT_TIMEOUT_MS) {
  if (flags.timeout === undefined) return fallback;
  const ms = Number(flags.timeout);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('--timeout must be a positive number of milliseconds');
  return Math.min(ms, MAX_TIMEOUT_MS);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseEvidenceOptions(flags) {
  if (flags.evidence === undefined) return [];
  const raw = flags.evidence === true ? 'all' : String(flags.evidence);
  const picked = new Set();
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (!value) continue;
    if (value === 'all' || value === 'common') { picked.add('events'); picked.add('dom'); }
    else if (value === 'events') picked.add('events');
    else if (value === 'dom' || value === 'visibleElements') picked.add('dom');
    else throw new Error(`unknown --evidence option "${value}" (use events, dom, common or all)`);
  }
  return [...picked];
}

function parseEvidenceLimit(flags) {
  if (flags['evidence-limit'] === undefined) return 100;
  const raw = String(flags['evidence-limit']).toLowerCase();
  if (raw === 'all') return Infinity;
  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit < 0) throw new Error("--evidence-limit must be a non-negative number or 'all'");
  return limit;
}

function applyEvidenceLimit(dom, limit) {
  const result = { ...dom, counts: { added: dom.added.length, removed: dom.removed.length, updated: dom.updated.length } };
  if (limit === Infinity) return result;
  const omitted = {};
  if (dom.added.length > limit) { result.added = dom.added.slice(0, limit); omitted.added = dom.added.length - limit; }
  if (dom.removed.length > limit) { result.removed = dom.removed.slice(0, limit); omitted.removed = dom.removed.length - limit; }
  if (dom.updated.length > limit) { result.updated = dom.updated.slice(0, limit); omitted.updated = dom.updated.length - limit; }
  if (Object.keys(omitted).length) result.omitted = omitted;
  return result;
}

// Injected into the page by startEvidence(); mirrors the web-cap visible-elements
// tracker: capped items, route-index keys, change-scoped rescans, noise filtering.
function installEvidenceTracker() {
  const MAX_ITEMS = 300;
  const MAX_TEXT = 80;
  const ROOT_IDS = new Set(['app', 'root']);
  const IGNORED_ATTRIBUTES = new Set(['class', 'style']);
  const VISIBILITY_ATTRIBUTES = new Set(['class', 'style', 'hidden', 'open']);
  const OBSERVED_ATTRIBUTES = ['class', 'style', 'hidden', 'open', 'src', 'href', 'value', 'checked', 'selected', 'aria-hidden'];
  const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'textarea', 'select', 'option', 'img', 'video', 'label']);
  const CONTENT_TAGS = new Set(['span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'dt', 'dd', 'figcaption', 'blockquote', 'pre', 'code', 'em', 'strong', 'small', 'time', 'summary', 'article', 'section', 'header', 'footer', 'nav', 'main', 'aside']);
  const root = document.body || document.documentElement;
  if (!root) return;

  let observer = null;
  let records = [];
  let beforeEntries = [];

  const round = (value) => (Number.isFinite(value) ? Math.round(value) : 0);
  const normalizeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  const routeKey = (route) => route.join('.');
  const hasPrefix = (candidate, prefix) => prefix.length <= candidate.length && prefix.every((segment, index) => candidate[index] === segment);

  const isStyleHidden = (element) => {
    const style = getComputedStyle(element);
    return element.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0;
  };
  const ownRect = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
  };
  const mergeRect = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const left = Math.min(a.left, b.left);
    const top = Math.min(a.top, b.top);
    const right = Math.max(a.right, b.right);
    const bottom = Math.max(a.bottom, b.bottom);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };

  const segmentOf = (element) => {
    const tag = element.tagName.toLowerCase();
    if (element.id) return `${tag}#${element.id}`;
    const siblings = element.parentElement ? [...element.parentElement.children].filter((child) => child.tagName === element.tagName) : [];
    const index = siblings.length > 1 ? siblings.indexOf(element) + 1 : 0;
    return index > 0 ? `${tag}:nth-of-type(${index})` : tag;
  };
  const stableKey = (element) => {
    const path = [];
    let current = element;
    for (let depth = 0; current && depth < 5; depth += 1) {
      path.unshift(segmentOf(current));
      current = current.parentElement;
    }
    const extras = [];
    for (const name of ['href', 'src', 'role', 'name', 'type']) {
      const value = element.getAttribute(name);
      if (value) extras.push(`${name}=${value}`);
    }
    return path.join(' > ') + (extras.length ? ` [${extras.join(',')}]` : '');
  };
  const describe = (element, rect) => {
    const item = { key: stableKey(element), tag: element.tagName.toLowerCase() };
    if (element.id) item.id = element.id;
    const text = normalizeText(element.textContent);
    if (text) item.text = text;
    if (rect) item.rect = { x: round(rect.left), y: round(rect.top), w: round(rect.width), h: round(rect.height) };
    return item;
  };

  const isRepresentative = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') return false;
    if (ROOT_IDS.has(element.id || '')) return false;
    return true;
  };
  const isSemantic = (element, resolveRect) => {
    const tag = element.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = element.getAttribute('role') || '';
    if (role === 'button' || role === 'link' || role === 'dialog' || role === 'menuitem') return true;
    if (!normalizeText(element.textContent)) return false;
    if (CONTENT_TAGS.has(tag)) return true;
    return ![...element.children].some((child) => child instanceof HTMLElement && resolveRect(child));
  };

  const collect = (node, baseRoute = []) => {
    const rectByElement = new WeakMap();
    const fallbackRectByElement = new WeakMap();
    const resolveRect = (element) => rectByElement.get(element) ?? fallbackRectByElement.get(element) ?? null;
    const computeRects = (current, ancestorHidden) => {
      if (!(current instanceof HTMLElement)) {
        let merged = null;
        for (const child of current?.childNodes ?? []) merged = mergeRect(merged, computeRects(child, ancestorHidden));
        return merged;
      }
      const hidden = ancestorHidden || isStyleHidden(current);
      if (hidden) return null;
      const rect = ownRect(current);
      if (rect) rectByElement.set(current, rect);
      let subtree = rect;
      for (const child of current.childNodes) subtree = mergeRect(subtree, computeRects(child, hidden));
      if (!rect && subtree) fallbackRectByElement.set(current, subtree);
      return subtree;
    };
    computeRects(node, false);

    const entries = [];
    let truncated = false;
    const visit = (current, route) => {
      if (truncated) return;
      if (current instanceof HTMLElement) {
        const rect = resolveRect(current);
        if (rect && isRepresentative(current) && isSemantic(current, resolveRect)) {
          entries.push({ route, routeKey: routeKey(route), item: describe(current, rect) });
          if (entries.length >= MAX_ITEMS) { truncated = true; return; }
        }
      }
      const children = current?.childNodes ?? [];
      for (let index = 0; index < children.length; index += 1) visit(children[index], route.concat(index));
    };
    visit(node, baseRoute);
    return { entries, truncated };
  };

  const routeFromNode = (node) => {
    let current = node instanceof HTMLElement ? node : node?.parentNode;
    const route = [];
    while (current && current !== root) {
      const parent = current.parentNode;
      if (!parent) return null;
      route.unshift([...parent.childNodes].indexOf(current));
      current = parent;
    }
    return current === root ? route : null;
  };
  const nodeFromRoute = (route) => {
    let current = root;
    for (const index of route) {
      current = current?.childNodes?.[index];
      if (!current) return null;
    }
    return current;
  };
  const addLocalRoute = (routes, route) => {
    if (routes.some((existing) => hasPrefix(route, existing))) return;
    for (let index = routes.length - 1; index >= 0; index -= 1) {
      if (hasPrefix(routes[index], route)) routes.splice(index, 1);
    }
    routes.push(route);
  };
  const normalizedRecords = () => {
    const seen = new Set();
    const out = [];
    for (const record of records) {
      const attributeName = record.attributeName || '';
      if (record.kind === 'attribute' && (IGNORED_ATTRIBUTES.has(attributeName) || attributeName.startsWith('data-'))) continue;
      const marker = `${record.kind}:${routeKey(record.route)}:${attributeName}`;
      if (seen.has(marker)) continue;
      seen.add(marker);
      out.push({ kind: record.kind, route: record.route, attributeName });
    }
    return out;
  };
  const materiallyChanged = (before, after) => (before.text ?? '') !== (after.text ?? '') || before.tag !== after.tag || (before.id ?? '') !== (after.id ?? '') || before.key !== after.key;
  const collapseDescendants = (entries) => entries.filter((entry) =>
    !entries.some((other) => other !== entry && other.route.length < entry.route.length && hasPrefix(entry.route, other.route)));
  const mergeSiblings = (entries) => {
    const groups = new Map();
    for (const entry of entries) {
      const parentKey = routeKey(entry.route.slice(0, -1));
      if (!groups.has(parentKey)) groups.set(parentKey, []);
      groups.get(parentKey).push(entry);
    }
    const merged = [];
    const emitted = new Set();
    for (const entry of entries) {
      const parentKey = routeKey(entry.route.slice(0, -1));
      const group = groups.get(parentKey);
      if (group.length >= 4) {
        if (!emitted.has(parentKey)) {
          emitted.add(parentKey);
          merged.push({
            route: entry.route.slice(0, -1),
            routeKey: parentKey,
            item: { key: `${entry.item.key} > *(${group.length})`, tag: '*', text: `${group.length} sibling items`, mergedCount: group.length }
          });
        }
        continue;
      }
      merged.push(entry);
    }
    return merged;
  };

  const diff = () => {
    const startedAt = performance.now();
    const changes = normalizedRecords();
    const routes = [];
    for (const change of changes) {
      addLocalRoute(routes, change.kind === 'text' ? change.route.slice(0, -1) : change.route);
    }
    const afterEntries = [];
    const seenRoutes = new Set();
    let truncated = false;
    for (const route of routes) {
      const node = nodeFromRoute(route);
      if (!node) continue;
      const local = collect(node, route);
      if (local.truncated) truncated = true;
      for (const entry of local.entries) {
        if (!seenRoutes.has(entry.routeKey)) {
          seenRoutes.add(entry.routeKey);
          afterEntries.push(entry);
        }
      }
    }
    const beforeByKey = new Map(beforeEntries.map((entry) => [entry.routeKey, entry]));
    const afterByKey = new Map(afterEntries.map((entry) => [entry.routeKey, entry]));
    const added = [];
    const removed = [];
    const updated = [];
    for (const entry of afterEntries) {
      const before = beforeByKey.get(entry.routeKey);
      if (!before) added.push(entry);
      else if (materiallyChanged(before.item, entry.item)) updated.push({ before: before.item, after: entry.item });
    }
    for (const entry of beforeEntries) {
      if (!afterByKey.has(entry.routeKey) && routes.some((route) => hasPrefix(entry.route, route))) removed.push(entry);
    }
    const addedFinal = mergeSiblings(collapseDescendants(added));
    const removedFinal = mergeSiblings(collapseDescendants(removed));
    const cap = (items) => {
      if (items.length > MAX_ITEMS) { truncated = true; return items.slice(0, MAX_ITEMS); }
      return items;
    };
    return {
      truncated,
      beforeItems: beforeEntries.length,
      changedRoutes: routes.length,
      added: cap(addedFinal).map((entry) => entry.item),
      removed: cap(removedFinal).map((entry) => entry.item),
      updated: cap(updated),
      diffMs: round(performance.now() - startedAt)
    };
  };

  window.__bcapEvidence = {
    pending() { return records.length; },
    start() {
      const startedAt = performance.now();
      const snapshot = collect(root);
      beforeEntries = snapshot.entries;
      records = [];
      observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            const route = routeFromNode(mutation.target);
            if (route) records.push({ kind: 'structure', route, attributeName: null });
          } else if (mutation.type === 'attributes') {
            const route = routeFromNode(mutation.target);
            if (route) {
              const name = (mutation.attributeName || '').toLowerCase();
              records.push({ kind: VISIBILITY_ATTRIBUTES.has(name) ? 'visibility' : 'attribute', route, attributeName: name });
            }
          } else if (mutation.type === 'characterData') {
            const route = routeFromNode(mutation.target);
            if (route) records.push({ kind: 'text', route, attributeName: null });
          }
        }
      });
      observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true, attributeFilter: OBSERVED_ATTRIBUTES });
      return { items: beforeEntries.length, truncated: snapshot.truncated, snapshotMs: round(performance.now() - startedAt) };
    },
    stop() {
      if (observer) { observer.disconnect(); observer = null; }
      return diff();
    }
  };
}

async function settleMutations(page, quietMs = 150, maxMs = 800) {
  const deadline = Date.now() + maxMs;
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => (window.__bcapEvidence?.pending ? window.__bcapEvidence.pending() : null)).catch(() => null);
    if (count === null) return;
    if (count !== last) { last = count; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= quietMs) return;
    await sleep(50);
  }
}

async function startEvidence(context, page, options, limit = Infinity) {
  if (!options.length) return { stop: async () => null };
  const events = [];
  const startedAt = Date.now();
  const record = (type, extra = {}) => {
    if (events.length < 200) events.push({ atMs: Date.now() - startedAt, type, ...extra });
  };
  const subscriptions = [];
  const subscribe = (emitter, event, handler) => {
    emitter.on(event, handler);
    subscriptions.push([emitter, event, handler]);
  };
  if (options.includes('events')) {
    subscribe(page, 'framenavigated', (frame) => { if (frame === page.mainFrame()) record('navigation', { url: frame.url() }); });
    subscribe(page, 'console', (message) => {
      const type = message.type();
      if (type === 'error' || type === 'warning') record(`console-${type}`, { text: message.text().slice(0, 240) });
    });
    subscribe(page, 'pageerror', (error) => record('page-error', { text: String(error?.message ?? error).slice(0, 240) }));
    subscribe(page, 'dialog', (dialog) => record('dialog', { kind: dialog.type(), text: (dialog.message() || '').slice(0, 200) }));
    subscribe(page, 'download', (download) => record('download', { name: download.suggestedFilename() }));
    subscribe(page, 'requestfailed', (request) => record('request-failed', { url: request.url().slice(0, 200), error: request.failure()?.errorText ?? '' }));
    subscribe(context, 'page', (opened) => record('new-tab', { url: opened.url() }));
  }
  let domBaseline = null;
  if (options.includes('dom')) {
    await page.evaluate(installEvidenceTracker);
    domBaseline = await page.evaluate(() => window.__bcapEvidence.start());
  }
  return {
    async stop() {
      for (const [emitter, event, handler] of subscriptions) emitter.off(event, handler);
      const result = {};
      if (options.includes('events')) result.events = events;
      if (options.includes('dom')) {
        await settleMutations(page);
        const dom = await page.evaluate(() => window.__bcapEvidence.stop()).catch(() => null);
        result.dom = dom && typeof dom === 'object' && !dom.skipped ? applyEvidenceLimit(dom, limit) : (dom ?? { skipped: 'page navigated during execution' });
        if (domBaseline) result.timing = { beforeItems: domBaseline.items, beforeTruncated: domBaseline.truncated ?? false, beforeSnapshotMs: domBaseline.snapshotMs, diffMs: dom?.diffMs ?? null };
      }
      return result;
    }
  };
}

function appendHistory(entry) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(entry)}\n`);
    if (fs.statSync(HISTORY_FILE).size > HISTORY_MAX_BYTES) {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(HISTORY_FILE, `${lines.slice(-HISTORY_KEEP_LINES).join('\n')}\n`);
    }
  } catch {
    // History is best-effort; never fail the command because of it.
  }
}

function collectScriptFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectScriptFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

function parseScriptHeader(source) {
  const block = source.match(/\/\*\*([\s\S]*?)\*\//);
  if (!block) return null;
  const body = block[1];
  const field = (tag) => {
    const match = body.match(new RegExp(`@${tag}\\s+([^\\n]*)`));
    return match ? match[1].trim() : '';
  };
  return {
    kind: body.trim().split('\n')[0].trim(),
    description: field('description'),
    type: field('type'),
    tags: field('tags').split(',').map((value) => value.trim()).filter(Boolean),
    match: field('match').split(',').map((value) => value.trim()).filter(Boolean),
    params: [...body.matchAll(/@param\s+\{[^}]*\}\s+(\S+)/g)].map((match) => match[1].replace(/^\[/, '').replace(/[=\]].*$/, ''))
  };
}

function urlPatternMatches(pattern, url) {
  try {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '[^/]+')
      .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(url);
  } catch {
    return false;
  }
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
  const { endpoint } = await resolveTarget(flags);
  const tabs = (await httpJson(`${endpoint}/json/list`))
    .filter((item) => item.type === 'page')
    .map((item) => ({ id: item.id, title: item.title, url: item.url }));
  print({ ok: true, endpoint, tabCount: tabs.length, tabs });
}

async function withBrowser(flags, handler) {
  const { endpoint, sessionId } = await resolveTarget(flags);
  const { browser, context } = await connect(endpoint);
  try {
    return await handler({ browser, context, endpoint, sessionId });
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
  const timeoutMs = parseTimeout(flags);
  const evidenceOptions = parseEvidenceOptions(flags);
  const evidenceLimit = parseEvidenceLimit(flags);
  const scriptName = stdinSource !== null ? 'stdin' : path.relative(SKILL_ROOT, abs);
  const startedAt = Date.now();
  await withBrowser(flags, async ({ browser, context, endpoint, sessionId }) => {
    const page = await selectPage(context, flags);
    if (flags.nav) await page.goto(String(flags.nav), { waitUntil: 'domcontentloaded' });
    const evidence = await startEvidence(context, page, evidenceOptions, evidenceLimit);
    let result;
    let error = null;
    try {
      const cdp = await context.newCDPSession(page);
      const cap = {
        page,
        context,
        browser,
        cdp,
        async goto(url, options = {}) {
          await page.goto(url, { waitUntil: options.waitUntil ?? 'domcontentloaded' });
          return { ok: true, url: page.url(), title: await safeTitle(page) };
        },
        async click(selector, options = {}) {
          await page.locator(selector).first().click({ timeout: options.timeout ?? DEFAULT_TIMEOUT_MS });
          return { ok: true, selector, url: page.url(), title: await safeTitle(page) };
        },
        async type(selector, text, options = {}) {
          const locator = page.locator(selector).first();
          await locator.click({ timeout: options.timeout ?? DEFAULT_TIMEOUT_MS });
          if (options.clear) await locator.fill('', { timeout: options.timeout ?? DEFAULT_TIMEOUT_MS });
          await page.keyboard.type(String(text), { delay: options.delay ?? 0 });
          return { ok: true, selector, value: await locator.inputValue().catch(() => null), url: page.url(), title: await safeTitle(page) };
        },
        async press(key, options = {}) {
          if (options.selector) await page.locator(options.selector).first().press(key, { timeout: options.timeout ?? DEFAULT_TIMEOUT_MS });
          else await page.keyboard.press(key);
          return { ok: true, key, url: page.url(), title: await safeTitle(page) };
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
        result = await withTimeout(fn(input), timeoutMs, `script ${scriptName}`);
      } finally {
        await withTimeout(cdp.detach(), 3000, 'cdp.detach').catch(() => {});
      }
    } catch (caught) {
      error = caught;
    }
    const evidenceOutput = await evidence.stop().catch(() => null);
    const url = page.url();
    const title = await safeTitle(page);
    let output;
    if (error) {
      const message = String(error?.message ?? error);
      const timedOut = /timed out after/.test(message);
      output = { ok: false, error: message, timedOut, url, title };
      if (evidenceOutput) output.evidence = evidenceOutput;
      process.exitCode = 1;
      if (timedOut) forceExit = true;
    } else {
      output = mergeEvidence(result, evidenceOutput);
    }
    appendHistory({
      command: 'run',
      script: scriptName,
      input,
      ok: !error,
      error: error ? String(error?.message ?? error) : undefined,
      sessionId,
      endpoint,
      url,
      title,
      durationMs: Date.now() - startedAt
    });
    print(output === undefined ? null : output);
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
  let sourceRef = 'inline';
  if (flags['script-file'] !== undefined) {
    if (flags['script-file'] === true) throw new Error('--script-file needs a path or "-"');
    const ref = String(flags['script-file']);
    source = ref === '-' ? readStdin() : fs.readFileSync(path.resolve(process.cwd(), ref), 'utf8');
    sourceRef = ref === '-' ? 'stdin' : ref;
    if (ref === '-' && flags['input-file'] === '-') throw new Error('stdin can only be consumed once; do not combine --script-file - with --input-file -');
  } else if (flags.script !== undefined && flags.script !== true) {
    source = String(flags.script);
  }
  if (source === null) throw new Error('usage: bcap exec --script "<js>" | --script-file <file|->');
  const input = readInput(flags);
  const timeoutMs = parseTimeout(flags);
  const evidenceOptions = parseEvidenceOptions(flags);
  const evidenceLimit = parseEvidenceLimit(flags);
  const startedAt = Date.now();
  await withBrowser(flags, async ({ context, endpoint, sessionId }) => {
    const page = await selectPage(context, flags);
    if (flags.nav) await page.goto(String(flags.nav), { waitUntil: 'domcontentloaded' });
    const evidence = await startEvidence(context, page, evidenceOptions, evidenceLimit);
    let result;
    let error = null;
    try {
      result = await withTimeout(page.evaluate(buildPageExpression(source, input)), timeoutMs, 'exec script');
    } catch (caught) {
      error = caught;
    }
    const evidenceOutput = await evidence.stop().catch(() => null);
    const url = page.url();
    const title = await safeTitle(page);
    let output;
    if (error) {
      const message = String(error?.message ?? error);
      const timedOut = /timed out after/.test(message);
      output = { ok: false, error: message, timedOut, url, title };
      if (evidenceOutput) output.evidence = evidenceOutput;
      process.exitCode = 1;
      if (timedOut) forceExit = true;
    } else {
      output = mergeEvidence(result, evidenceOutput);
    }
    appendHistory({
      command: 'exec',
      script: sourceRef,
      bytes: source.length,
      input,
      ok: !error,
      error: error ? String(error?.message ?? error) : undefined,
      sessionId,
      endpoint,
      url,
      title,
      durationMs: Date.now() - startedAt
    });
    print(output === undefined ? null : output);
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

async function withActionEvidence(context, page, flags, action) {
  const evidence = await startEvidence(context, page, parseEvidenceOptions(flags), parseEvidenceLimit(flags));
  let result;
  let error = null;
  try {
    result = await action();
  } catch (caught) {
    error = caught;
  }
  const evidenceOutput = await evidence.stop().catch(() => null);
  const url = page.url();
  const title = await safeTitle(page);
  if (error) {
    const message = String(error?.message ?? error);
    const output = { ok: false, error: message, url, title };
    if (evidenceOutput) output.evidence = evidenceOutput;
    print(output);
    process.exitCode = 1;
    return;
  }
  print(mergeEvidence(result, evidenceOutput));
}

async function cmdClick(flags, positional) {
  const selector = positional.join(' ').trim();
  if (!selector) throw new Error('usage: bcap click <selector> [--timeout ms] [--evidence sets]');
  const timeoutMs = parseTimeout(flags);
  await withBrowser(flags, async ({ context }) => {
    const page = await selectPage(context, flags);
    await withActionEvidence(context, page, flags, async () => {
      const locator = page.locator(selector).first();
      await locator.click({ timeout: timeoutMs });
      const text = ((await locator.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return { ok: true, selector, clickedText: text, url: page.url(), title: await safeTitle(page) };
    });
  });
}

async function cmdType(flags, positional) {
  if (positional.length < 2) throw new Error('usage: bcap type <selector> <text> [--delay ms] [--clear] [--timeout ms] [--evidence sets]');
  const selector = positional[0];
  const text = positional.slice(1).join(' ');
  const timeoutMs = parseTimeout(flags);
  const delay = flags.delay === undefined ? 0 : Number(flags.delay);
  if (!Number.isFinite(delay) || delay < 0) throw new Error('--delay must be a non-negative number of milliseconds');
  const clear = Boolean(flags.clear);
  await withBrowser(flags, async ({ context }) => {
    const page = await selectPage(context, flags);
    await withActionEvidence(context, page, flags, async () => {
      const locator = page.locator(selector).first();
      await locator.click({ timeout: timeoutMs });
      if (clear) await locator.fill('', { timeout: timeoutMs });
      await page.keyboard.type(text, { delay });
      const value = await locator.inputValue().catch(() => null);
      return { ok: true, selector, typedChars: text.length, value, url: page.url(), title: await safeTitle(page) };
    });
  });
}

async function cmdPress(flags, positional) {
  const key = positional.join(' ').trim();
  if (!key) throw new Error('usage: bcap press <key> [--selector <css>] [--timeout ms] [--evidence sets]');
  const timeoutMs = parseTimeout(flags);
  await withBrowser(flags, async ({ context }) => {
    const page = await selectPage(context, flags);
    await withActionEvidence(context, page, flags, async () => {
      if (flags.selector) await page.locator(String(flags.selector)).first().press(key, { timeout: timeoutMs });
      else await page.keyboard.press(key);
      return { ok: true, key, selector: flags.selector ? String(flags.selector) : null, url: page.url(), title: await safeTitle(page) };
    });
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
  const { endpoint } = await resolveTarget(flags);
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

async function cmdScripts(flags) {
  const sitesDir = path.join(SKILL_ROOT, 'sites');
  const wantsDomain = flags.domain ? String(flags.domain) : null;
  const matchUrl = flags.match ? String(flags.match) : null;
  const scripts = [];
  for (const file of collectScriptFiles(sitesDir).sort()) {
    const relative = path.relative(sitesDir, file);
    const domain = relative.split(path.sep)[0];
    if (wantsDomain && domain !== wantsDomain) continue;
    const header = parseScriptHeader(fs.readFileSync(file, 'utf8')) ?? {};
    const entry = {
      domain,
      file: path.relative(SKILL_ROOT, file),
      description: header.description || '',
      type: header.type || '',
      tags: header.tags ?? [],
      match: header.match ?? [],
      params: header.params ?? []
    };
    if (matchUrl && !entry.match.some((pattern) => urlPatternMatches(pattern, matchUrl))) continue;
    scripts.push(entry);
  }
  print({ ok: true, count: scripts.length, scripts });
}

async function cmdWait(flags) {
  const selector = flags['until-selector'] ? String(flags['until-selector']) : null;
  const text = flags['until-text'] ? String(flags['until-text']) : null;
  const urlPart = flags['until-url'] ? String(flags['until-url']) : null;
  const urlChange = Boolean(flags['url-change']);
  const conditions = [
    selector ? '--until-selector' : null,
    text ? '--until-text' : null,
    urlPart ? '--until-url' : null,
    urlChange ? '--url-change' : null
  ].filter(Boolean);
  if (!conditions.length) {
    throw new Error('usage: bcap wait (--until-selector <css> | --until-text <text> | --until-url <substr> | --url-change) [--timeout ms] [--poll ms]');
  }
  const timeoutMs = parseTimeout(flags, DEFAULT_WAIT_TIMEOUT_MS);
  const pollMs = flags.poll === undefined ? 500 : Number(flags.poll);
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('--poll must be a positive number of milliseconds');
  const startedAt = Date.now();
  await withBrowser(flags, async ({ context }) => {
    const page = await selectPage(context, flags);
    const initialUrl = page.url();
    for (;;) {
      let matched = null;
      if (selector) {
        const element = await page.$(selector).catch(() => null);
        if (element) matched = { on: 'selector', detail: selector };
      }
      if (!matched && text) {
        const found = await page.evaluate((needle) => (document.body ? document.body.innerText.includes(needle) : false), text).catch(() => false);
        if (found) matched = { on: 'text', detail: text };
      }
      if (!matched && urlPart && page.url().includes(urlPart)) matched = { on: 'url', detail: urlPart };
      if (!matched && urlChange && page.url() !== initialUrl) matched = { on: 'url-change', detail: page.url() };
      const elapsedMs = Date.now() - startedAt;
      if (matched) {
        print({ ok: true, matched, elapsedMs, url: page.url(), title: await safeTitle(page), initialUrl });
        return;
      }
      if (elapsedMs >= timeoutMs) {
        print({ ok: false, error: `wait timed out after ${timeoutMs}ms`, timedOut: true, conditions, elapsedMs, url: page.url(), title: await safeTitle(page), initialUrl });
        process.exitCode = 1;
        return;
      }
      await sleep(Math.min(pollMs, Math.max(50, timeoutMs - elapsedMs)));
    }
  });
}

async function cmdHistory(flags) {
  const limit = flags.limit === undefined ? 20 : Number(flags.limit);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('--limit must be a positive number');
  let entries = [];
  if (fs.existsSync(HISTORY_FILE)) {
    entries = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).slice(-limit)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  }
  print({ ok: true, count: entries.length, historyFile: path.relative(SKILL_ROOT, HISTORY_FILE), entries });
}

function usage() {
  process.stdout.write(`bcap — local browser capability (Playwright + CDP)

Usage: node scripts/bcap.mjs <command> [options]

Commands:
  status                 Show browser sessions, CDP endpoints and open tabs
  launch                 Ensure a managed Chromium is running (--new-session to start another)
  stop <sessionId>       Stop a managed browser session
  list                   List open page tabs
  scripts                List reusable scripts under sites/ (--domain D, --match URL)
  run <script.js>        Run a reusable Node script (globals: page, context, browser, cdp, cap, input)
                         --script-file <path|-> also works; "-" reads the script from stdin
  exec --script "<js>"   Run a one-off in-page DOM script (or --script-file <file|->)
  eval "<expression>"    Evaluate one expression in the page and print the result
  click <selector>       Real Playwright click on the selected tab
  type <selector> <text> Real click, then type with real keyboard events (--clear, --delay ms)
  press <key>            Real key press, e.g. Enter/Tab/Control+K (--selector to focus first)
  wait                   Wait for a page condition (see Wait options)
  history                Show recent run/exec executions (--limit N, default 20)
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

Run/exec options:
  --timeout <ms>       Give up after <ms> (default 30000, max 120000)
  --evidence [sets]    Record execution evidence: events, dom, common, all (default all)
  --evidence-limit <n|all>  Max DOM entries per list (default 100; counts and omitted are always exact)

Real input (click/type/press):
  --timeout <ms>       Actionability timeout (default 30000, max 120000)
  --delay <ms>         Keystroke delay for type (default 0)
  --clear              Clear the field before typing
  --selector <css>     Element to focus before press (also supports --url/--tab/--new/--nav)
  --evidence [sets]    Record evidence around the action (events, dom, common, all)

Wait options:
  --until-selector <css>   Wait until a matching element exists
  --until-text <text>      Wait until the page text contains <text>
  --until-url <substr>     Wait until the URL contains <substr>
  --url-change             Wait until the URL differs from its value at start
  --poll <ms>              Poll interval (default 500)
  --timeout <ms>           Overall wait timeout (default 120000, max 120000)

Common options:
  --pretty         Pretty-print JSON (default: compact single-line JSON; env BCAP_FORMAT=pretty)
  --format <fmt>   compact | pretty
  --session <id>   Target a specific managed browser session (see status; default: first running)
  --input JSON     Input object passed to the script (run/exec)
  --input-file F   Read input JSON from a file ("-" reads stdin; cannot be combined with --script-file -)
  --cdp URL        Override the CDP endpoint (default: auto-discover, e.g. http://127.0.0.1:9201)
  --api URL        TaskHandoff API base (default: ${DEFAULT_API})
`);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.pretty) outputFormat = 'pretty';
  if (flags.format !== undefined) {
    const format = String(flags.format);
    if (format !== 'compact' && format !== 'pretty') throw new Error('--format must be "compact" or "pretty"');
    outputFormat = format;
  }
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
    case 'scripts': await cmdScripts(flags); return;
    case 'click': await cmdClick(flags, positional); return;
    case 'type': await cmdType(flags, positional); return;
    case 'press': await cmdPress(flags, positional); return;
    case 'wait': await cmdWait(flags); return;
    case 'history': await cmdHistory(flags); return;
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

main()
  .catch((error) => fail(error?.message || error))
  .finally(() => {
    if (forceExit) process.exit(process.exitCode ?? 0);
  });
