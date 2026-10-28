package app.mysafe

import android.app.Application
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.os.SystemClock
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.util.LruCache
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.fragment.app.FragmentActivity
import app.mysafe.core.BackupFile
import app.mysafe.core.PasswordItem
import app.mysafe.core.PhotoItem
import app.mysafe.core.RecoveryKey
import app.mysafe.core.VaultCryptoException
import app.mysafe.core.VaultKeys
import app.mysafe.core.VaultLayout
import app.mysafe.core.VaultStore
import java.io.File
import java.io.OutputStream
import java.util.UUID

/**
 * Owns the unlocked-vault session. The vault master key (VMK) exists in memory only while
 * unlocked; at rest it is wrapped twice: by the hardware Keystore key (daily unlock, needs
 * fingerprint/PIN) and by the recovery key (kept by the user, never stored on the phone).
 */
class VaultManager(private val app: Application) {
    private val root = File(app.filesDir, "vault")
    private val prefs = app.getSharedPreferences("settings", Context.MODE_PRIVATE)
    private val thumbs = LruCache<String, Bitmap>(300)

    var store by mutableStateOf<VaultStore?>(null)
        private set
    var revision by mutableIntStateOf(0)
        private set
    var setUp by mutableStateOf(checkSetUp())
        private set
    var needsRecovery by mutableStateOf(false)
    var status by mutableStateOf<String?>(null)
    var autoLockSeconds by mutableIntStateOf(prefs.getInt("autolock", 30))
        private set
    var allowDeviceCredential by mutableStateOf(readDeviceFlags().second)
        private set

    val pendingShares = mutableStateListOf<Uri>()

    /** Set before launching a system picker so the auto-lock doesn't fire while we're away. */
    @Volatile var externalInFlight = false
    @Volatile var promptInFlight = false
    private var lastAuthAt = 0L

    val unlocked: Boolean get() = store != null

    // ---- device-wrap file: [flags|aliasIdx][ivLen][iv][ciphertext] ----

    private fun checkSetUp() = File(root, VaultLayout.RECOVERY_WRAP).exists() && File(root, VaultLayout.DEVICE_WRAP).exists()

    private fun readDeviceFlags(): Pair<Int, Boolean> {
        val f = File(root, VaultLayout.DEVICE_WRAP)
        if (!f.exists()) return -1 to true
        val b = f.readBytes()[0].toInt()
        return (b and 0x7F) to (b and 0x80 != 0)
    }

    fun keyProtection(): String {
        val idx = readDeviceFlags().first
        return if (idx < 0) "n/a" else DeviceKey.protectionLevel(DeviceKey.ALIASES[idx])
    }

    // ---- lifecycle ----

    private fun open(vmk: ByteArray) {
        store = VaultStore(root, vmk)
        vmk.fill(0)
        lastAuthAt = SystemClock.elapsedRealtime()
        status = null
        revision++
    }

    fun lock() {
        store?.close()
        store = null
        thumbs.evictAll()
    }

    fun setAutoLock(seconds: Int) {
        autoLockSeconds = seconds
        prefs.edit().putInt("autolock", seconds).apply()
    }

    // ---- binding the VMK to this phone's secure hardware ----

    /** Creates a fresh Keystore key, has the user authenticate, and stores the wrapped VMK. */
    private fun bindDevice(activity: FragmentActivity, vmk: ByteArray, allowCredential: Boolean, done: (String?) -> Unit) {
        if (!Biometrics.available(app, allowCredential)) {
            done(
                if (allowCredential) "Set up a fingerprint or screen lock in Android Settings first."
                else "No fingerprint is enrolled. Enroll one in Android Settings first.",
            )
            return
        }
        val oldIdx = readDeviceFlags().first
        val newIdx = if (oldIdx == 0) 1 else 0
        val alias = DeviceKey.ALIASES[newIdx]
        val cipher = try {
            DeviceKey.create(alias, allowCredential)
            DeviceKey.encryptCipher(alias)
        } catch (e: Exception) {
            done("Could not create the secure key: ${e.message}")
            return
        }
        promptInFlight = true
        Biometrics.prompt(
            activity, "Protect your vault", "Confirm to bind the vault to this phone", allowCredential, cipher,
            onSuccess = { c ->
                promptInFlight = false
                try {
                    val ct = c!!.doFinal(vmk)
                    val iv = c.iv
                    val head = (newIdx or (if (allowCredential) 0x80 else 0)).toByte()
                    VaultStore.atomicWrite(
                        File(root, VaultLayout.DEVICE_WRAP),
                        byteArrayOf(head, iv.size.toByte()) + iv + ct,
                    )
                    if (oldIdx >= 0) DeviceKey.delete(DeviceKey.ALIASES[oldIdx])
                    allowDeviceCredential = allowCredential
                    done(null)
                } catch (e: Exception) {
                    DeviceKey.delete(alias)
                    done("Could not store the key: ${e.message}")
                }
            },
            onFailure = { _, msg ->
                promptInFlight = false
                DeviceKey.delete(alias)
                done(msg)
            },
        )
    }

    // ---- first-time setup ----

    fun completeSetup(activity: FragmentActivity, vmk: ByteArray, recovery: RecoveryKey, done: (String?) -> Unit) {
        bindDevice(activity, vmk, allowCredential = true) { err ->
            if (err != null) return@bindDevice done(err)
            VaultStore.atomicWrite(File(root, VaultLayout.RECOVERY_WRAP), VaultKeys.wrapWithRecovery(vmk, recovery))
            setUp = checkSetUp()
            open(vmk.copyOf())
            done(null)
        }
    }

    // ---- daily unlock ----

    fun unlock(activity: FragmentActivity, done: (String?) -> Unit) {
        if (promptInFlight || unlocked) return
        val blob = File(root, VaultLayout.DEVICE_WRAP).readBytes()
        val idx = blob[0].toInt() and 0x7F
        val cred = blob[0].toInt() and 0x80 != 0
        val ivLen = blob[1].toInt()
        val iv = blob.copyOfRange(2, 2 + ivLen)
        val ct = blob.copyOfRange(2 + ivLen, blob.size)
        val cipher = try {
            DeviceKey.decryptCipher(DeviceKey.ALIASES[idx], iv)
        } catch (e: KeyPermanentlyInvalidatedException) {
            needsRecovery = true
            return done("Your fingerprints changed, so the vault key was locked for your safety. Use your recovery key.")
        } catch (e: Exception) {
            needsRecovery = true
            return done("The secure key is unavailable. Use your recovery key.")
        }
        promptInFlight = true
        Biometrics.prompt(
            activity, "Unlock My-Safe", null, cred, cipher,
            onSuccess = { c ->
                promptInFlight = false
                try {
                    open(c!!.doFinal(ct))
                    done(null)
                } catch (e: Exception) {
                    done("Could not unlock: ${e.message}")
                }
            },
            onFailure = { _, msg ->
                promptInFlight = false
                done(msg)
            },
        )
    }

    /** Unlocks with the recovery key, then re-binds the vault to a fresh Keystore key. */
    fun recover(activity: FragmentActivity, key: RecoveryKey, done: (String?) -> Unit) {
        val vmk = try {
            VaultKeys.unwrapWithRecovery(File(root, VaultLayout.RECOVERY_WRAP).readBytes(), key)
        } catch (e: VaultCryptoException) {
            return done("That recovery key doesn't match this vault.")
        }
        bindDevice(activity, vmk, allowDeviceCredential) { err ->
            if (err == null) {
                needsRecovery = false
                open(vmk.copyOf())
            }
            vmk.fill(0)
            done(err)
        }
    }

    // ---- restore from an encrypted backup (blocking part, call off the main thread) ----

    fun restoreFiles(source: Uri, key: RecoveryKey): ByteArray {
        lock()
        root.deleteRecursively()
        root.mkdirs()
        try {
            val input = app.contentResolver.openInputStream(source) ?: throw VaultCryptoException("Cannot read the backup file")
            return input.use { BackupFile.restore(it, root, key) }
        } catch (e: Exception) {
            root.deleteRecursively()
            throw e
        }
    }

    fun finishRestore(activity: FragmentActivity, vmk: ByteArray, done: (String?) -> Unit) {
        bindDevice(activity, vmk, allowCredential = true) { err ->
            if (err == null) {
                setUp = checkSetUp()
                open(vmk.copyOf())
            } else {
                root.deleteRecursively()
            }
            vmk.fill(0)
            done(err)
        }
    }

    // ---- settings operations ----

    fun setAllowCredential(activity: FragmentActivity, allow: Boolean, done: (String?) -> Unit) {
        val s = store ?: return done("Locked")
        val vmk = s.masterKeyCopy
        bindDevice(activity, vmk, allow) { err -> vmk.fill(0); done(err) }
    }

    fun commitRecoveryKey(key: RecoveryKey) {
        val s = store ?: return
        val vmk = s.masterKeyCopy
        VaultStore.atomicWrite(File(root, VaultLayout.RECOVERY_WRAP), VaultKeys.wrapWithRecovery(vmk, key))
        vmk.fill(0)
    }

    fun exportBackup(out: OutputStream) {
        BackupFile.write(store ?: throw IllegalStateException("Locked"), root, out)
    }

    fun wipe() {
        lock()
        root.deleteRecursively()
        DeviceKey.ALIASES.forEach { DeviceKey.delete(it) }
        setUp = false
        needsRecovery = false
    }

    /** Runs [onOk] if the owner authenticated in the last 60 s, otherwise asks again first. */
    fun requireRecentAuth(activity: FragmentActivity, onOk: () -> Unit, onFail: (String) -> Unit) {
        if (SystemClock.elapsedRealtime() - lastAuthAt < 60_000) return onOk()
        promptInFlight = true
        Biometrics.prompt(
            activity, "Confirm it's you", null, allowDeviceCredential, null,
            onSuccess = {
                promptInFlight = false
                lastAuthAt = SystemClock.elapsedRealtime()
                onOk()
            },
            onFailure = { _, msg ->
                promptInFlight = false
                onFail(msg)
            },
        )
    }

    // ---- photos ----

    data class ImportResult(val imported: List<Uri>, val failed: Int)

    /** Blocking; call from a background thread. */
    fun importUris(uris: List<Uri>): ImportResult {
        val s = store ?: return ImportResult(emptyList(), uris.size)
        val ok = ArrayList<Uri>()
        var failed = 0
        for (u in uris) {
            try {
                val name = ImageUtil.displayName(app, u)
                val thumb = ImageUtil.thumbnail(app, u)
                app.contentResolver.openInputStream(u)!!.use { s.addPhoto(name, it, thumb) }
                ok += u
            } catch (e: Exception) {
                failed++
            }
        }
        revision++
        return ImportResult(ok, failed)
    }

    fun thumbnail(item: PhotoItem): Bitmap? {
        thumbs.get(item.id)?.let { return it }
        val bytes = store?.readThumbnail(item) ?: return null
        val bmp = ImageUtil.decode(bytes, 320) ?: return null
        thumbs.put(item.id, bmp)
        return bmp
    }

    fun fullImage(item: PhotoItem): Bitmap? = store?.readPhoto(item)?.let { ImageUtil.decode(it, 2048) }

    fun deletePhoto(item: PhotoItem) {
        store?.deletePhoto(item)
        thumbs.remove(item.id)
        revision++
    }

    // ---- passwords ----

    fun savePassword(item: PasswordItem) {
        store?.upsertPassword(item)
        revision++
    }

    fun deletePassword(id: String) {
        store?.deletePassword(id)
        revision++
    }

    fun newPasswordId(): String = UUID.randomUUID().toString()

    /** Copies flagged as sensitive (hidden from clipboard previews) and clears after 30 s. */
    fun copySensitive(text: String) {
        val cm = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("password", text)
        clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
        cm.setPrimaryClip(clip)
        Handler(Looper.getMainLooper()).postDelayed({ cm.clearPrimaryClip() }, 30_000)
    }
}
