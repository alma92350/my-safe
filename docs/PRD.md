# My Safe: Product Requirements Document

**Status:** Draft v0.1 · **Date:** 2026-10-28 · **Platform:** Android (primary target: Samsung Galaxy A54 5G)

## 1. Summary

My Safe is an offline-first Android vault for photos, screenshots and passwords. Nothing in the vault can be viewed until the user authenticates with the fingerprint already enrolled on their phone. All content is encrypted at rest with keys that live in the device's hardware-backed Keystore and that can only be used after a successful biometric check.

## 2. Problem and goals

People keep sensitive screenshots (bank details, recovery codes, ID scans), private photos and passwords in the regular gallery or in notes apps. These are visible to anyone who unlocks or borrows the phone, and are exposed in cloud backups and to other apps.

**Goals**
1. Store images, screenshots and credentials so they are unreadable without the user's fingerprint.
2. Make the fingerprint check cryptographically enforced (key release), not just a UI gate.
3. Work fully offline with no account and no network permission in v1.
4. Be fast and simple: unlock in under 2 seconds, add an item in under 3 taps.

**Non-goals (v1)**: cloud sync, multi-user sharing, browser extension, Android Autofill service, iOS, tablets/Wear OS, video, document scanning/OCR.

## 3. Target user and scenarios

Primary user: the owner of a single Android phone (Samsung A54) who wants private storage.

- *Hide a screenshot*: take a screenshot, share it to My Safe, choose to delete the original from the gallery.
- *Store a password*: add site, username, password; copy it with auto-clearing clipboard.
- *Show a private photo*: unlock with fingerprint, open the photo, lock again.
- *Phone borrowed by someone else*: the vault stays locked and nothing appears in app switcher previews.

## 4. Functional requirements

### 4.1 Authentication
| ID | Requirement | Priority |
|---|---|---|
| A1 | Unlock uses `BiometricPrompt` with `BIOMETRIC_STRONG` (fingerprint on the A54 is Class 3). | P0 |
| A2 | The vault key is a Keystore AES-256 key with `setUserAuthenticationRequired(true)`, per-use authentication, and is used through a `CryptoObject`, so decryption cannot happen without a successful biometric. | P0 |
| A3 | `setInvalidatedByBiometricEnrollment(true)`: if a fingerprint is added or removed, the key is invalidated and the user must go through recovery (see A5). | P0 |
| A4 | Auto-lock after a configurable timeout (default 30 s in background; immediate on screen off). Keys and decrypted data are wiped from memory on lock. | P0 |
| A5 | Recovery path: a user-set master passphrase (or an exported recovery key) that re-wraps the vault key after biometric invalidation. Without it, data is unrecoverable by design, and the user is told so at setup. | P0 |
| A6 | Lockout handling: after repeated failures, rely on the system's temporary and permanent lockout; show clear messaging. | P0 |
| A7 | Optional device PIN/pattern fallback is **off** by default (see open question Q1). | P1 |

### 4.2 Photos and screenshots
| ID | Requirement | Priority |
|---|---|---|
| P1 | Import via system Photo Picker (no broad storage permission), the Android share sheet ("Share to My Safe") and an in-app camera. | P0 |
| P2 | Each file is encrypted (AES-256-GCM, unique IV, streaming for large files) and stored in app-private storage. Originals are never copied to shared storage. | P0 |
| P3 | Optional "delete original after import" using the MediaStore delete request, with explicit user confirmation. | P0 |
| P4 | Encrypted thumbnails so the grid loads without decrypting full images. | P1 |
| P5 | Gallery grid, full-screen viewer with zoom, albums/tags, multi-select delete, search by name or tag. | P1 |
| P6 | Export a single item back to the gallery (user-initiated, with warning). | P1 |
| P7 | Share out is disabled by default. | P1 |

### 4.3 Passwords
| ID | Requirement | Priority |
|---|---|---|
| W1 | Entry fields: title, username, password, URL, notes, tags, favourite. | P0 |
| W2 | Stored in an encrypted database (Room with SQLCipher, or field-level AES-GCM) under the vault key. | P0 |
| W3 | Password hidden by default; reveal and copy require a fresh unlock if the last auth is older than 60 s. | P0 |
| W4 | Copy to clipboard flagged as sensitive (`EXTRA_IS_SENSITIVE`) and auto-cleared after 30 s. | P0 |
| W5 | Built-in password generator (length, character classes, passphrase mode). | P1 |
| W6 | Weak, reused and duplicate password indicator (local only). | P2 |
| W7 | Import from CSV (Chrome, Samsung Pass export), and encrypted export. | P2 |

### 4.4 Security hardening
| ID | Requirement | Priority |
|---|---|---|
| S1 | `FLAG_SECURE` on all vault screens: blocks screenshots, screen recording and app-switcher thumbnails. | P0 |
| S2 | No `INTERNET` permission in v1; `allowBackup="false"` and data-extraction rules exclude all vault data from cloud and device-transfer backup. | P0 |
| S3 | Use StrongBox-backed keys when available, falling back to TEE-backed keys. Detect at runtime and show the protection level in settings. The A54 should be verified on a real device. | P0 |
| S4 | Root/debugger/emulator detection via Play Integrity API as a warning (not a hard block). | P2 |
| S5 | Plaintext never written to disk, logs or crash reports; decrypted images held in memory only. | P0 |
| S6 | Obfuscated release builds (R8), signed, dependency versions pinned and scanned. | P1 |
| S7 | Optional disguised launcher name/icon. | P2 |

### 4.5 Settings
Auto-lock timeout, clipboard timeout, delete-original default, screenshot protection (locked on), biometric re-enrollment/recovery, change master passphrase, wipe vault, app version and security status.

## 5. Non-functional requirements

- **Performance:** cold start to unlock prompt < 1.5 s; unlock to grid < 1 s for 1,000 items; full-screen image decrypt < 500 ms for a 5 MB photo on the A54.
- **Reliability:** encryption writes are atomic (write to temp, then rename); a crash never leaves a half-encrypted file visible; periodic integrity check via GCM auth tags.
- **Compatibility:** `minSdk` 29 (Android 10; BiometricPrompt Class 3 and scoped storage), `targetSdk` current. A54 ships with Android 13 and is upgradable, so test on One UI 5 through the latest.
- **Accessibility:** TalkBack labels, minimum 48 dp touch targets, dark mode.
- **Privacy:** no analytics, ads or third-party SDKs that touch vault data. Any crash reporting is opt-in and content-free.
- **Localization:** English and French at launch (strings externalized).

## 6. Proposed technical approach

- **Language/UI:** Kotlin, Jetpack Compose, MVVM, Hilt.
- **Crypto:** AndroidX Biometric + Android Keystore. Per-file random data keys (DEK) encrypted by a Keystore-held key (KEK), enabling fast re-keying and per-item crypto. Use Tink (`StreamingAead`) for large files instead of hand-rolled streaming.
- **Storage:** app-private `filesDir` for encrypted blobs; encrypted Room DB for metadata and credentials.
- **Imaging:** Coil with a custom decrypting fetcher; bitmaps never cached to disk.
- **Testing:** unit tests for crypto wrappers, instrumented tests on a physical A54 for biometrics, StrongBox and invalidation flows (emulators cannot prove these).

## 7. Key screens

1. Onboarding and security setup (biometric check, master passphrase, recovery warning)
2. Lock screen with fingerprint prompt
3. Home with tabs: Photos · Passwords · Settings
4. Photo grid and viewer
5. Password list, detail and editor
6. Import flow (picker, camera, share target) with "delete original?" prompt
7. Settings and security status

## 8. Success metrics

- 100% of vault content unreadable via adb/file-system inspection on a non-rooted and a rooted device (ciphertext only).
- Biometric unlock success rate ≥ 95% on first attempt for enrolled users.
- Unlock latency p95 < 2 s.
- Zero plaintext artifacts found in a storage, log and backup audit before release.
- Crash-free sessions ≥ 99.5%.

## 9. Threat model (summary)

| Threat | Mitigation |
|---|---|
| Someone borrows the unlocked phone | Biometric per session, auto-lock, FLAG_SECURE |
| Lost or stolen phone | Hardware-bound keys, no plaintext at rest |
| Another app reads files | App-private storage, no export by default |
| Cloud/ADB backup leak | Backup disabled and data excluded |
| New fingerprint added by an attacker with the PIN | Key invalidated on enrollment change |
| Malware with root | Out of scope for full protection; warn via integrity check |
| Shoulder surfing / screen recording | Masked passwords, FLAG_SECURE |

## 10. Risks

- **Data loss:** biometric invalidation or lost recovery secret makes the vault permanently unreadable. Mitigation: mandatory recovery setup and clear warnings.
- **Samsung-specific behavior:** One UI quirks with BiometricPrompt, Knox and secure folders. Mitigation: test early on a real A54.
- **Screenshots hidden but originals linger in "Recently deleted":** the gallery trash retains items for 30 days. Mitigation: guide the user to empty the trash after import.
- **Overclaiming security:** be accurate in store listing; no hard guarantee against rooted or compromised devices.

## 11. Milestones

| Phase | Scope | Rough effort |
|---|---|---|
| M0 | Project skeleton, Keystore and biometric spike on the A54 (key invalidation, StrongBox check) | 1 week |
| M1 | Lock/unlock, encrypted password vault (W1–W4), FLAG_SECURE | 2 weeks |
| M2 | Photo import, encrypted storage, grid and viewer, delete-original | 3 weeks |
| M3 | Recovery flow, settings, auto-lock, generator, accessibility | 2 weeks |
| M4 | Security audit, performance pass, beta on the A54 | 2 weeks |
| v1.1 | CSV import/export, tags/albums, breach/reuse indicators | later |

## 12. Open questions

1. **Q1:** Allow the phone PIN/pattern as an unlock fallback? It is more convenient but weakens the "fingerprint only" promise, since a PIN-knowing attacker could also enroll a fingerprint.
2. **Q2:** Is the recovery mechanism a master passphrase, a printed recovery key, or both?
3. **Q3:** Will this be distributed via Google Play or sideloaded for personal use only? That affects signing, Play Integrity and listing requirements.
4. **Q4:** Should an encrypted local backup (e.g. to USB or SD file) be in v1?
5. **Q5:** Is video support wanted soon after v1?
6. **Q6:** App name, branding and whether to disguise the launcher icon.
