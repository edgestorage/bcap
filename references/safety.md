# bcap operating safety

## Tab ownership

- Reuse the tab the user already has open for the task.
- Do not close or repurpose the user's tabs without need.
- Close only temporary tabs you opened after capturing their result.
- Keep a tab open when it is the deliverable, when the next step depends on it, or when it is waiting for a user-only action such as login, CAPTCHA or payment.
- Keep at most 20 tabs overall; check `list` before opening more.
- If multiple tabs or sessions match, prefer the unambiguous match and ask the user otherwise.

## State-changing actions

For actions that change account or site state (post, edit, delete, settings, subscriptions):

- Prefer the page's own controls, then verify the resulting page state.
- Do not call private or semi-private site APIs directly unless the user explicitly asks for API execution, or the UI path is unavailable and the tradeoff is explained first.
- For destructive or externally visible actions, return a preview plan first and execute only after explicit confirmation. In reusable scripts, use the `input.confirm === true` pattern described in `script-authoring.md`.
- Pause on login, CAPTCHA, payment, approval or permission failures and leave that tab for the user.

## Headless mode

- If the task can complete without a person touching the browser, prefer headless mode to avoid an unnecessary window: `launch --headless` or `BCAP_HEADLESS=1`. Automated login and screenshot-based visual checks remain unattended.
- Human-in-the-loop work must stay visible. Do not use headless when the user must interact with, observe or take over the browser, such as manual credential/MFA or CAPTCHA entry, confirmation, payment, or an explicit request to watch.
- `launch` reuses a running browser; switching an existing headless local session to visible requires stopping that bcap-launched session and launching again. Do not stop a user-controlled browser without asking.

## Sensitive data

- `history.jsonl` records inputs, URLs, titles and errors. Do not pass credentials or secrets through `--input`.
- Let the user authenticate in the managed tab; do not extract or persist cookies, tokens or passwords.
- Screenshots, visible text and DOM evidence can contain personal or account data. Return only what the task needs and avoid copying them into logs.
- The local browser profile contains login state. Treat `.state/browser-profile*` as sensitive and do not inspect or copy it unless the task explicitly requires profile recovery.
