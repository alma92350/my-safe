# My-Safe

Offline Android vault for photos, screenshots and passwords, unlocked with the phone's fingerprint
(PIN fallback optional). Personal sideload only. See [docs/PRD.md](docs/PRD.md).

## Layout

| Path | What |
|---|---|
| `vaultcore/` | Pure Kotlin/JVM crypto and storage: key hierarchy, recovery key, streaming file encryption, encrypted index, backup/restore, password generator. Fully unit-tested, no Android dependency. |
| `app/` | Android app (Kotlin, Jetpack Compose): Keystore device key, BiometricPrompt, UI. |
| `.github/workflows/build.yml` | CI: runs the core tests and builds the APKs. |

## Build and test

```bash
./gradlew :vaultcore:test          # works anywhere with JDK 17+
```

The `app` module is only included when `ANDROID_HOME` / `ANDROID_SDK_ROOT` is set:

```bash
./gradlew :app:assembleDebug       # debug APK, for trying it out
```

## Release signing (sideload)

Create a keystore once and **back it up offline** (Android only accepts updates signed with the same key):

```bash
keytool -genkeypair -v -keystore my-safe.jks -alias mysafe -keyalg RSA -keysize 4096 -validity 36500
```

Then build locally with the keystore supplied through the environment:

```bash
MYSAFE_KEYSTORE=$PWD/my-safe.jks MYSAFE_KEYSTORE_PASSWORD=... MYSAFE_KEY_ALIAS=mysafe MYSAFE_KEY_PASSWORD=... \
  ./gradlew :app:assembleRelease
```

or add `MYSAFE_KEYSTORE_B64` (base64 of the .jks), `MYSAFE_KEYSTORE_PASSWORD`, `MYSAFE_KEY_ALIAS`,
`MYSAFE_KEY_PASSWORD` as GitHub Actions secrets to get a signed APK from CI.

Install over the previous version to update. Never uninstall first: that deletes the encrypted vault.

## Key design

```
recovery key (user keeps, 52 chars) ──HKDF──► wraps ┐
Keystore device key (fingerprint/PIN) ──────► wraps ┴► vault master key (VMK, memory only while unlocked)
                                                        ├─ index key  → encrypted index (metadata + passwords)
                                                        └─ file KEK   → per-file random keys → encrypted photo blobs
```

## Status

- `vaultcore`: implemented and tested (14 tests, including an audit that plants known plaintext and checks it appears nowhere on disk or in backups).
- `app`: written against the PRD but **not yet compiled or run**. The authoring environment had no
  Android SDK, so the first CI run is the first compile. Expect small fixes.
- To verify on the A54 (cannot be tested without the device): StrongBox availability, key invalidation when a
  fingerprint is added, the PIN-fallback prompt, deleting originals via the system dialog, backup/restore round trip.
- Not yet built: in-app camera, photo export, French strings, launcher disguise.
