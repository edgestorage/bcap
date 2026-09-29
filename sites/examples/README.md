# examples bcap Scripts

## Description

Reference scripts showing the bcap reusable-script conventions: structured output, input-driven limits, Playwright usage and raw CDP usage.

## Scripts

### read-page-summary.js

- Description: Read a page summary: title, URL, headings, links and visible text.
- Pages: any `http(s)` page.
- Input: `headingLimit` (default 10), `linkLimit` (default 20), `textLimit` (default 2000).
- Output: `ok`, `url`, `title`, `headings[]`, `links[{text, href}]`, `text`.
- State: none.

### cdp-performance-metrics.js

- Description: Collect page performance metrics through a raw CDP session.
- Pages: any loaded `http(s)` page.
- Input: `names` (metric names to keep; defaults to Documents/Frames/Nodes/JSHeapUsedSize/LayoutCount/RecalcStyleCount/TaskDuration).
- Output: `ok`, `url`, `title`, `metrics{name: value}`.
- State: none.
