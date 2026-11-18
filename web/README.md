# My-Safe (web)

A static, dependency-free single-page app version of My-Safe: an encrypted vault for photos, screenshots and
passwords that lives entirely in the browser. No server, no accounts, no network requests after the page loads.
It uses the same file formats as the Android app, so **a backup made on one restores on the other**.

## Deploy

It is just files. Copy everything in this folder **except `test/` and `tools/`** to any static host that serves
**HTTPS** (browsers only enable Web Crypto and passkeys on secure origins; `http://localhost` also works).
Relative URLs are used throughout, so it also works under a sub-path.

- Netlify / Cloudflare Pages: publish this folder; `_headers` sets the security headers.
- nginx / Apache: see `nginx.conf.example`.
- GitHub Pages: run the manual "pages" workflow (Actions tab) after enabling Pages in the repository settings.
- Try it locally: `node test/serve.mjs` then open http://localhost:8080/

Open the site on your phone and use the browser's "Add to Home screen" / "Install app" to get a full-screen app
that also works offline.

## Two ways to keep the vault

When you create a vault you choose where it lives:

- **In this browser** (IndexedDB): convenient and it supports passkey unlock, but the browser can clear it. Keep backups.
- **In a file**: the vault exists only in memory. **Save vault** downloads an encrypted `.msvf` file; **Open a vault file**
  loads it again, on any device, and you unlock it with your passphrase (or recovery key). Nothing is ever written to browser
  storage, and a changed-but-unsaved vault is marked "Save vault •" and the page warns before you leave. A passkey cannot
  be used here because it belongs to one browser, but the file has to open anywhere.

The `.msvf` file is different from a backup (`.msbk`): a vault file opens with your passphrase, while a backup needs the
recovery key and can also be restored into the Android app.

## Single-file build

`node tools/build-single.mjs` bundles everything into `dist/my-safe-single.html`, one self-contained page for hosts
that accept only a single file (for example Claude Artifacts). It runs in "sandbox mode": passkeys, downloads and the
service worker are off because such frames block them, so unlock is passphrase-only, file vaults are the default, and saved files / backups are shown
as text to copy (opening and restoring accept that text). Use the normal folder deploy for the full app.

## How it protects data

```
recovery key (52 chars, you keep it) ─HKDF─► wraps ┐
passkey PRF output (fingerprint/face/screen lock) ─► wraps ├► vault master key (memory only while unlocked)
passphrase ─PBKDF2-SHA256, 600k rounds─► wraps ────┘        ├─ index key → encrypted index (metadata + passwords + history)
                                                            └─ file KEK  → per-file random keys → encrypted photo blobs
```

- Everything in IndexedDB is AES-256-GCM ciphertext (chunked, authenticated). Only non-sensitive settings
  (auto-lock time, history on/off) and the wrapped keys are stored besides.
- **Passkey unlock** uses the WebAuthn PRF extension: the key material is produced by the authenticator only after
  your device verifies you, so it is a real cryptographic gate like the Android Keystore. Chrome/Edge on Android,
  desktop Chrome/Edge/Safari with a platform authenticator support it; others fall back to the passphrase.
- The recovery key is shown once and never stored. Without it, losing your passkey/passphrase means losing the data.
- Auto-lock when you leave the tab (immediately, 30 s, 1 min or 5 min), after 10 minutes idle, and the screen is
  blanked in the app switcher. Passwords are hidden by default; reveal/copy need a fresh unlock if it has been
  more than 60 s. Copied passwords are cleared from the clipboard after 30 s (best effort).
- A strict Content-Security-Policy is set in the page and in `_headers`; the app builds its UI without `innerHTML`.

## Differences from the Android app (read this)

| | Android | Web |
|---|---|---|
| Key storage | Hardware Keystore / StrongBox, bound to your fingerprint | Passkey PRF where supported (hardware-backed by the authenticator), otherwise only your passphrase |
| Offline guessing if the device is stolen | Throttled by secure hardware | Passphrase mode is only slowed by PBKDF2: use a long passphrase |
| Screenshots / screen recording | Blocked (`FLAG_SECURE`) | Cannot be blocked by a website |
| Trust in the code | You install a signed APK | You trust whoever serves the files **on every visit**. Self-host it, use HTTPS, and keep your own copy of the code you reviewed. |
| Data lifetime | App storage | Browser storage: it can be cleared with site data or under storage pressure. The app asks the browser to keep it, but **make backups**. |
| Deleting originals after import | Offered | Not possible; delete them from your gallery yourself |
| Large vaults | Streams from disk | Whole files are decrypted in memory; backups are built in memory |

Passkeys are bound to the site's host name. If you move the app to another address, unlock with your recovery key
there and set them up again (or restore a backup).

## Develop and test

```bash
npm install                 # only needed for the end-to-end test (playwright)
npm test                    # unit tests for core.js, including the Android backup fixture
npm run test:e2e            # drives a real Chromium: setup, passkey (virtual authenticator), backup, restore
```

Cross-compatibility with Android is tested both ways: `vaultcore`'s `WebInteropTest` writes
`build/interop/android-backup.msbk` (copy it to `test/fixtures/` to refresh) and restores
`test/fixtures/web-backup.msbk`, which `WRITE_FIXTURES=1 npm test` regenerates.

Layout: `js/core.js` (crypto and file formats), `js/vault.js` (IndexedDB storage), `js/auth.js` (WebAuthn),
`js/app.js` (UI), `sw.js` (offline shell), `tools/make-icons.cjs` (renders the PNG icons).
