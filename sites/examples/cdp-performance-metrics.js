/**
 * bcap script — example (raw CDP usage)
 *
 * @description Collect page performance metrics through a raw CDP session.
 * @type read
 * @tags example, cdp, performance
 * @match https://*, http://*
 * @param {object} input
 * @param {string[]} [input.names] Metric names to keep.
 * @returns {{ok: boolean, url: string, title: string, metrics: Record<string, number>}}
 */
export default async function (input = {}) {
  const wanted = new Set(
    input.names ?? ['Documents', 'Frames', 'Nodes', 'JSHeapUsedSize', 'LayoutCount', 'RecalcStyleCount', 'TaskDuration']
  );

  await cdp.send('Performance.enable');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const picked = Object.fromEntries(metrics.filter((metric) => wanted.has(metric.name)).map((metric) => [metric.name, metric.value]));

  return { ok: true, url: page.url(), title: await page.title(), metrics: picked };
}
