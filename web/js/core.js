// My-Safe core: key hierarchy, recovery key, streaming file encryption, index and backup formats.
// Byte-compatible with the Android app's `vaultcore` module, so backups move between the two.
// Pure WebCrypto, no dependencies; runs in browsers and in Node 20+.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

export class VaultCryptoError extends Error {}

export const CHUNK = 64 * 1024;
const TAG = 16;
const NONCE = 12;
const EMPTY = new Uint8Array(0);

export function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) globalThis.crypto.getRandomValues(out.subarray(o, Math.min(n, o + 65536))); // 64 KiB per call limit
  return out;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const utf8 = (s) => te.encode(s);

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

const aesKey = (raw, usage) => subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);

/** Returns nonce || ciphertext || tag. */
export async function seal(key, plain, aad = EMPTY) {
  const iv = randomBytes(NONCE);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, await aesKey(key, 'encrypt'), plain);
  return concat(iv, new Uint8Array(ct));
}

export async function open(key, sealed, aad = EMPTY) {
  if (sealed.length < NONCE + TAG) throw new VaultCryptoError('Ciphertext too short');
  try {
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.subarray(0, NONCE), additionalData: aad, tagLength: 128 },
      await aesKey(key, 'decrypt'), sealed.subarray(NONCE));
    return new Uint8Array(pt);
  } catch {
    throw new VaultCryptoError('Authentication failed (wrong key or corrupted data)');
  }
}

/** HKDF-SHA256, zero salt, 32 bytes out (same as the Android implementation). */
export async function hkdf(ikm, info) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(info) }, k, 256);
  return new Uint8Array(bits);
}

export async function pbkdf2(passphrase, salt, iterations) {
  const k = await subtle.importKey('raw', te.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, k, 256));
}

// ---------------------------------------------------------------- recovery key

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const GROUP_LEN = 4;
export const GROUP_COUNT = 13;

export class RecoveryKey {
  constructor(bytes) { this.bytes = bytes; }
  static generate() { return new RecoveryKey(randomBytes(32)); }

  /** Accepts any case; ignores spaces, dashes and line breaks. */
  static parse(text) {
    const clean = text.toUpperCase().replace(/[-\s]/g, '');
    if (clean.length !== GROUP_LEN * GROUP_COUNT) throw new Error('Recovery key must have 52 characters');
    let acc = 0, bits = 0;
    const out = [];
    for (const ch of clean) {
      const v = B32.indexOf(ch);
      if (v < 0) throw new Error(`Invalid character '${ch}' in recovery key`);
      acc = (acc << 5) | v; bits += 5;
      if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); acc &= (1 << bits) - 1; }
    }
    if (acc !== 0) throw new Error('Invalid recovery key');
    return new RecoveryKey(Uint8Array.from(out));
  }

  groups() {
    let s = '', acc = 0, bits = 0;
    for (const b of this.bytes) {
      acc = (acc << 8) | b; bits += 8;
      while (bits >= 5) { bits -= 5; s += B32[(acc >> bits) & 31]; }
      acc &= (1 << bits) - 1;
    }
    if (bits > 0) s += B32[(acc << (5 - bits)) & 31];
    return s.match(/.{4}/g);
  }

  format() { return this.groups().join('-'); }
  wrapKey() { return hkdf(this.bytes, 'mysafe/recovery-wrap/v1'); }
  wipe() { this.bytes.fill(0); }
}

// ---------------------------------------------------------------- key hierarchy

const RECOVERY_AAD = utf8('mysafe-vmk-recovery-v1');
export const INDEX_AAD = utf8('mysafe-index-v1');
const DEK_AAD = utf8('mysafe-dek-v1');

export const newMasterKey = () => randomBytes(32);
export const indexKey = (vmk) => hkdf(vmk, 'mysafe/index/v1');
export const fileKek = (vmk) => hkdf(vmk, 'mysafe/file-kek/v1');

export async function wrapWithRecovery(vmk, rk) { return seal(await rk.wrapKey(), vmk, RECOVERY_AAD); }
export async function unwrapWithRecovery(wrapped, rk) { return open(await rk.wrapKey(), wrapped, RECOVERY_AAD); }

// ---------------------------------------------------------------- streaming blob cipher

const MAGIC = utf8('MSB1');
const PREFIX_LEN = 7;

function chunkNonce(prefix, counter, last) {
  const n = new Uint8Array(NONCE);
  n.set(prefix, 0);
  new DataView(n.buffer).setUint32(PREFIX_LEN, counter, false);
  n[11] = last ? 1 : 0;
  return n;
}

/** Layout: "MSB1" | u16 wrappedDekLen | wrappedDek | 7-byte nonce prefix | chunks (64 KiB + 16-byte tag). */
export async function encryptBlob(kek, plain) {
  const dek = randomBytes(32);
  const wrapped = await seal(kek, dek, DEK_AAD);
  const prefix = randomBytes(PREFIX_LEN);
  const key = await aesKey(dek, 'encrypt');
  const head = new Uint8Array(MAGIC.length + 2 + wrapped.length + PREFIX_LEN);
  head.set(MAGIC, 0);
  new DataView(head.buffer).setUint16(MAGIC.length, wrapped.length, false);
  head.set(wrapped, MAGIC.length + 2);
  head.set(prefix, MAGIC.length + 2 + wrapped.length);
  const parts = [head];
  const count = Math.max(1, Math.ceil(plain.length / CHUNK));
  for (let i = 0; i < count; i++) {
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv: chunkNonce(prefix, i, i === count - 1), tagLength: 128 },
      key, plain.subarray(i * CHUNK, Math.min(plain.length, (i + 1) * CHUNK)));
    parts.push(new Uint8Array(ct));
  }
  dek.fill(0);
  return concat(...parts);
}

export async function decryptBlob(kek, blob) {
  if (blob.length < MAGIC.length + 2 || !equalBytes(blob.subarray(0, 4), MAGIC)) throw new VaultCryptoError('Not a My-Safe file');
  const wlen = new DataView(blob.buffer, blob.byteOffset).getUint16(4, false);
  const hdr = 6 + wlen + PREFIX_LEN;
  if (blob.length < hdr + TAG) throw new VaultCryptoError('Truncated file');
  const dek = await open(kek, blob.subarray(6, 6 + wlen), DEK_AAD);
  const prefix = blob.subarray(6 + wlen, hdr);
  const key = await aesKey(dek, 'decrypt');
  dek.fill(0);
  const body = blob.subarray(hdr);
  const enc = CHUNK + TAG;
  const count = Math.ceil(body.length / enc);
  const parts = [];
  try {
    for (let i = 0; i < count; i++) {
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: chunkNonce(prefix, i, i === count - 1), tagLength: 128 },
        key, body.subarray(i * enc, Math.min(body.length, (i + 1) * enc)));
      parts.push(new Uint8Array(pt));
    }
  } catch {
    throw new VaultCryptoError('Authentication failed (wrong key or corrupted data)');
  }
  return concat(...parts);
}

// ---------------------------------------------------------------- index (metadata + passwords)

class W {
  constructor() { this.parts = []; }
  u8(v) { this.parts.push(Uint8Array.of(v)); }
  i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, false); this.parts.push(b); }
  i64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), false); this.parts.push(b); }
  bool(v) { this.u8(v ? 1 : 0); }
  str(s) { const b = te.encode(s); this.i32(b.length); this.parts.push(b); }
  bytes() { return concat(...this.parts); }
}

class R {
  constructor(b) { this.b = b; this.o = 0; this.v = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  need(n) { if (this.o + n > this.b.length) throw new VaultCryptoError('Corrupt data'); }
  u8() { this.need(1); return this.b[this.o++]; }
  i32() { this.need(4); const v = this.v.getInt32(this.o, false); this.o += 4; return v; }
  i64() { this.need(8); const v = Number(this.v.getBigInt64(this.o, false)); this.o += 8; return v; }
  bool() { return this.u8() !== 0; }
  str() {
    const n = this.i32();
    if (n < 0 || n > 16 * 1024 * 1024) throw new VaultCryptoError('Corrupt string length');
    this.need(n);
    const s = td.decode(this.b.subarray(this.o, this.o + n)); this.o += n; return s;
  }
}

export const MAX_HISTORY = 10;

export function emptyIndex() { return { photos: [], passwords: [] }; }

export function indexToBytes(idx) {
  const w = new W();
  w.u8(2);
  w.i32(idx.photos.length);
  for (const p of idx.photos) {
    w.str(p.id); w.str(p.name); w.i64(p.addedAt); w.str(p.blobName); w.str(p.thumbName || '');
    w.i32((p.tags || []).length); (p.tags || []).forEach((t) => w.str(t));
  }
  w.i32(idx.passwords.length);
  for (const p of idx.passwords) {
    w.str(p.id); w.str(p.title); w.str(p.username); w.str(p.password); w.str(p.url || ''); w.str(p.notes || '');
    w.bool(!!p.favourite); w.i64(p.updatedAt || 0);
    w.i32((p.history || []).length);
    for (const h of p.history || []) { w.str(h.password); w.i64(h.changedAt); }
  }
  return w.bytes();
}

export function indexFromBytes(bytes) {
  const r = new R(bytes);
  const v = r.u8();
  if (v !== 1 && v !== 2) throw new VaultCryptoError(`Unsupported index version ${v}`);
  const idx = emptyIndex();
  for (let n = r.i32(); n > 0; n--) {
    const p = { id: r.str(), name: r.str(), addedAt: r.i64(), blobName: r.str(), thumbName: r.str() || null, tags: [] };
    for (let t = r.i32(); t > 0; t--) p.tags.push(r.str());
    idx.photos.push(p);
  }
  for (let n = r.i32(); n > 0; n--) {
    const p = { id: r.str(), title: r.str(), username: r.str(), password: r.str(), url: r.str(), notes: r.str(),
      favourite: r.bool(), updatedAt: r.i64(), history: [] };
    if (v >= 2) for (let h = r.i32(); h > 0; h--) p.history.push({ password: r.str(), changedAt: r.i64() });
    idx.passwords.push(p);
  }
  return idx;
}

export const sealIndex = async (vmk, idx) => seal(await indexKey(vmk), indexToBytes(idx), INDEX_AAD);
export const openIndex = async (vmk, sealed) => indexFromBytes(await open(await indexKey(vmk), sealed, INDEX_AAD));

// ---------------------------------------------------------------- password history & generator

/** Returns the saved item. Mirrors VaultStore.upsertPassword: caller-supplied history is ignored. */
export function applyPasswordChange(existing, item, { keepHistory = true, maxVersions = MAX_HISTORY } = {}) {
  let history = existing ? existing.history.slice() : [];
  if (existing && keepHistory && existing.password !== item.password) {
    history = [{ password: existing.password, changedAt: existing.updatedAt }, ...history].slice(0, maxVersions);
  }
  return { ...item, updatedAt: Date.now(), history };
}

const CLASSES = { upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower: 'abcdefghijkmnopqrstuvwxyz', digits: '23456789', symbols: '!@#$%^&*()-_=+[]{};:,.?' };

function randomBelow(n) { // unbiased
  const lim = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(buf); } while (buf[0] >= lim);
  return buf[0] % n;
}

export function generatePassword({ length = 20, upper = true, lower = true, digits = true, symbols = true } = {}) {
  const sets = Object.entries({ upper, lower, digits, symbols }).filter(([, on]) => on).map(([k]) => CLASSES[k]);
  if (!sets.length) throw new Error('Select at least one character class');
  if (length < sets.length) throw new Error('Length too short');
  const all = sets.join('');
  const chars = sets.map((s) => s[randomBelow(s.length)]);
  while (chars.length < length) chars.push(all[randomBelow(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomBelow(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

// ---------------------------------------------------------------- backup file (.msbk)

const BK_MAGIC = utf8('MSBK1');
const i32b = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, false); return b; };
const u16b = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, false); return b; };
const i64b = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), false); return b; };

export const SAFE_BLOB_NAME = /^[A-Za-z0-9._-]{1,80}\.msb$/;

/** blobs: [{ name, bytes }]. Returns an array of parts suitable for `new Blob(parts)`. */
export function buildBackup({ recoveryWrap, sealedIndex, blobs }) {
  const parts = [BK_MAGIC, i32b(recoveryWrap.length), recoveryWrap, i32b(sealedIndex.length), sealedIndex, i32b(blobs.length)];
  for (const b of blobs) {
    const name = utf8(b.name); // names are ASCII, so modified-UTF-8 equals UTF-8
    parts.push(u16b(name.length), name, i64b(b.bytes.length), b.bytes);
  }
  return parts;
}

/** Verifies and decrypts a backup. Returns { vmk, recoveryWrap, sealedIndex, index, blobs: Map(name -> bytes) }. */
export async function parseBackup(bytes, recoveryKey) {
  const r = new R(bytes);
  const take = (n) => { r.need(n); const s = bytes.subarray(r.o, r.o + n); r.o += n; return s; };
  if (!equalBytes(take(5), BK_MAGIC)) throw new VaultCryptoError('Not a My-Safe backup');
  const chunk = () => { const n = r.i32(); if (n < 0 || n > 512 * 1024 * 1024) throw new VaultCryptoError('Corrupt backup'); return take(n); };
  const recoveryWrap = chunk().slice();
  const vmk = await unwrapWithRecovery(recoveryWrap, recoveryKey);
  const sealedIndex = chunk().slice();
  const index = await openIndex(vmk, sealedIndex);
  const blobs = new Map();
  for (let n = r.i32(); n > 0; n--) {
    const nameLen = new DataView(take(2).slice().buffer).getUint16(0, false);
    const name = td.decode(take(nameLen));
    const len = r.i64();
    if (!SAFE_BLOB_NAME.test(name) || len < 0) throw new VaultCryptoError('Corrupt backup');
    blobs.set(name, take(len).slice());
  }
  const missing = index.photos.flatMap((p) => [p.blobName, p.thumbName].filter(Boolean)).filter((n) => !blobs.has(n));
  if (missing.length) throw new VaultCryptoError(`Backup is incomplete (${missing.length} files missing)`);
  return { vmk, recoveryWrap, sealedIndex, index, blobs };
}
