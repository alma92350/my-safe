package app.mysafe.core

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals

/**
 * Keeps the Android and web apps format-compatible.
 *
 * - Writes `build/interop/android-backup.msbk` + `.key.txt`; web/test/fixtures holds a committed copy
 *   that the JavaScript tests restore.
 * - Restores `web/test/fixtures/web-backup.msbk`, written by the JavaScript code.
 */
class WebInteropTest {
    private val photo = ByteArray(150_000) { ((it * 31 + 7) % 251).toByte() }
    private val thumb = ByteArray(700) { (it % 256).toByte() }

    @Test fun writeAndroidFixtureAndRestoreWebFixture() {
        // --- Android -> web
        val root = Files.createTempDirectory("mysafe-interop").toFile()
        val vmk = VaultKeys.newMasterKey()
        val rk = RecoveryKey.generate()
        File(root, VaultLayout.KEYS).mkdirs()
        VaultStore.atomicWrite(File(root, VaultLayout.RECOVERY_WRAP), VaultKeys.wrapWithRecovery(vmk, rk))
        val store = VaultStore(root, vmk)
        store.addPhoto("café ✓.jpg", photo.inputStream(), thumb)
        store.upsertPassword(PasswordItem("p1", "Café ✓", "alice", "old-secret", "https://bank.example", "notes ü"))
        store.upsertPassword(PasswordItem("p1", "Café ✓", "alice", "new-secret", "https://bank.example", "notes ü"))
        val out = File("build/interop").apply { mkdirs() }
        File(out, "android-backup.msbk").outputStream().use { BackupFile.write(store, root, it) }
        File(out, "android-backup.key.txt").writeText(rk.format())

        // --- web -> Android (skipped until the JS side has produced its fixture)
        val fixtures = File("../web/test/fixtures")
        val backup = File(fixtures, "web-backup.msbk")
        val keyFile = File(fixtures, "web-backup.key.txt")
        if (!backup.exists() || !keyFile.exists()) return
        val fresh = Files.createTempDirectory("mysafe-interop-web").toFile()
        val recovered = BackupFile.restore(backup.inputStream(), fresh, RecoveryKey.parse(keyFile.readText().trim()))
        val restored = VaultStore(fresh, recovered)
        val item = restored.index.photos.single()
        assertEquals("wéb.jpg", item.name)
        assertContentEquals(photo, restored.readPhoto(item))
        assertContentEquals(thumb, restored.readThumbnail(item))
        val pw = restored.index.passwords.single()
        assertEquals("Wéb Bank ✓", pw.title)
        assertEquals("bob", pw.username)
        assertEquals("w2", pw.password)
        assertEquals(listOf("w1"), pw.history.map { it.password })
    }
}
