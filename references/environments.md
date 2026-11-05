# bcap environments and browser lifecycle

`status` reports the detected environment and whether a browser is reachable. Detection defaults to `auto`; `--env taskhandoff|local` or `BCAP_ENV` overrides it.

## Environment detection

- Any `TASK_HANDOFF_*` marker selects `taskhandoff` immediately. Markers include `TASK_HANDOFF_DATA_DIR`, `TASK_HANDOFF_INSTANCE_ID`, `TASK_HANDOFF_INSTANCE_NAME`, `TASK_HANDOFF_NODE_AGENT_URL`, `TASK_HANDOFF_CONTROL_MODE` and `TASK_HANDOFF_AGENT_TOOLS_ENDPOINT`.
- Without markers, bcap probes the control-plane sessions endpoint at `--api` / `BCAP_API` (default `http://127.0.0.1:8080`). A valid response selects `taskhandoff`; otherwise it uses `local`.
- Markers select the environment even when the control plane is temporarily unreachable. If a local browser is explicitly intended in that process, pass `--env local` or set `BCAP_ENV=local`.

## TaskHandoff-managed Chromium

In a TaskHandoff instance the browser is a managed app (`appId: chromium`), so bcap does not spawn a bare Chromium.

- `launch` reuses a running `chromium` session or creates one with `POST /api/apps/sessions`, waits for CDP, and prints the endpoint.
- Multiple browser sessions may run. `status` lists them; the first running session is the default. Use `--session <id>` for a specific one, `launch --new-session` for another, and `stop <sessionId>` for one managed session.
- The session exposes CDP (usually `http://127.0.0.1:9201`) and a KasmVNC view in the instance UI, so the user can watch and operate the same tabs.
- Tabs persist until closed or the managed session is stopped from the UI or by `POST /api/apps/sessions/<id>/stop`.

## Local Chromium

Outside TaskHandoff, bcap reuses a reachable browser first and only launches one when needed.

- Reuse order: `--cdp` / `BCAP_CDP`, tracked browsers started by bcap, then the default CDP candidates (9201 and 9222 unless overridden by `--port` / `BCAP_PORT`).
- `launch` is idempotent and reuses a tracked browser unless `--new-session` is passed.
- The default is a visible window. Prefer `--headless` or `BCAP_HEADLESS=1` whenever the task can complete without a person touching the browser; automated login, tests, extraction and screenshot-based visual checks are unattended. Use the visible browser only when the user must interact with, observe or take over it. Set `BCAP_HEADLESS=0` to override an inherited headless setting.
- `launch` reuses an existing browser. If the user must take over and the current local session is headless, stop that session (`stop all` or the matching id/pid/port) and launch again without headless. Do not stop a browser the user controls without asking.
- Launch options: `--executable <path>` / `BCAP_BROWSER`, `--user-data-dir <dir>`, `--port <n>`, and `--new-session`.
- Executable discovery checks the explicit path, common Chrome/Chromium/Edge/Brave/Vivaldi locations, then Playwright's bundled Chromium. Set `BCAP_BROWSER` if nothing is found.
- The profile defaults to `<skill>/.state/browser-profile`, so logins persist across runs. A second browser gets a separate profile directory when the requested one is already in use.
- Launched browsers are tracked in `<skill>/.state/local-browser.json`. `stop <local-id|pid|port>` stops one; `stop all` stops all bcap-launched local browsers. Dead or unreachable entries are pruned.

## Recovery

- `status` with `running:false`: run `launch`, then re-check.
- `status` says `taskhandoff` but the control plane is unavailable: start the control plane, or use `--env local` when a local browser is the intended target.
- `launch` cannot reach the TaskHandoff control plane: use `--env local` only if the managed browser is not required.
- `--cdp <url>` with no endpoint: correct the URL, drop the override to allow auto-discovery, or run `launch`.
- Ambiguous sessions or tabs: ask the user; do not choose by guesswork.
