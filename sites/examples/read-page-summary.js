/**
 * bcap script — example
 *
 * @description Read a page summary: title, URL, headings, links and visible text.
 * @param {object} input
 * @param {number} [input.headingLimit=10] Maximum number of headings to return.
 * @param {number} [input.linkLimit=20] Maximum number of links to return.
 * @param {number} [input.textLimit=2000] Maximum visible-text characters.
 * @returns {{ok: boolean, url: string, title: string, headings: string[], links: Array<{text: string, href: string}>, text: string}}
 */
export default async function (input = {}) {
  const headingLimit = input.headingLimit ?? 10;
  const linkLimit = input.linkLimit ?? 20;
  const textLimit = input.textLimit ?? 2000;

  const headings = await page
    .locator('h1, h2, h3')
    .evaluateAll((elements, limit) =>
      elements
        .slice(0, limit)
        .map((element) => (element.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean),
      headingLimit
    );

  const links = await page
    .locator('a[href]')
    .evaluateAll((elements, limit) =>
      elements.slice(0, limit).map((element) => ({
        text: (element.textContent || '').replace(/\s+/g, ' ').trim(),
        href: element.href
      })),
      linkLimit
    );

  const text = await page.evaluate(
    (limit) => (document.body ? document.body.innerText.replace(/[ \t]+\n/g, '\n').slice(0, limit) : ''),
    textLimit
  );

  return { ok: true, url: page.url(), title: await page.title(), headings, links, text };
}
