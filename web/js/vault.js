// Encrypted vault on top of IndexedDB. Everything stored is ciphertext except non-sensitive settings.
import * as core from './core.js';

const DB_NAME = 'mysafe';
const DEVICE_AAD = core.utf8('mysafe-vmk-device-v1');
export const PBKDF2_ITERATIONS = 600_000;

export const DEFAULT_SETTINGS = { autoLockSeconds: 30, keepHistory: true };

// ------------------------------------------------------------ tiny IndexedDB wrapper

export function openDb(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('meta'); req.result.createObjectStore('blobs'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** In-memory storage with the same interface: used for "vault file" mode, where nothing is kept in the browser. */
export function openMemoryDb() {
  return { memory: true, stores: { meta: new Map(), blobs: new Map() } };
}

const run = (db, store, mode, fn) => new Promise((resolve, reject) => {
  const t = db.transaction(store, mode);
  const r = fn(t.objectStore(store));
  t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
  t.onerror = () => reject(t.error);
  t.onabort = () => reject(t.error);
});

export const dbGet = (db, store, key) => (db.memory ? Promise.resolve(db.stores[store].get(key)) : run(db, store, 'readonly', (s) => s.get(key)));
export const dbPut = (db, store, key, val) => (db.memory ? Promise.resolve(void db.stores[store].set(key, val)) : run(db, store, 'readwrite', (s) => s.put(val, key)));
export const dbDel = (db, store, key) => (db.memory ? Promise.resolve(void db.stores[store].delete(key)) : run(db, store, 'readwrite', (s) => s.delete(key)));
export const dbClear = (db, store) => (db.memory ? Promise.resolve(void db.stores[store].clear()) : run(db, store, 'readwrite', (s) => s.clear()));

export async function deleteDatabase(db, name = DB_NAME) {
  if (db.memory) { db.stores.meta.clear(); db.stores.blobs.clear(); return; }
  db.close();
  await new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => res(); r.onerror = () => rej(r.error); r.onblocked = () => res();
  });
}

// ------------------------------------------------------------ device unlock wraps

/** Wrap of the vault key under a key derived from a WebAuthn PRF output. */
export async function makePrfWrap(vmk, { credId, prfSalt, prfOutput }) {
  const wrapKey = await core.hkdf(prfOutput, 'mysafe/web-prf-wrap/v1');
  return { credId, prfSalt, wrap: await core.seal(wrapKey, vmk, DEVICE_AAD) };
}

export async function openPrfWrap(entry, prfOutput) {
  return core.open(await core.hkdf(prfOutput, 'mysafe/web-prf-wrap/v1'), entry.wrap, DEVICE_AAD);
}

export async function makePassWrap(vmk, passphrase, iterations = PBKDF2_ITERATIONS) {
  const salt = core.randomBytes(16);
  return { salt, iterations, wrap: await core.seal(await core.pbkdf2(passphrase, salt, iterations), vmk, DEVICE_AAD) };
}

export async function openPassWrap(entry, passphrase) {
  return core.open(await core.pbkdf2(passphrase, entry.salt, entry.iterations), entry.wrap, DEVICE_AAD);
}

// ------------------------------------------------------------ vault creation / meta

export async function readMeta(db) {
  const [device, recoveryWrap, sealedIndex, settings] = await Promise.all(
    ['device', 'recoveryWrap', 'index', 'settings'].map((k) => dbGet(db, 'meta', k)));
  return { exists: !!device && !!sealedIndex, device: device || {}, recoveryWrap: recoveryWrap || null, sealedIndex, settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } };
}

/** blobs: optional Map(name -> bytes) to store (used by restore). */
export async function createVault(db, { vmk, device, recoveryWrap, index, blobs }) {
  await dbClear(db, 'blobs');
  if (blobs) for (const [name, bytes] of blobs) await dbPut(db, 'blobs', name, bytes);
  await dbPut(db, 'meta', 'index', await core.sealIndex(vmk, index));
  if (recoveryWrap) await dbPut(db, 'meta', 'recoveryWrap', recoveryWrap); else await dbDel(db, 'meta', 'recoveryWrap');
  await dbPut(db, 'meta', 'device', device);
}

/** Puts a parsed vault file (see core.parseVaultFile) into [db], ready to be unlocked. */
export async function loadVaultFile(db, parsed) {
  await dbClear(db, 'blobs');
  for (const [name, bytes] of parsed.blobs) await dbPut(db, 'blobs', name, bytes);
  await dbPut(db, 'meta', 'index', parsed.sealedIndex);
  if (parsed.recoveryWrap) await dbPut(db, 'meta', 'recoveryWrap', parsed.recoveryWrap); else await dbDel(db, 'meta', 'recoveryWrap');
  await dbPut(db, 'meta', 'device', parsed.pass ? { pass: parsed.pass } : {});
}

export const saveDevice = (db, device) => dbPut(db, 'meta', 'device', device);
export const saveRecoveryWrap = (db, w) => dbPut(db, 'meta', 'recoveryWrap', w);
export const saveSettings = (db, s) => dbPut(db, 'meta', 'settings', s);

// ------------------------------------------------------------ unlocked session

export class Session {
  constructor(db, vmk, index, kek, idxKey) {
    this.db = db; this.vmk = vmk; this.index = index; this.kek = kek; this.idxKey = idxKey;
    this.lastAuth = Date.now();
  }

  static async open(db, vmk, sealedIndex) {
    const idxKey = await core.indexKey(vmk);
    const index = core.indexFromBytes(await core.open(idxKey, sealedIndex, core.INDEX_AAD));
    return new Session(db, vmk, index, await core.fileKek(vmk), idxKey);
  }

  async save() {
    await dbPut(this.db, 'meta', 'index', await core.seal(this.idxKey, core.indexToBytes(this.index), core.INDEX_AAD));
    this.onChange?.();
  }

  async addPhoto(name, bytes, thumbBytes) {
    const id = crypto.randomUUID();
    const blobName = `${id}.msb`;
    const thumbName = thumbBytes ? `${id}.thumb.msb` : null;
    await dbPut(this.db, 'blobs', blobName, await core.encryptBlob(this.kek, bytes));
    if (thumbName) await dbPut(this.db, 'blobs', thumbName, await core.encryptBlob(this.kek, thumbBytes));
    const item = { id, name, addedAt: Date.now(), blobName, thumbName, tags: [] };
    this.index.photos.unshift(item);
    await this.save();
    return item;
  }

  async readBlob(name) {
    const b = await dbGet(this.db, 'blobs', name);
    if (!b) throw new core.VaultCryptoError('File is missing from storage');
    return core.decryptBlob(this.kek, b);
  }

  async deletePhoto(item) {
    this.index.photos = this.index.photos.filter((p) => p.id !== item.id);
    await this.save();
    await dbDel(this.db, 'blobs', item.blobName);
    if (item.thumbName) await dbDel(this.db, 'blobs', item.thumbName);
  }

  async upsertPassword(item, keepHistory) {
    const i = this.index.passwords.findIndex((p) => p.id === item.id);
    const saved = core.applyPasswordChange(i >= 0 ? this.index.passwords[i] : null, item, { keepHistory });
    if (i >= 0) this.index.passwords[i] = saved; else this.index.passwords.unshift(saved);
    await this.save();
  }

  async deletePassword(id) {
    this.index.passwords = this.index.passwords.filter((p) => p.id !== id);
    await this.save();
  }

  async clearHistory(id) {
    const p = this.index.passwords.find((x) => x.id === id);
    if (p) { p.history = []; await this.save(); }
  }

  /** Backup parts (for `new Blob(parts)`); needs the recovery wrap, so a key must exist. */
  async buildBackup(recoveryWrap) {
    const names = this.index.photos.flatMap((p) => [p.blobName, p.thumbName].filter(Boolean));
    const blobs = [];
    for (const name of names) blobs.push({ name, bytes: await dbGet(this.db, 'blobs', name) });
    const sealedIndex = await dbGet(this.db, 'meta', 'index');
    return core.buildBackup({ recoveryWrap, sealedIndex, blobs });
  }

  close() { this.vmk.fill(0); this.kek.fill(0); this.idxKey.fill(0); this.index = core.emptyIndex(); }
}
