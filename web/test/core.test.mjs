import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from '../js/core.js';
import * as V from '../js/vault.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => join(here, 'fixtures', n);
const photo = Uint8Array.from({ length: 150_000 }, (_, i) => (i * 31 + 7) % 251);
const thumb = Uint8Array.from({ length: 700 }, (_, i) => i % 256);

test('seal/open round trip, aad and tamper detection', async () => {
  const k = core.randomBytes(32);
  const s = await core.seal(k, core.utf8('hello'), Uint8Array.of(1));
  assert.deepEqual(await core.open(k, s, Uint8Array.of(1)), core.utf8('hello'));
  await assert.rejects(core.open(k, s, Uint8Array.of(2)), core.VaultCryptoError);
  await assert.rejects(core.open(core.randomBytes(32), s, Uint8Array.of(1)), core.VaultCryptoError);
  s[s.length - 1] ^= 1;
  await assert.rejects(core.open(k, s, Uint8Array.of(1)), core.VaultCryptoError);
});

test('recovery key format, parse and wrap', async () => {
  const rk = core.RecoveryKey.generate();
  const text = rk.format();
  assert.equal(text.split('-').length, 13);
  assert.ok(text.split('-').every((g) => g.length === 4));
  const parsed = core.RecoveryKey.parse(text.toLowerCase().replaceAll('-', ' '));
  assert.deepEqual(parsed.bytes, rk.bytes);
  assert.throws(() => core.RecoveryKey.parse('ABCD'));
  assert.throws(() => core.RecoveryKey.parse('1'.repeat(52)));
  const vmk = core.newMasterKey();
  const w = await core.wrapWithRecovery(vmk, rk);
  assert.deepEqual(await core.unwrapWithRecovery(w, rk), vmk);
  await assert.rejects(core.unwrapWithRecovery(w, core.RecoveryKey.generate()), core.VaultCryptoError);
});

test('blob round trip across chunk boundaries', async () => {
  const kek = core.randomBytes(32);
  for (const n of [0, 1, core.CHUNK - 1, core.CHUNK, core.CHUNK + 1, 3 * core.CHUNK, 3 * core.CHUNK + 17]) {
    const plain = core.randomBytes(n);
    assert.deepEqual(await core.decryptBlob(kek, await core.encryptBlob(kek, plain)), plain, `size ${n}`);
  }
});

test('blob detects truncation, tampering and reordering', async () => {
  const kek = core.randomBytes(32);
  const enc = await core.encryptBlob(kek, core.randomBytes(3 * core.CHUNK));
  const header = enc.length - 3 * (core.CHUNK + 16);
  await assert.rejects(core.decryptBlob(kek, enc.slice(0, enc.length - (core.CHUNK + 16))), core.VaultCryptoError); // dropped last chunk
  const bad = enc.slice(); bad[header + 5] ^= 1;
  await assert.rejects(core.decryptBlob(kek, bad), core.VaultCryptoError);
  const sw = enc.slice();
  const c = core.CHUNK + 16;
  sw.set(enc.subarray(header + c, header + 2 * c), header);
  sw.set(enc.subarray(header, header + c), header + c);
  await assert.rejects(core.decryptBlob(kek, sw), core.VaultCryptoError);
  await assert.rejects(core.decryptBlob(core.randomBytes(32), enc), core.VaultCryptoError);
});

test('password history rules match the Android store', () => {
  let p = core.applyPasswordChange(null, { id: 'p', title: 'S', username: 'u', password: 'one' });
  p = core.applyPasswordChange(p, { ...p, password: 'two' });
  p = core.applyPasswordChange(p, { ...p, title: 'renamed' }); // unchanged password: nothing added
  p = core.applyPasswordChange(p, { ...p, password: 'three' });
  assert.deepEqual(p.history.map((h) => h.password), ['two', 'one']);
  for (let i = 0; i < 15; i++) p = core.applyPasswordChange(p, { ...p, password: `p${i}` });
  assert.equal(p.history.length, 10);
  const off = core.applyPasswordChange(p, { ...p, password: 'x' }, { keepHistory: false });
  assert.equal(off.history[0].password, p.history[0].password);
  const forged = core.applyPasswordChange(null, { id: 'f', title: 't', username: 'u', password: 'a', history: [{ password: 'forged', changedAt: 1 }] });
  assert.equal(forged.history.length, 0);
});

test('password generator honours classes', () => {
  for (let i = 0; i < 50; i++) {
    const p = core.generatePassword({ length: 12 });
    assert.equal(p.length, 12);
    assert.ok(/[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p));
  }
  assert.ok(/^[a-z]{30}$/.test(core.generatePassword({ length: 30, upper: false, digits: false, symbols: false })));
  assert.throws(() => core.generatePassword({ upper: false, lower: false, digits: false, symbols: false }));
});

test('index v1 (no history) still loads', () => {
  // hand-built version 1 index, as written by the first Android release
  const parts = [];
  const i32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v); parts.push(b); };
  const str = (s) => { const b = core.utf8(s); i32(b.length); parts.push(b); };
  parts.push(Uint8Array.of(1)); i32(0); i32(1);
  str('id1'); str('Bank'); str('alice'); str('pw'); str('https://b'); str('n');
  parts.push(Uint8Array.of(1)); const t = new Uint8Array(8); new DataView(t.buffer).setBigInt64(0, 42n); parts.push(t);
  const idx = core.indexFromBytes(core.concat(...parts));
  assert.equal(idx.passwords[0].password, 'pw');
  assert.equal(idx.passwords[0].updatedAt, 42);
  assert.deepEqual(idx.passwords[0].history, []);
});

test('Android backup fixture restores in the browser code', async () => {
  const bytes = new Uint8Array(readFileSync(fx('android-backup.msbk')));
  const rk = core.RecoveryKey.parse(readFileSync(fx('android-backup.key.txt'), 'utf8').trim());
  const b = await core.parseBackup(bytes, rk);
  const kek = await core.fileKek(b.vmk);
  const item = b.index.photos[0];
  assert.equal(item.name, 'café ✓.jpg');
  assert.deepEqual(await core.decryptBlob(kek, b.blobs.get(item.blobName)), photo);
  assert.deepEqual(await core.decryptBlob(kek, b.blobs.get(item.thumbName)), thumb);
  const pw = b.index.passwords[0];
  assert.equal(pw.title, 'Café ✓');
  assert.equal(pw.password, 'new-secret');
  assert.equal(pw.notes, 'notes ü');
  assert.deepEqual(pw.history.map((h) => h.password), ['old-secret']);
  await assert.rejects(core.parseBackup(bytes, core.RecoveryKey.generate()), core.VaultCryptoError);
  await assert.rejects(core.parseBackup(bytes.slice(0, bytes.length - 100), rk), core.VaultCryptoError);
});

test('builds a web backup the Android tests can restore', async () => {
  const vmk = core.newMasterKey();
  const rk = core.RecoveryKey.generate();
  const kek = await core.fileKek(vmk);
  const id = '11111111-2222-3333-4444-555555555555';
  const idx = core.emptyIndex();
  idx.photos.push({ id, name: 'wéb.jpg', addedAt: 1700000000000, blobName: `${id}.msb`, thumbName: `${id}.thumb.msb`, tags: [] });
  let pw = core.applyPasswordChange(null, { id: 'p1', title: 'Wéb Bank ✓', username: 'bob', password: 'w1', url: '', notes: '' });
  pw = core.applyPasswordChange(pw, { ...pw, password: 'w2' });
  idx.passwords.push(pw);
  const parts = core.buildBackup({
    recoveryWrap: await core.wrapWithRecovery(vmk, rk),
    sealedIndex: await core.sealIndex(vmk, idx),
    blobs: [
      { name: `${id}.msb`, bytes: await core.encryptBlob(kek, photo) },
      { name: `${id}.thumb.msb`, bytes: await core.encryptBlob(kek, thumb) },
    ],
  });
  const bytes = core.concat(...parts);
  // Only rewrite the committed fixture on request (WRITE_FIXTURES=1); the Android test restores it.
  if (process.env.WRITE_FIXTURES) {
    writeFileSync(fx('web-backup.msbk'), bytes);
    writeFileSync(fx('web-backup.key.txt'), rk.format());
  }
  const again = await core.parseBackup(bytes, rk);
  assert.equal(again.index.passwords[0].history[0].password, 'w1');
});

test('committed web fixture is still readable', async () => {
  const b = await core.parseBackup(new Uint8Array(readFileSync(fx('web-backup.msbk'))), core.RecoveryKey.parse(readFileSync(fx('web-backup.key.txt'), 'utf8').trim()));
  assert.equal(b.index.passwords[0].password, 'w2');
  assert.deepEqual(b.index.passwords[0].history.map((h) => h.password), ['w1']);
  assert.deepEqual(await core.decryptBlob(await core.fileKek(b.vmk), b.blobs.get(b.index.photos[0].blobName)), photo);
});

test('vault file: build, parse, unlock with the passphrase, read everything back', async () => {
  const vmk = core.newMasterKey();
  const kek = await core.fileKek(vmk);
  const idx = core.emptyIndex();
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  idx.photos.push({ id, name: 'p.png', addedAt: 5, blobName: `${id}.msb`, thumbName: `${id}.thumb.msb`, tags: [] });
  idx.passwords.push(core.applyPasswordChange(null, { id: 'p1', title: 'T', username: 'u', password: 'pw', url: '', notes: '' }));
  const pass = await V.makePassWrap(vmk, 'a long passphrase here', 1000); // few rounds: speed
  const parts = core.buildVaultFile({
    pass, recoveryWrap: await core.wrapWithRecovery(vmk, core.RecoveryKey.generate()), sealedIndex: await core.sealIndex(vmk, idx),
    blobs: [{ name: `${id}.msb`, bytes: await core.encryptBlob(kek, photo) }, { name: `${id}.thumb.msb`, bytes: await core.encryptBlob(kek, thumb) }],
  });
  const bytes = core.concat(...parts);
  const f = core.parseVaultFile(bytes);
  assert.equal(f.pass.iterations, 1000);
  assert.ok(f.recoveryWrap);
  await assert.rejects(V.openPassWrap(f.pass, 'wrong passphrase!!'), core.VaultCryptoError);
  const vmk2 = await V.openPassWrap(f.pass, 'a long passphrase here');
  assert.deepEqual(vmk2, vmk);
  const idx2 = await core.openIndex(vmk2, f.sealedIndex);
  assert.equal(idx2.passwords[0].password, 'pw');
  assert.deepEqual(await core.decryptBlob(await core.fileKek(vmk2), f.blobs.get(idx2.photos[0].blobName)), photo);
});

test('vault file: no recovery key is allowed; garbage and truncation are rejected', async () => {
  const vmk = core.newMasterKey();
  const bytes = core.concat(...core.buildVaultFile({ pass: await V.makePassWrap(vmk, 'x'.repeat(14), 1000), recoveryWrap: null,
    sealedIndex: await core.sealIndex(vmk, core.emptyIndex()), blobs: [] }));
  assert.equal(core.parseVaultFile(bytes).recoveryWrap, null);
  assert.throws(() => core.parseVaultFile(core.utf8('not a vault file at all')), core.VaultCryptoError);
  assert.throws(() => core.parseVaultFile(bytes.slice(0, bytes.length - 30)), core.VaultCryptoError);
  assert.throws(() => core.parseVaultFile(new Uint8Array(0)), core.VaultCryptoError);
  // a .msbk backup is not a vault file
  assert.throws(() => core.parseVaultFile(new Uint8Array(readFileSync(fx('android-backup.msbk')))), core.VaultCryptoError);
});

test('in-memory storage behaves like IndexedDB storage', async () => {
  const db = V.openMemoryDb();
  await V.dbPut(db, 'meta', 'k', 1); await V.dbPut(db, 'blobs', 'b', Uint8Array.of(1, 2));
  assert.equal(await V.dbGet(db, 'meta', 'k'), 1);
  await V.dbDel(db, 'meta', 'k');
  assert.equal(await V.dbGet(db, 'meta', 'k'), undefined);
  await V.dbClear(db, 'blobs');
  assert.equal(await V.dbGet(db, 'blobs', 'b'), undefined);
  const vmk = core.newMasterKey();
  const idx = core.emptyIndex();
  await V.createVault(db, { vmk, device: { pass: await V.makePassWrap(vmk, 'y'.repeat(13), 1000) }, recoveryWrap: null, index: idx });
  const meta = await V.readMeta(db);
  assert.equal(meta.exists, true);
  const sess = await V.Session.open(db, vmk.slice(), meta.sealedIndex);
  let changes = 0; sess.onChange = () => { changes++; };
  await sess.upsertPassword({ id: 'q', title: 'Q', username: '', password: 'a', url: '', notes: '' }, true);
  await sess.addPhoto('x.png', photo, thumb);
  assert.equal(changes, 2);
  assert.equal((await V.readMeta(db)).sealedIndex.length > meta.sealedIndex.length, true);
});
