// My-Safe web app: setup, unlock, photos, passwords, settings, backup.
import * as core from './core.js';
import * as V from './vault.js';
import { enrollPrf, prfAssert, webauthnPossible } from './auth.js';

// Set by the single-file "artifact" build, whose frame blocks downloads, service workers and (very likely) passkeys.
const SANDBOX = !!window.__MYSAFE_SANDBOX__;
const root = document.getElementById('app');
const S = {
  db: null, meta: null, session: null, settings: { ...V.DEFAULT_SETTINGS },
  urls: new Map(),       // photo id -> object URL of its decrypted thumbnail
  hiddenAt: 0, externalInFlight: false, lastActivity: Date.now(), tab: 'photos',
};

// ------------------------------------------------------------------ tiny DOM helpers (no innerHTML anywhere)

const PROPS = new Set(['value', 'checked', 'disabled', 'multiple', 'selected', 'readOnly']);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const mount = (...nodes) => root.replaceChildren(...nodes);
const page = (...nodes) => h('main', { class: 'page' }, ...nodes);

let toastTimer;
function toast(msg, isError = false) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast' + (isError ? ' error' : ''), role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), isError ? 6000 : 3500);
}

async function busy(label, fn) {
  const o = h('div', { class: 'busy', role: 'alert' }, label);
  document.body.append(o);
  try { return await fn(); } finally { o.remove(); }
}

/** Modal with buttons; resolves with the chosen action's value (or null if dismissed). */
function dialog({ title, body, actions }) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back' });
    const close = (v) => { back.remove(); resolve(v); };
    const m = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', {}, title), body,
      h('div', { class: 'row split' }, actions.map((a) => h('button', { class: a.kind || '', onclick: async () => {
        if (a.validate && !(await a.validate())) return;
        close(a.value);
      } }, a.label))));
    back.append(m);
    document.body.append(back);
    m.querySelector('input,button')?.focus();
  });
}

const confirmDialog = (title, text, okLabel = 'OK', danger = false) =>
  dialog({ title, body: h('p', {}, text), actions: [{ label: 'Cancel', value: false }, { label: okLabel, kind: danger ? 'danger' : 'primary', value: true }] });

function download(parts, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(text) {
  const bin = atob(text.replace(/\s+/g, ''));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const errMsg = (e) => (e && e.message) || String(e);
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString() : '(date unknown)');

// ------------------------------------------------------------------ boot

async function boot() {
  S.db = await V.openDb();
  S.meta = await V.readMeta(S.db);
  S.settings = S.meta.settings;
  if (!SANDBOX && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  S.meta.exists ? showLock() : showSetup();
}

// ------------------------------------------------------------------ choosing unlock methods (setup, recovery, restore)

/**
 * Shows the "how do you want to unlock" step. `onChoice({ prf?, passphrase? })` is called once the user
 * has chosen and (for passkeys) enrolled successfully.
 */
function showMethodStep({ title, intro, onChoice, onBack }) {
  const canPasskey = webauthnPossible() && !SANDBOX;
  const bio = h('input', { type: 'checkbox', id: 'm-bio', checked: canPasskey, disabled: !canPasskey });
  const pass = h('input', { type: 'checkbox', id: 'm-pass', checked: !canPasskey });
  const p1 = h('input', { type: 'password', id: 'p1', autocomplete: 'new-password', 'aria-label': 'Passphrase' });
  const p2 = h('input', { type: 'password', id: 'p2', autocomplete: 'new-password', 'aria-label': 'Repeat passphrase' });
  const passBox = h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Passphrase (at least 12 characters)', p1),
    h('label', { class: 'field' }, 'Repeat passphrase', p2),
    h('p', { class: 'muted' }, 'Anyone who gets a copy of this browser\'s data can try guesses offline, so use a long, unique passphrase. There is no way to reset it, but your recovery key can.'));
  const sync = () => passBox.classList.toggle('hidden', !pass.checked);
  pass.addEventListener('change', sync); sync();
  const err = h('p', { class: 'error', role: 'alert' });

  const go = h('button', { class: 'primary', onclick: async () => {
    err.textContent = '';
    if (!bio.checked && !pass.checked) { err.textContent = 'Choose at least one way to unlock.'; return; }
    if (pass.checked) {
      if (p1.value.length < 12) { err.textContent = 'The passphrase needs at least 12 characters.'; return; }
      if (p1.value !== p2.value) { err.textContent = 'The two passphrases differ.'; return; }
    }
    const choice = {};
    if (bio.checked) {
      try { choice.prf = await busy('Waiting for your fingerprint or screen lock…', enrollPrf); }
      catch (e) { err.textContent = errMsg(e); return; }
    }
    if (pass.checked) choice.passphrase = p1.value;
    await onChoice(choice);
  } }, 'Continue');

  mount(page(
    h('h1', {}, title), intro && h('p', {}, intro),
    h('div', { class: 'card stack' },
      h('label', { class: 'check', for: 'm-bio' }, bio, h('span', {}, h('strong', {}, 'Fingerprint, face or screen lock'),
        h('br'), h('span', { class: 'muted' }, canPasskey
          ? 'Uses a passkey. The vault key can only be released after your device verifies you. Your device decides whether a PIN is also accepted.'
          : SANDBOX ? 'Not available in this preview. Open the app on its own address to use passkeys.' : 'Not available in this browser.'))),
      h('label', { class: 'check', for: 'm-pass' }, pass, h('span', {}, h('strong', {}, 'Passphrase'),
        h('br'), h('span', { class: 'muted' }, 'Works in any browser. Also a fallback if your passkey is lost.'))),
      passBox),
    err, go, onBack && h('button', { class: 'link', onclick: onBack }, 'Back')));
}

async function buildDevice(vmk, choice) {
  const device = {};
  if (choice.prf) device.prf = await V.makePrfWrap(vmk, choice.prf);
  if (choice.passphrase) device.pass = await busy('Securing your passphrase…', () => V.makePassWrap(vmk, choice.passphrase));
  return device;
}

// ------------------------------------------------------------------ setup / restore

function showSetup() {
  mount(page(
    h('h1', {}, 'My-Safe'),
    h('p', {}, 'An encrypted vault for your photos, screenshots and passwords. Everything is encrypted in this browser and never leaves this device.'),
    h('div', { class: 'card' }, h('p', {}, 'You will get a ', h('strong', {}, 'recovery key'), '. It is the only way back in if you lose your passkey or forget your passphrase, and the only way to restore a backup. Nobody can recover it for you.')),
    h('button', { class: 'primary', onclick: () => showMethodStep({
      title: 'How do you want to unlock?', onBack: showSetup,
      onChoice: (choice) => showRecoveryStep(choice, null),
    }) }, 'Create my vault'),
    h('button', { onclick: showRestore }, 'Restore from a backup file')));
}

function showRestore() {
  const file = h('input', { type: 'file', accept: '.msbk,application/octet-stream', id: 'bk' });
  const key = h('input', { type: 'text', id: 'rk', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' });
  const pasted = h('textarea', { id: 'bk-text', spellcheck: 'false', 'aria-label': 'Backup text' });
  const err = h('p', { class: 'error', role: 'alert' });
  mount(page(
    h('h1', {}, 'Restore from backup'),
    h('p', {}, 'Works with backups from this web app and from the My-Safe Android app.'),
    h('label', { class: 'field' }, 'Backup file (.msbk)', file),
    SANDBOX && h('label', { class: 'field' }, 'Or paste backup text (from "Copy backup as text")', pasted),
    h('label', { class: 'field' }, 'Recovery key', key),
    err,
    h('button', { class: 'primary', onclick: async () => {
      err.textContent = '';
      if (!file.files[0] && !pasted.value.trim()) { err.textContent = 'Choose the backup file' + (SANDBOX ? ' or paste its text.' : '.'); return; }
      let rk;
      try { rk = core.RecoveryKey.parse(key.value); } catch (e) { err.textContent = errMsg(e); return; }
      let restored;
      try {
        restored = await busy('Checking the backup…', async () => core.parseBackup(
          file.files[0] ? new Uint8Array(await file.files[0].arrayBuffer()) : fromBase64(pasted.value), rk));
      } catch (e) { err.textContent = e instanceof core.VaultCryptoError ? `Could not open the backup: ${e.message}` : errMsg(e); return; }
      showMethodStep({
        title: 'Unlock method for this device', intro: 'The backup is valid. Choose how this device will unlock it.',
        onBack: showRestore,
        onChoice: (choice) => finalizeVault({ choice, vmk: restored.vmk, index: restored.index, blobs: restored.blobs, recoveryWrap: restored.recoveryWrap }),
      });
    } }, 'Restore'),
    h('button', { class: 'link', onclick: showSetup }, 'Back')));
}

function showRecoveryStep(choice) {
  const rk = core.RecoveryKey.generate();
  mount(page(
    h('h1', {}, 'Your recovery key'),
    h('p', {}, 'Write this down on paper and keep it somewhere safe, ', h('strong', {}, 'not on this device'), '. It is shown once.'),
    h('div', { class: 'card rkey', 'aria-label': 'Recovery key' }, rk.groups().map((g) => h('span', {}, g))),
    h('button', { class: 'primary', onclick: () => showConfirmStep(choice, rk) }, 'I have saved it'),
    h('button', { class: 'link danger', onclick: async () => {
      const ok = await confirmDialog('Skip the recovery key?',
        'Without it, your data is lost for good if you lose your passkey, forget your passphrase or clear this browser\'s data, and you cannot make backups. You can create one later in Settings.', 'Skip anyway', true);
      if (ok) finalizeVault({ choice, rk: null });
    } }, 'Skip the recovery key (not recommended)')));
}

function showConfirmStep(choice, rk) {
  const groups = rk.groups();
  const asked = [...Array(core.GROUP_COUNT).keys()].sort(() => core.randomBytes(1)[0] / 255 - 0.5).slice(0, 3).sort((a, b) => a - b);
  const inputs = asked.map((g) => h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': `Group ${g + 1}` }));
  const err = h('p', { class: 'error', role: 'alert' });
  mount(page(
    h('h1', {}, 'Confirm your recovery key'),
    h('p', {}, 'Enter these groups of your recovery key to prove you saved it.'),
    asked.map((g, i) => h('label', { class: 'field' }, `Group ${g + 1}`, inputs[i])),
    err,
    h('button', { class: 'primary', onclick: () => {
      if (asked.every((g, i) => inputs[i].value.trim().toUpperCase() === groups[g])) finalizeVault({ choice, rk });
      else err.textContent = 'Those groups do not match. Check what you wrote down.';
    } }, 'Confirm and create vault'),
    h('button', { class: 'link', onclick: () => showRecoveryStep(choice) }, 'Show the key again')));
}

async function finalizeVault({ choice, rk, vmk, index, blobs, recoveryWrap }) {
  try {
    await busy('Creating your vault…', async () => {
      vmk = vmk || core.newMasterKey();
      const device = await buildDevice(vmk, choice);
      if (!recoveryWrap && rk) recoveryWrap = await core.wrapWithRecovery(vmk, rk);
      await V.createVault(S.db, { vmk, device, recoveryWrap: recoveryWrap || null, index: index || core.emptyIndex(), blobs });
      S.meta = await V.readMeta(S.db);
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      await openSession(vmk);
    });
    toast('Vault ready.');
  } catch (e) {
    toast(`Could not create the vault: ${errMsg(e)}`, true);
  }
}

// ------------------------------------------------------------------ lock screen / unlock

async function openSession(vmk) {
  S.meta = await V.readMeta(S.db);
  S.session = await V.Session.open(S.db, vmk, S.meta.sealedIndex);
  S.settings = S.meta.settings;
  S.lastActivity = Date.now();
  showMain();
}

function lock() {
  if (S.session) { S.session.close(); S.session = null; }
  for (const u of S.urls.values()) URL.revokeObjectURL(u);
  S.urls.clear();
  document.querySelectorAll('.overlay,.modal-back,.toast,.busy').forEach((n) => n.remove());
  showLock();
}

async function eraseEverything() {
  const ok = await confirmDialog('Erase everything?', 'All photos and passwords in this browser are permanently deleted. You can only get them back from a backup file and your recovery key.', 'Erase', true);
  if (!ok) return;
  if (S.session) { S.session.close(); S.session = null; }
  await V.deleteDatabase(S.db);
  S.db = await V.openDb();
  S.meta = await V.readMeta(S.db);
  S.settings = { ...V.DEFAULT_SETTINGS };
  showSetup();
}

function showLock(message = '') {
  const dev = S.meta.device || {};
  const err = h('p', { class: 'error', role: 'alert' }, message);
  const nodes = [h('h1', {}, 'My-Safe'), h('p', { class: 'muted' }, 'Your vault is locked.'), err];

  const tryPrf = async () => {
    err.textContent = '';
    try {
      const out = await prfAssert(dev.prf.credId, dev.prf.prfSalt);
      await openSession(await V.openPrfWrap(dev.prf, out));
    } catch (e) { err.textContent = e instanceof core.VaultCryptoError ? 'That passkey did not unlock this vault.' : errMsg(e); }
  };
  if (dev.prf) nodes.push(h('button', { class: 'primary', onclick: tryPrf }, 'Unlock with fingerprint / screen lock'));

  if (dev.pass) {
    const input = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Passphrase', id: 'unlock-pass' });
    const submit = async () => {
      err.textContent = '';
      try { await openSession(await busy('Unlocking…', () => V.openPassWrap(dev.pass, input.value))); }
      catch (e) { err.textContent = e instanceof core.VaultCryptoError ? 'Wrong passphrase.' : errMsg(e); input.select(); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    nodes.push(h('div', { class: 'card stack' }, h('label', { class: 'field' }, 'Passphrase', input), h('button', { class: dev.prf ? '' : 'primary', onclick: submit }, 'Unlock with passphrase')));
  }

  if (S.meta.recoveryWrap) nodes.push(h('button', { class: 'link', onclick: showRecoveryUnlock }, 'Use recovery key instead'));
  else nodes.push(h('p', { class: 'muted' }, 'No recovery key was created for this vault.'));
  nodes.push(h('button', { class: 'link danger', onclick: eraseEverything }, 'Erase this vault and start over'));
  mount(page(...nodes));
  if (dev.prf && !dev.pass && document.hasFocus() && !message) tryPrf();
}

function showRecoveryUnlock() {
  const key = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Recovery key' });
  const err = h('p', { class: 'error', role: 'alert' });
  mount(page(
    h('h1', {}, 'Unlock with recovery key'),
    h('label', { class: 'field' }, 'Recovery key (52 characters)', key), err,
    h('button', { class: 'primary', onclick: async () => {
      err.textContent = '';
      let vmk;
      try { vmk = await core.unwrapWithRecovery(S.meta.recoveryWrap, core.RecoveryKey.parse(key.value)); }
      catch (e) { err.textContent = e instanceof core.VaultCryptoError ? 'That recovery key does not match this vault.' : errMsg(e); return; }
      showMethodStep({
        title: 'Set up unlocking again', intro: 'Recovery worked. Choose how this device will unlock the vault from now on.',
        onChoice: async (choice) => {
          try {
            await V.saveDevice(S.db, await buildDevice(vmk, choice));
            await openSession(vmk);
          } catch (e) { toast(errMsg(e), true); }
        },
      });
    } }, 'Unlock'),
    h('button', { class: 'link', onclick: () => showLock() }, 'Back')));
}

/** Asks the owner to authenticate again unless they did in the last 60 s. Resolves true on success. */
async function requireRecentAuth() {
  if (Date.now() - S.session.lastAuth < 60_000) return true;
  const dev = S.meta.device;
  const err = h('p', { class: 'error', role: 'alert' });
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Confirm it\'s you to continue.'), err);
  let done;
  const result = new Promise((r) => { done = r; });
  const ok = () => { S.session.lastAuth = Date.now(); m.close(); done(true); };
  if (dev.prf) body.append(h('button', { class: 'primary', onclick: async () => {
    try { (await V.openPrfWrap(dev.prf, await prfAssert(dev.prf.credId, dev.prf.prfSalt))).fill(0); ok(); } catch (e) { err.textContent = errMsg(e); }
  } }, 'Use fingerprint / screen lock'));
  if (dev.pass) {
    const input = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Passphrase' });
    body.append(h('label', { class: 'field' }, 'Passphrase', input), h('button', { onclick: async () => {
      try { (await busy('Checking…', () => V.openPassWrap(dev.pass, input.value))).fill(0); ok(); } catch { err.textContent = 'Wrong passphrase.'; }
    } }, 'Confirm'));
  }
  const m = { close: () => document.querySelector('.modal-back')?.remove() };
  dialog({ title: 'Confirm', body, actions: [{ label: 'Cancel', value: false }] }).then((v) => { if (!v) done(false); });
  return result;
}

// ------------------------------------------------------------------ main shell

function showMain() {
  const content = h('div', { class: 'content' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const names = [['photos', 'Photos'], ['passwords', 'Passwords'], ['settings', 'Settings']];
  const render = () => {
    tabs.replaceChildren(...names.map(([id, label]) => h('button', { role: 'tab', 'aria-selected': String(S.tab === id), onclick: () => { S.tab = id; render(); } }, label)));
    content.replaceChildren(S.tab === 'photos' ? photosView() : S.tab === 'passwords' ? passwordsView() : settingsView());
  };
  S.rerender = render;
  mount(h('header', { class: 'topbar' }, h('strong', {}, 'My-Safe'), h('button', { onclick: lock }, 'Lock')), tabs, content);
  render();
}

// ------------------------------------------------------------------ photos

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };
function sniffMime(b, name) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
  return MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
}

async function makeThumb(file, max = 320) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch { return null; }
}

async function importFiles(files) {
  const list = [...files].filter((f) => f.size > 0);
  if (!list.length) return;
  let ok = 0, failed = 0;
  await busy(`Encrypting ${list.length} file(s)…`, async () => {
    for (const f of list) {
      try {
        await S.session.addPhoto(f.name || 'photo', new Uint8Array(await f.arrayBuffer()), await makeThumb(f));
        ok++;
      } catch (e) { failed++; }
    }
  });
  toast(`Imported ${ok} photo(s)${failed ? `, ${failed} failed` : ''}. Delete the originals from your gallery yourself.`, failed > 0);
  S.rerender?.();
}

async function thumbUrl(item) {
  if (S.urls.has(item.id)) return S.urls.get(item.id);
  const bytes = await S.session.readBlob(item.thumbName);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  S.urls.set(item.id, url);
  return url;
}

function photosView() {
  const pick = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'hidden', onchange: (e) => { S.externalInFlight = false; importFiles(e.target.files); e.target.value = ''; } });
  const cam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden', onchange: (e) => { S.externalInFlight = false; importFiles(e.target.files); e.target.value = ''; } });
  const grid = h('div', { class: 'grid' });
  const observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      observer.unobserve(en.target);
      const item = en.target._item;
      thumbUrl(item).then((u) => en.target.replaceChildren(h('img', { src: u, alt: item.name, draggable: 'false' }))).catch(() => {});
    }
  }, { rootMargin: '200px' });

  for (const item of S.session.index.photos) {
    const tile = h('button', { class: 'tile', 'aria-label': `Open ${item.name}`, onclick: () => openViewer(item) }, h('span', {}, item.thumbName ? '' : item.name));
    tile._item = item;
    grid.append(tile);
    if (item.thumbName) observer.observe(tile);
  }
  const wrap = h('div', { class: 'page' },
    h('div', { class: 'row' },
      h('button', { class: 'primary grow', onclick: () => { S.externalInFlight = true; pick.click(); } }, 'Add photos / screenshots'),
      h('button', { onclick: () => { S.externalInFlight = true; cam.click(); } }, 'Camera')),
    pick, cam,
    S.session.index.photos.length ? grid : h('p', { class: 'muted' }, 'No photos yet. Add some, or drop image files here.'));
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('drop'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
  wrap.addEventListener('drop', (e) => { e.preventDefault(); wrap.classList.remove('drop'); importFiles(e.dataTransfer.files); });
  return wrap;
}

async function openViewer(item) {
  let url = null;
  const img = h('img', { alt: item.name });
  const ov = h('div', { class: 'overlay viewer' });
  const close = () => { if (url) URL.revokeObjectURL(url); ov.remove(); };
  ov.append(
    h('div', { class: 'bar' },
      h('button', { onclick: close }, 'Back'),
      !SANDBOX && h('button', { onclick: async () => {
        const ok = await confirmDialog('Save a decrypted copy?', 'The copy is saved to your device unencrypted. Delete it when you no longer need it.', 'Save copy');
        if (ok && url) { const a = h('a', { href: url, download: item.name }); document.body.append(a); a.click(); a.remove(); }
      } }, 'Save copy'),
      h('button', { class: 'danger', onclick: async () => {
        if (await confirmDialog('Delete this photo?', 'It will be permanently removed from the vault.', 'Delete', true)) {
          await S.session.deletePhoto(item);
          const u = S.urls.get(item.id); if (u) { URL.revokeObjectURL(u); S.urls.delete(item.id); }
          close(); S.rerender?.();
        }
      } }, 'Delete')),
    h('div', { class: 'stage', onclick: () => ov.classList.toggle('zoomed') }, img));
  document.body.append(ov);
  try {
    const bytes = await S.session.readBlob(item.blobName);
    url = URL.createObjectURL(new Blob([bytes], { type: sniffMime(bytes, item.name) }));
    img.src = url;
  } catch (e) { toast(`Could not open the photo: ${errMsg(e)}`, true); close(); }
}

// ------------------------------------------------------------------ passwords

function passwordsView() {
  const q = h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search passwords' });
  const list = h('div', { class: 'list' });
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const items = S.session.index.passwords.filter((p) => !term || p.title.toLowerCase().includes(term) || p.username.toLowerCase().includes(term));
    list.replaceChildren(...(items.length ? items.map((p) => h('button', { class: 'card item', onclick: () => openPasswordEditor(p) },
      h('div', { class: 't' }, p.title || '(untitled)'), p.username && h('div', { class: 'muted' }, p.username))) : [h('p', { class: 'muted' }, 'Nothing here yet.')]));
  };
  q.addEventListener('input', draw);
  draw();
  return h('div', { class: 'page' }, h('button', { class: 'primary', onclick: () => openPasswordEditor(null) }, 'Add password'), q, list);
}

function openPasswordEditor(existing) {
  const isNew = !existing;
  const item = existing || { id: crypto.randomUUID(), title: '', username: '', password: '', url: '', notes: '', favourite: false, updatedAt: 0, history: [] };
  const f = (id, label, val, extra = {}) => h('input', { type: 'text', id, value: val, autocomplete: 'off', 'aria-label': label, ...extra });
  const title = f('pw-title', 'Title', item.title);
  const user = f('pw-user', 'Username', item.username, { autocapitalize: 'none', spellcheck: 'false' });
  const pass = f('pw-pass', 'Password', item.password, { autocapitalize: 'none', spellcheck: 'false' });
  const url = f('pw-url', 'Website', item.url, { autocapitalize: 'none' });
  const notes = h('textarea', { 'aria-label': 'Notes', value: item.notes });
  let shown = isNew;
  const applyShown = () => { pass.type = shown ? 'text' : 'password'; reveal.textContent = shown ? 'Hide' : 'Reveal'; };
  const reveal = h('button', { onclick: async () => {
    if (shown) { shown = false; applyShown(); } else if (await requireRecentAuth()) { shown = true; applyShown(); }
  } }, 'Reveal');
  const copy = h('button', { onclick: async () => {
    if (!(await requireRecentAuth())) return;
    await copyToClipboard(pass.value);
  } }, 'Copy');

  const len = h('input', { type: 'number', min: '8', max: '64', value: '20', 'aria-label': 'Length' });
  const gen = h('details', {}, h('summary', {}, 'Generator'),
    h('div', { class: 'stack' }, h('label', { class: 'field' }, 'Length', len),
      h('button', { onclick: () => { pass.value = core.generatePassword({ length: Math.min(64, Math.max(8, +len.value || 20)) }); shown = true; applyShown(); } }, 'Generate strong password')));

  const histBox = h('div', { class: 'stack' });
  let history = item.history.slice();
  const drawHistory = () => {
    histBox.replaceChildren();
    if (!history.length) return;
    histBox.append(h('h2', {}, `Previous passwords (${history.length})`));
    history.forEach((v) => {
      let visible = false;
      const text = h('div', { class: 'mono' }, '••••••••');
      const toggle = h('button', { onclick: async () => {
        if (visible) { visible = false; text.textContent = '••••••••'; toggle.textContent = 'Show'; }
        else if (await requireRecentAuth()) { visible = true; text.textContent = v.password; toggle.textContent = 'Hide'; }
      } }, 'Show');
      histBox.append(h('div', { class: 'card stack' }, h('div', { class: 'muted' }, `Replaced ${fmtDate(v.changedAt)}`), text,
        h('div', { class: 'row' }, toggle,
          h('button', { onclick: async () => { if (await requireRecentAuth()) await copyToClipboard(v.password); } }, 'Copy'),
          h('button', { onclick: async () => { if (await requireRecentAuth()) { pass.value = v.password; shown = true; applyShown(); toast('Restored into the form. Save to keep it.'); } } }, 'Use again'))));
    });
    histBox.append(h('button', { class: 'link danger', onclick: async () => {
      if (await confirmDialog('Clear password history?', 'The previous passwords of this entry are permanently deleted. The current one is kept.', 'Clear', true)) {
        await S.session.clearHistory(item.id); history = []; drawHistory();
      }
    } }, 'Clear history'));
  };
  drawHistory();

  const ov = h('div', { class: 'overlay' });
  const close = () => ov.remove();
  ov.append(h('main', { class: 'page' },
    h('h1', {}, isNew ? 'New password' : 'Edit password'),
    h('label', { class: 'field' }, 'Title', title),
    h('label', { class: 'field' }, 'Username', user),
    h('label', { class: 'field' }, 'Password', pass),
    h('div', { class: 'row' }, reveal, copy), gen,
    h('label', { class: 'field' }, 'Website', url),
    h('label', { class: 'field' }, 'Notes', notes),
    histBox,
    h('button', { class: 'primary', onclick: async () => {
      if (!title.value.trim()) { toast('Give it a title.', true); return; }
      await S.session.upsertPassword({ ...item, title: title.value.trim(), username: user.value.trim(), password: pass.value, url: url.value.trim(), notes: notes.value }, S.settings.keepHistory);
      close(); S.rerender?.();
    } }, 'Save'),
    h('button', { onclick: close }, 'Cancel'),
    !isNew && h('button', { class: 'link danger', onclick: async () => {
      if (await confirmDialog('Delete this password?', 'It is permanently removed from the vault.', 'Delete', true)) { await S.session.deletePassword(item.id); close(); S.rerender?.(); }
    } }, 'Delete')));
  applyShown();
  document.body.append(ov);
  title.focus();
}

let clipTimer;
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied. The clipboard is cleared in 30 s.');
    clearTimeout(clipTimer);
    clipTimer = setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 30_000);
  } catch { toast('Copying is not allowed here. Reveal the password and copy it by hand.', true); }
}

// ------------------------------------------------------------------ settings

/** Sandboxed frames cannot save files, so the encrypted backup is offered as text to copy somewhere safe. */
async function showBackupText(bytes) {
  const text = toBase64(bytes);
  const area = h('textarea', { readOnly: true, spellcheck: 'false', 'aria-label': 'Encrypted backup text', value: text });
  area.addEventListener('focus', () => area.select());
  await dialog({ title: 'Encrypted backup', body: h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `${(text.length / 1024).toFixed(0)} KB of text. It is encrypted: store it anywhere, but you need your recovery key to restore it.`), area),
  actions: [{ label: 'Close', value: false }, { label: 'Copy', kind: 'primary', value: true, validate: async () => {
    try { await navigator.clipboard.writeText(text); toast('Backup text copied.'); } catch { area.focus(); toast('Select the text and copy it by hand.', true); }
    return false;
  } }] });
}

function settingsView() {
  const dev = S.meta.device;
  const hasRecovery = !!S.meta.recoveryWrap;
  const sec = (title, ...kids) => h('section', { class: 'card stack' }, h('h2', {}, title), ...kids);

  const autolock = h('select', { 'aria-label': 'Auto-lock', onchange: async (e) => {
    S.settings.autoLockSeconds = +e.target.value; await V.saveSettings(S.db, S.settings);
  } }, [[0, 'Immediately when I leave the app'], [30, 'After 30 seconds away'], [60, 'After 1 minute away'], [300, 'After 5 minutes away']]
    .map(([v, l]) => h('option', { value: String(v), selected: S.settings.autoLockSeconds === v }, l)));

  const keepHist = h('input', { type: 'checkbox', checked: S.settings.keepHistory, id: 'keep-hist', onchange: async (e) => {
    S.settings.keepHistory = e.target.checked; await V.saveSettings(S.db, S.settings);
  } });

  const methods = [];
  const refresh = async () => { S.meta = await V.readMeta(S.db); S.rerender(); };
  const count = Number(!!dev.prf) + Number(!!dev.pass);
  methods.push(h('div', { class: 'row split' }, h('span', {}, `Fingerprint / screen lock: ${dev.prf ? 'on' : 'off'}`),
    h('div', { class: 'row' },
      webauthnPossible() && h('button', { onclick: async () => {
        if (!(await requireRecentAuth())) return;
        try {
          const prf = await busy('Waiting for your fingerprint or screen lock…', enrollPrf);
          await V.saveDevice(S.db, { ...S.meta.device, prf: await V.makePrfWrap(S.session.vmk, prf) });
          await refresh(); toast('Passkey saved.');
        } catch (e) { toast(errMsg(e), true); }
      } }, dev.prf ? 'Replace' : 'Turn on'),
      dev.prf && count > 1 && h('button', { class: 'danger', onclick: async () => {
        if (!(await requireRecentAuth())) return;
        const { prf, ...rest } = S.meta.device; await V.saveDevice(S.db, rest); await refresh();
      } }, 'Turn off'))));
  methods.push(h('div', { class: 'row split' }, h('span', {}, `Passphrase: ${dev.pass ? 'on' : 'off'}`),
    h('div', { class: 'row' },
      h('button', { onclick: async () => {
        if (!(await requireRecentAuth())) return;
        const a = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New passphrase' });
        const b = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Repeat passphrase' });
        const e = h('p', { class: 'error', role: 'alert' });
        const ok = await dialog({ title: dev.pass ? 'Change passphrase' : 'Add a passphrase', body: h('div', { class: 'stack' },
          h('label', { class: 'field' }, 'Passphrase (at least 12 characters)', a), h('label', { class: 'field' }, 'Repeat', b), e),
        actions: [{ label: 'Cancel', value: false }, { label: 'Save', kind: 'primary', value: true, validate: () => {
          if (a.value.length < 12) { e.textContent = 'At least 12 characters.'; return false; }
          if (a.value !== b.value) { e.textContent = 'The two entries differ.'; return false; }
          return true; } }] });
        if (!ok) return;
        const wrap = await busy('Securing your passphrase…', () => V.makePassWrap(S.session.vmk, a.value));
        await V.saveDevice(S.db, { ...S.meta.device, pass: wrap }); await refresh(); toast('Passphrase saved.');
      } }, dev.pass ? 'Change' : 'Add'),
      dev.pass && count > 1 && h('button', { class: 'danger', onclick: async () => {
        if (!(await requireRecentAuth())) return;
        const { pass, ...rest } = S.meta.device; await V.saveDevice(S.db, rest); await refresh();
      } }, 'Remove'))));

  const backupBtn = h('button', { disabled: !hasRecovery, onclick: async () => {
    if (!(await requireRecentAuth())) return;
    try {
      const parts = await busy('Building backup…', () => S.session.buildBackup(S.meta.recoveryWrap));
      if (SANDBOX) { await showBackupText(core.concat(...parts)); return; }
      const d = new Date(), p = (n) => String(n).padStart(2, '0');
      download(parts, `my-safe-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.msbk`);
      toast('Encrypted backup downloaded. Restoring it needs your recovery key.');
    } catch (e) { toast(`Backup failed: ${errMsg(e)}`, true); }
  } }, SANDBOX ? 'Copy backup as text' : 'Download encrypted backup');

  const persistState = h('p', { class: 'muted' }, 'Checking storage…');
  navigator.storage?.persisted?.().then((p) => { persistState.textContent = p ? 'Storage is marked persistent: the browser will not clear it automatically.' : 'The browser may clear this data when space is low. Make backups.'; }).catch(() => {});

  return h('div', { class: 'page' },
    sec('Auto-lock', autolock, h('p', { class: 'muted' }, 'The vault also locks after 10 minutes without use, and the screen is hidden in the app switcher.')),
    sec('Password history', h('label', { class: 'check', for: 'keep-hist' }, keepHist, h('span', {}, 'Keep the last 10 passwords of each entry, encrypted like everything else.'))),
    sec('Unlock methods', ...methods, h('p', { class: 'muted' }, 'Passkeys are tied to this site\'s address. If you move the app to another address, unlock with your recovery key and set them up again.')),
    sec('Recovery key',
      hasRecovery ? h('p', { class: 'muted' }, 'A recovery key exists. It is not stored here, so it cannot be shown again. You can replace it with a new one; older backups still need the key they were made with.')
        : h('p', { class: 'error' }, 'You skipped the recovery key. If you lose your passkey or passphrase, this vault is lost. Create one now.'),
      h('button', { onclick: async () => {
        if (!(await requireRecentAuth())) return;
        const rk = core.RecoveryKey.generate();
        const ok = await dialog({ title: 'Your new recovery key', body: h('div', { class: 'stack' },
          h('p', {}, 'Write it down now. It will not be shown again.'), h('div', { class: 'rkey' }, rk.groups().map((g) => h('span', {}, g)))),
        actions: [{ label: 'Cancel', value: false }, { label: 'I have saved it', kind: 'primary', value: true }] });
        if (!ok) return;
        await V.saveRecoveryWrap(S.db, await core.wrapWithRecovery(S.session.vmk, rk));
        await refresh(); toast('Recovery key saved.');
      } }, hasRecovery ? 'Generate a new recovery key' : 'Create a recovery key')),
    sec('Backup', h('p', { class: 'muted' }, 'One encrypted file you can keep anywhere. It works with the My-Safe Android app too.'),
      !hasRecovery && h('p', { class: 'error' }, 'Create a recovery key first: backups can only be restored with one.'), backupBtn),
    sec('This browser', persistState,
      navigator.storage?.persist && h('button', { onclick: async () => { toast((await navigator.storage.persist()) ? 'Storage is now persistent.' : 'The browser declined. Installing the app to your home screen often helps.'); S.rerender(); } }, 'Ask the browser to keep the data')),
    sec('Erase', h('button', { class: 'danger', onclick: eraseEverything }, 'Erase the vault from this browser')),
    h('p', { class: 'muted' }, 'My-Safe web 0.1.0 · no network requests · all data stays in this browser. A website cannot block screenshots; see the README for the security differences from the Android app.'));
}

// ------------------------------------------------------------------ auto-lock

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    document.body.classList.add('privacy');
    S.hiddenAt = Date.now();
    if (S.session && S.settings.autoLockSeconds === 0 && !S.externalInFlight) lock();
  } else {
    document.body.classList.remove('privacy');
    if (S.session && S.hiddenAt && !S.externalInFlight && Date.now() - S.hiddenAt >= S.settings.autoLockSeconds * 1000) lock();
    S.hiddenAt = 0; S.externalInFlight = false;
  }
});
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => { S.lastActivity = Date.now(); }, { passive: true });
setInterval(() => { if (S.session && Date.now() - S.lastActivity > 10 * 60_000) lock(); }, 15_000);

boot().catch((e) => mount(page(h('h1', {}, 'My-Safe'), h('p', { class: 'error' }, `Could not start: ${errMsg(e)}`), h('p', { class: 'muted' }, 'This app needs IndexedDB and Web Crypto, and must be served over HTTPS (or localhost).'))));
