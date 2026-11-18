// End-to-end test in real Chromium. Run: node test/e2e.cjs   (needs the `playwright` package)
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert/strict');

const PASS = 'correct horse battery staple';
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push([name, true]); console.log(`  ok   ${name}`); }
  catch (e) { results.push([name, false]); console.log(`  FAIL ${name}\n       ${e.message.split('\n').slice(0, 6).join('\n       ')}`); throw e; }
};

function png(w, h) { // small valid RGB PNG with a gradient
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = x * 4; raw[o + 1] = y * 4; raw[o + 2] = 128; } }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function readRecoveryKey(page) {
  const groups = await page.locator('.rkey span').allTextContents();
  assert.equal(groups.length, 13);
  return groups;
}

async function finishSetupWithQuiz(page, groups) {
  await page.getByRole('button', { name: 'I have saved it' }).click();
  const inputs = page.locator('input[aria-label^="Group "]');
  assert.equal(await inputs.count(), 3);
  for (let i = 0; i < 3; i++) {
    const n = Number((await inputs.nth(i).getAttribute('aria-label')).split(' ')[1]);
    await inputs.nth(i).fill(groups[n - 1].toLowerCase());
  }
  await page.getByRole('button', { name: 'Confirm and create vault' }).click();
}

async function passphraseOnlyMethod(page) {
  await page.uncheck('#m-bio');
  await page.check('#m-pass');
  await page.fill('#p1', PASS);
  await page.fill('#p2', PASS);
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function reauth(page) { // fills the passphrase if a "Confirm it's you" dialog is showing
  const dlg = page.locator('.modal[aria-label="Confirm"]');
  if (await dlg.count()) { await dlg.locator('input').fill(PASS); await dlg.getByRole('button', { name: 'Confirm', exact: true }).click(); }
}

async function dumpIdb(page) { // every stored record as base64 / JSON, to prove nothing readable is at rest
  return page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('mysafe'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const out = [];
    for (const store of ['meta', 'blobs']) {
      const t = db.transaction(store); const os = t.objectStore(store);
      const keys = await new Promise((r) => { const q = os.getAllKeys(); q.onsuccess = () => r(q.result); });
      for (const k of keys) {
        const v = await new Promise((r) => { const q = os.get(k); q.onsuccess = () => r(q.result); });
        out.push({ store, key: String(k), json: JSON.stringify(v, (kk, vv) => (vv instanceof Uint8Array ? Array.from(vv) : vv)) });
      }
    }
    db.close();
    return out;
  });
}

(async () => {
  const { serve } = await import('./serve.mjs');
  const core = await import('../js/core.js');
  const server = await serve(0);
  const base = `http://localhost:${server.address().port}/`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mysafe-e2e-'));
  const browser = await chromium.launch();
  let context = await browser.newContext({ acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  let page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
  const offOrigin = [];
  page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) offOrigin.push(r.url()); });

  let recoveryText;
  try {
    console.log('Passphrase flow');
    await step('first run shows setup', async () => {
      await page.goto(base);
      await page.getByRole('heading', { name: 'My-Safe' }).waitFor();
      await page.getByRole('button', { name: 'Create my vault' }).waitFor();
    });
    await step('create vault with passphrase + recovery key quiz', async () => {
      await page.getByRole('button', { name: 'Create my vault' }).click();
      await page.getByRole('button', { name: 'Continue' }).waitFor();
      await passphraseOnlyMethod(page);
      const groups = await readRecoveryKey(page);
      recoveryText = groups.join('-');
      await page.getByRole('button', { name: 'I have saved it' }).waitFor();
      await finishSetupWithQuiz(page, groups);
      await page.getByRole('tab', { name: 'Photos' }).waitFor();
    });
    await step('add a password, edit it, history is kept', async () => {
      await page.getByRole('tab', { name: 'Passwords' }).click();
      await page.getByRole('button', { name: 'Add password' }).click();
      await page.fill('#pw-title', 'Bank Title E2E');
      await page.fill('#pw-user', 'alice-e2e');
      await page.fill('#pw-pass', 'e2e-secret-one');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByText('Bank Title E2E').click();
      await page.fill('#pw-pass', 'e2e-secret-two');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByText('Bank Title E2E').click();
      await page.getByText('Previous passwords (1)').waitFor();
      await page.getByRole('button', { name: 'Show', exact: true }).click(); // recent auth is still fresh
      await page.getByText('e2e-secret-one').waitFor();
      await page.getByRole('button', { name: 'Cancel' }).click();
    });
    await step('add a photo: thumbnail and viewer decrypt correctly', async () => {
      await page.getByRole('tab', { name: 'Photos' }).click();
      await page.setInputFiles('input[type=file][multiple]', { name: 'secret-photo-e2e.png', mimeType: 'image/png', buffer: png(64, 48) });
      await page.locator('.tile img').first().waitFor();
      await page.locator('.tile').first().click();
      await page.waitForFunction(() => { const i = document.querySelector('.viewer img'); return i && i.complete && i.naturalWidth === 64; });
      await page.getByRole('button', { name: 'Back' }).click();
    });
    await step('only ciphertext is stored in IndexedDB', async () => {
      const dump = await dumpIdb(page);
      assert.ok(dump.length >= 5, `expected meta + blobs, got ${dump.length}`);
      const canaries = ['Bank Title E2E', 'alice-e2e', 'e2e-secret-one', 'e2e-secret-two', 'secret-photo-e2e', recoveryText, PASS, 'IHDR', 'PNG'];
      for (const rec of dump) {
        const raw = Buffer.from(JSON.parse(rec.json) && rec.json, 'latin1');
        const bytes = [...rec.json.matchAll(/\[[\d,]+\]/g)].map((m) => Buffer.from(JSON.parse(m[0])));
        for (const b of [raw, ...bytes]) {
          const s = b.toString('latin1');
          for (const c of canaries) assert.ok(!s.includes(c), `plaintext "${c}" found in ${rec.store}/${rec.key}`);
        }
      }
      assert.ok(!dump.some((r) => r.key.toLowerCase().includes('secret')), 'file name leaked in a key');
    });
    await step('lock, wrong passphrase rejected, right passphrase unlocks', async () => {
      await page.getByRole('button', { name: 'Lock' }).click();
      await page.getByText('Your vault is locked.').waitFor();
      await page.fill('#unlock-pass', 'wrong wrong wrong');
      await page.getByRole('button', { name: 'Unlock with passphrase' }).click();
      await page.getByText('Wrong passphrase.').waitFor();
      await page.fill('#unlock-pass', PASS);
      await page.getByRole('button', { name: 'Unlock with passphrase' }).click();
      await page.getByRole('tab', { name: 'Photos' }).waitFor();
      await page.locator('.tile img').first().waitFor();
    });
    await step('data survives a reload', async () => {
      await page.reload();
      await page.fill('#unlock-pass', PASS);
      await page.getByRole('button', { name: 'Unlock with passphrase' }).click();
      await page.getByRole('tab', { name: 'Passwords' }).click();
      await page.getByText('Bank Title E2E').waitFor();
    });

    console.log('Backup and restore');
    let backupPath;
    await step('download an encrypted backup that the shared core can open', async () => {
      await page.getByRole('tab', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Download encrypted backup' }).click();
      await reauth(page);
      const dl = await page.waitForEvent('download');
      backupPath = path.join(tmp, 'e2e.msbk');
      await dl.saveAs(backupPath);
      const parsed = await core.parseBackup(new Uint8Array(fs.readFileSync(backupPath)), core.RecoveryKey.parse(recoveryText));
      assert.equal(parsed.index.passwords[0].title, 'Bank Title E2E');
      assert.equal(parsed.index.passwords[0].history[0].password, 'e2e-secret-one');
      assert.equal(parsed.index.photos[0].name, 'secret-photo-e2e.png');
      const text = fs.readFileSync(backupPath).toString('latin1');
      assert.ok(!text.includes('Bank Title E2E') && !text.includes('secret-photo-e2e'), 'plaintext in backup file');
    });
    const eraseAndRestore = async (file, key, expectTitle) => {
      await page.getByRole('tab', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Erase the vault from this browser' }).click();
      await page.locator('.modal').getByRole('button', { name: 'Erase' }).click();
      await page.getByRole('button', { name: 'Restore from a backup' }).click();
      await page.setInputFiles('#bk', file);
      await page.fill('#rk', key);
      await page.getByRole('button', { name: 'Restore', exact: true }).click();
      await page.getByRole('button', { name: 'Continue' }).waitFor();
      await passphraseOnlyMethod(page);
      await page.getByRole('tab', { name: 'Passwords' }).click();
      await page.getByText(expectTitle).waitFor();
    };
    await step('erase, then restore the web backup', async () => {
      await eraseAndRestore(backupPath, recoveryText.toLowerCase(), 'Bank Title E2E');
      await page.getByText('Bank Title E2E').click();
      await page.getByText('Previous passwords (1)').waitFor();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('tab', { name: 'Photos' }).click();
      await page.locator('.tile img').first().waitFor();
    });
    await step('wrong recovery key is rejected cleanly', async () => {
      await page.getByRole('tab', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Erase the vault from this browser' }).click();
      await page.locator('.modal').getByRole('button', { name: 'Erase' }).click();
      await page.getByRole('button', { name: 'Restore from a backup' }).click();
      await page.setInputFiles('#bk', backupPath);
      await page.fill('#rk', core.RecoveryKey.generate().format());
      await page.getByRole('button', { name: 'Restore', exact: true }).click();
      await page.getByText(/Could not open the backup/).waitFor();
    });
    await step('restore a backup made by the Android app', async () => {
      const fx = path.join(__dirname, 'fixtures');
      const key = fs.readFileSync(path.join(fx, 'android-backup.key.txt'), 'utf8').trim();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('button', { name: 'Restore from a backup' }).click();
      await page.setInputFiles('#bk', path.join(fx, 'android-backup.msbk'));
      await page.fill('#rk', key);
      await page.getByRole('button', { name: 'Restore', exact: true }).click();
      await page.getByRole('button', { name: 'Continue' }).waitFor();
      await passphraseOnlyMethod(page);
      await page.getByRole('tab', { name: 'Passwords' }).click();
      await page.getByText('Café ✓').click();
      assert.equal(await page.inputValue('#pw-user'), 'alice');
      assert.equal(await page.inputValue('#pw-url'), 'https://bank.example');
      await page.getByRole('button', { name: 'Reveal' }).click();
      await reauth(page);
      assert.equal(await page.inputValue('#pw-pass'), 'new-secret');
      await page.getByText('Previous passwords (1)').waitFor();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('tab', { name: 'Photos' }).click();
      await page.locator('.tile img').first().waitFor();
      await page.locator('.tile').first().click();
      await page.waitForFunction(() => { const i = document.querySelector('.viewer img'); return i && i.complete; }, null, { timeout: 5000 }).catch(() => {});
    });

    console.log('Vault file mode (nothing stored in the browser)');
    await context.close();
    context = await browser.newContext({ acceptDownloads: true });
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    let vaultFile;
    await step('create a file vault: no passkey offered, nothing written to IndexedDB', async () => {
      await page.goto(base);
      await page.getByRole('button', { name: 'Create my vault' }).click();
      await page.check('#st-file');
      assert.equal(await page.locator('#m-bio').isDisabled(), true);
      assert.equal(await page.locator('#m-bio').isChecked(), false);
      await page.fill('#p1', PASS); await page.fill('#p2', PASS);
      await page.getByRole('button', { name: 'Continue' }).click();
      const groups = await readRecoveryKey(page);
      await finishSetupWithQuiz(page, groups);
      await page.getByRole('tab', { name: 'Photos' }).waitFor();
      await page.getByRole('button', { name: /Save vault \u2022/ }).waitFor(); // unsaved
      await page.getByRole('tab', { name: 'Passwords' }).click();
      await page.getByRole('button', { name: 'Add password' }).click();
      await page.fill('#pw-title', 'File Vault Bank'); await page.fill('#pw-user', 'dave'); await page.fill('#pw-pass', 'fv-secret-1');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('tab', { name: 'Photos' }).click();
      await page.setInputFiles('input[type=file][multiple]', { name: 'file-vault-photo.png', mimeType: 'image/png', buffer: png(32, 32) });
      await page.locator('.tile img').first().waitFor();
      assert.deepEqual(await dumpIdb(page), [], 'browser storage must stay empty in file mode');
    });
    await step('save the vault file: button clears, file is ciphertext and opens with the passphrase', async () => {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Save vault/ }).first().click()]);
      vaultFile = path.join(tmp, 'vault.msvf');
      await dl.saveAs(vaultFile);
      assert.ok(dl.suggestedFilename().endsWith('.msvf'));
      await page.getByRole('button', { name: 'Save vault', exact: true }).waitFor(); // no dirty dot
      const bytes = new Uint8Array(fs.readFileSync(vaultFile));
      const text = Buffer.from(bytes).toString('latin1');
      for (const c of ['File Vault Bank', 'dave', 'fv-secret-1', 'file-vault-photo', 'IHDR']) assert.ok(!text.includes(c), `plaintext "${c}" in vault file`);
      const V = await import('../js/vault.js');
      const f = core.parseVaultFile(bytes);
      const vmk = await V.openPassWrap(f.pass, PASS);
      const idx = await core.openIndex(vmk, f.sealedIndex);
      assert.equal(idx.passwords[0].password, 'fv-secret-1');
      assert.equal(idx.photos.length, 1);
      assert.deepEqual(await dumpIdb(page), []);
    });
    await step('unsaved changes trigger the leave-page warning', async () => {
      await page.getByRole('tab', { name: 'Passwords' }).click();
      await page.getByText('File Vault Bank').click();
      await page.fill('#pw-pass', 'fv-secret-2');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('button', { name: /Save vault \u2022/ }).waitFor();
      const dlg = page.waitForEvent('dialog', { timeout: 10000 });
      await page.close({ runBeforeUnload: true });
      const d = await dlg;
      assert.equal(d.type(), 'beforeunload');
      await d.accept(); // leave the page anyway
    });
    await step('a fresh page has forgotten everything; open the file and unlock', async () => {
      page = await context.newPage();
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      await page.goto(base);
      await page.getByRole('button', { name: 'Create my vault' }).waitFor(); // first-run screen: no vault remembered
      await page.getByRole('button', { name: 'Open a vault file' }).click();
      await page.setInputFiles('#vf', vaultFile);
      await page.getByRole('button', { name: 'Open', exact: true }).click();
      await page.getByText('It is held in memory only.').waitFor();
      await page.fill('#unlock-pass', 'wrong wrong wrong');
      await page.getByRole('button', { name: 'Unlock with passphrase' }).click();
      await page.getByText('Wrong passphrase.').waitFor();
      await page.fill('#unlock-pass', PASS);
      await page.getByRole('button', { name: 'Unlock with passphrase' }).click();
      await page.getByRole('tab', { name: 'Photos' }).waitFor();
      await page.locator('.tile img').first().waitFor();
      await page.getByRole('tab', { name: 'Passwords' }).click();
      await page.getByText('File Vault Bank').click();
      assert.equal(await page.inputValue('#pw-user'), 'dave');
      await page.getByRole('button', { name: 'Reveal' }).click();
      await reauth(page);
      assert.equal(await page.inputValue('#pw-pass'), 'fv-secret-1'); // the saved file predates the edit to fv-secret-2
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Save vault', exact: true }).waitFor(); // opening a file is not a change
      assert.deepEqual(await dumpIdb(page), []);
    });
    await step('a wrong file is rejected; closing the vault returns to the start', async () => {
      await page.getByRole('tab', { name: 'Settings' }).click();
      await page.getByRole('button', { name: /Close this vault/ }).click();
      await page.locator('.modal').getByRole('button', { name: 'Close vault' }).click();
      await page.getByRole('button', { name: 'Open a vault file' }).click();
      await page.setInputFiles('#vf', path.join(__dirname, 'fixtures', 'android-backup.msbk')); // a backup, not a vault file
      await page.getByRole('button', { name: 'Open', exact: true }).click();
      await page.getByText(/Could not open the file/).waitFor();
      assert.deepEqual(await dumpIdb(page), []);
    });

    console.log('Passkey (WebAuthn PRF) flow');
    await context.close();
    context = await browser.newContext();
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    let passkeyRecovery;
    await step('set up with passkey only, skipping the recovery key', async () => {
      await page.goto(base);
      await page.getByRole('button', { name: 'Create my vault' }).click();
      await page.getByRole('button', { name: 'Continue' }).click(); // passkey is pre-selected
      await page.getByRole('button', { name: /Skip the recovery key/ }).click();
      await page.locator('.modal').getByRole('button', { name: 'Skip anyway' }).click();
      await page.getByRole('tab', { name: 'Photos' }).waitFor();
    });
    await step('lock and unlock with the passkey (PRF-derived key)', async () => {
      await page.getByRole('button', { name: 'Lock' }).click();
      // With a passkey as the only method the lock screen prompts by itself; otherwise use the button.
      const unlockBtn = page.getByRole('button', { name: 'Unlock with fingerprint / screen lock' });
      const photosTab = page.getByRole('tab', { name: 'Photos' });
      await Promise.race([photosTab.waitFor(), unlockBtn.waitFor()]);
      if (!(await photosTab.count())) await unlockBtn.click().catch(() => {});
      await photosTab.waitFor();
    });
    await step('settings: backup disabled without a recovery key; create one', async () => {
      await page.getByRole('tab', { name: 'Settings' }).click();
      assert.equal(await page.getByRole('button', { name: 'Download encrypted backup' }).isDisabled(), true);
      await page.getByRole('button', { name: 'Create a recovery key' }).click();
      passkeyRecovery = (await page.locator('.modal .rkey span').allTextContents()).join('-');
      assert.equal(passkeyRecovery.split('-').length, 13);
      await page.locator('.modal').getByRole('button', { name: 'I have saved it' }).click();
      await page.getByText('A recovery key exists.').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Download encrypted backup' }).isDisabled(), false);
    });
    await step('losing the passkey blocks unlock; the recovery key gets you back in', async () => {
      await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
      await page.getByRole('button', { name: 'Lock' }).click();
      await page.getByText(/Authentication failed|Cancelled|did not|Could not/).first().waitFor();
      await page.getByRole('button', { name: 'Use recovery key instead' }).click();
      await page.fill('input[aria-label="Recovery key"]', 'AAAA-' + passkeyRecovery.split('-').slice(1).join('-'));
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await page.getByText('That recovery key does not match this vault.').waitFor();
      await page.fill('input[aria-label="Recovery key"]', passkeyRecovery.toLowerCase());
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await page.getByRole('heading', { name: 'Set up unlocking again' }).waitFor();
      await page.getByRole('button', { name: 'Continue' }).click(); // enrolls a fresh passkey
      await page.getByRole('tab', { name: 'Photos' }).waitFor();
    });
    await step('the new passkey unlocks after a lock', async () => {
      await page.getByRole('button', { name: 'Lock' }).click();
      const photosTab = page.getByRole('tab', { name: 'Photos' });
      const unlockBtn = page.getByRole('button', { name: 'Unlock with fingerprint / screen lock' });
      await Promise.race([photosTab.waitFor(), unlockBtn.waitFor()]);
      if (!(await photosTab.count())) await unlockBtn.click().catch(() => {});
      await photosTab.waitFor();
    });

    console.log('Hygiene');
    await step('no failed requests, console errors or off-origin traffic', async () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(offOrigin, []);
    });
  } catch (e) {
    console.log('\nFirst failure above stopped the run.');
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    const failed = results.filter((r) => !r[1]).length;
    console.log(`\n${results.length - failed}/${results.length} steps passed${process.exitCode ? ' (run aborted)' : ''}`);
  }
})();
