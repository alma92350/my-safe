// End-to-end test of the single-file (sandbox mode) build: node tools/build-single.mjs && node test/e2e-single.cjs
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const PASS = 'correct horse battery staple';
const file = path.join(__dirname, '..', 'dist', 'my-safe-single.html');
// Mimic the host skeleton: doctype, charset + viewport, light colour scheme, root padding.
const page0 = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui}</style></head><body>${fs.readFileSync(file, 'utf8')}</body></html>`;
const step = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); } catch (e) { console.log(`  FAIL ${name}\n       ${e.message.split('\n').slice(0, 5).join('\n       ')}`); throw e; } };

(async () => {
  const server = http.createServer((q, r) => r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page0));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  let failed = false;
  try {
    await step('loads in sandbox mode: passkey unavailable, passphrase offered', async () => {
      await page.goto(base);
      await page.getByRole('button', { name: 'Create my vault' }).click();
      assert.equal(await page.locator('#m-bio').isDisabled(), true);
      assert.equal(await page.locator('#m-pass').isChecked(), true);
      await page.getByText(/Not available in this preview/).waitFor();
    });
    let key;
    await step('create vault, passwords, photo', async () => {
      await page.fill('#p1', PASS); await page.fill('#p2', PASS);
      await page.getByRole('button', { name: 'Continue' }).click();
      const groups = await page.locator('.rkey span').allTextContents();
      key = groups.join('-');
      await page.getByRole('button', { name: 'I have saved it' }).click();
      const inputs = page.locator('input[aria-label^="Group "]');
      for (let i = 0; i < 3; i++) { const n = Number((await inputs.nth(i).getAttribute('aria-label')).split(' ')[1]); await inputs.nth(i).fill(groups[n - 1]); }
      await page.getByRole('button', { name: 'Confirm and create vault' }).click();
      await page.getByRole('tab', { name: 'Passwords' }).click();
      await page.getByRole('button', { name: 'Add password' }).click();
      await page.fill('#pw-title', 'Sandbox Bank'); await page.fill('#pw-user', 'carol'); await page.fill('#pw-pass', 's1');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByText('Sandbox Bank').click();
      await page.fill('#pw-pass', 's2');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('tab', { name: 'Photos' }).click();
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      await page.setInputFiles('input[type=file][multiple]', { name: 'dot.png', mimeType: 'image/png', buffer: png });
      await page.locator('.tile').first().waitFor();
    });
    let backupText;
    await step('"Save copy" is hidden and backup is offered as text', async () => {
      await page.locator('.tile').first().click();
      await page.locator('.viewer').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Save copy' }).count(), 0);
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('tab', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Copy backup as text' }).click();
      const dlg = page.locator('.modal[aria-label="Confirm"]');
      if (await dlg.count()) { await dlg.locator('input').fill(PASS); await dlg.getByRole('button', { name: 'Confirm', exact: true }).click(); }
      const area = page.locator('textarea[aria-label="Encrypted backup text"]');
      await area.waitFor();
      backupText = await area.inputValue();
      assert.ok(backupText.length > 200 && /^[A-Za-z0-9+/=]+$/.test(backupText));
      await page.locator('.modal').getByRole('button', { name: 'Copy' }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), backupText);
      await page.locator('.modal').getByRole('button', { name: 'Close' }).click();
    });
    await step('erase, restore from pasted text, data is back', async () => {
      await page.getByRole('button', { name: 'Erase the vault from this browser' }).click();
      await page.locator('.modal').getByRole('button', { name: 'Erase' }).click();
      await page.getByRole('button', { name: 'Restore from a backup file' }).click();
      await page.fill('#bk-text', backupText);
      await page.fill('#rk', key);
      await page.getByRole('button', { name: 'Restore', exact: true }).click();
      await page.getByRole('button', { name: 'Continue' }).waitFor();
      await page.fill('#p1', PASS); await page.fill('#p2', PASS);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('tab', { name: 'Passwords' }).click();
      await page.getByText('Sandbox Bank').click();
      await page.getByText('Previous passwords (1)').waitFor();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('tab', { name: 'Photos' }).click();
      await page.locator('.tile img').first().waitFor();
    });
    await step('lock/unlock and no errors', async () => {
      await page.getByRole('button', { name: 'Lock' }).click();
      await page.fill('#unlock-pass', PASS);
      await page.getByRole('button', { name: 'Unlock with passphrase' }).click();
      await page.getByRole('tab', { name: 'Photos' }).waitFor();
      assert.deepEqual(errors, []);
    });
    await step('dark theme follows the token pattern', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.equal(bg, 'rgb(17, 22, 29)');
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(245, 246, 248)');
    });
    console.log('\nsingle-file build: all steps passed');
  } catch (e) { failed = true; process.exitCode = 1; } finally { await browser.close(); server.close(); }
})();
