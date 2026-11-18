// One-off: renders icon.svg to the PNG sizes the web manifest needs. Run: node tools/make-icons.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const svg = fs.readFileSync(path.join(__dirname, '..', 'icon.svg'), 'utf8');
const inner = svg.replace(/<rect[^>]*\/>/, '');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const shot = async (name, size, maskable) => {
    const body = maskable
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="${size}" height="${size}"><rect width="108" height="108" fill="#1f3a5f"/><g transform="translate(14 14) scale(.74)">${inner.replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g></svg>`
      : svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<body style="margin:0;background:transparent">${body}</body>`);
    await page.screenshot({ path: path.join(__dirname, '..', name), omitBackground: true });
  };
  await shot('icon-192.png', 192, false);
  await shot('icon-512.png', 512, false);
  await shot('icon-maskable-512.png', 512, true);
  await browser.close();
})();
