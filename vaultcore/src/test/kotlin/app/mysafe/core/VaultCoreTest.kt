package app.mysafe.core

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class VaultCoreTest {
    private fun tmp(): File = Files.createTempDirectory("mysafe").toFile()

    @Test fun sealOpenRoundTripAndTamper() {
        val k = Crypto.randomBytes(32)
        val sealed = Crypto.seal(k, "hello".toByteArray(), byteArrayOf(1))
        assertContentEquals("hello".toByteArray(), Crypto.open(k, sealed, byteArrayOf(1)))
        assertFailsWith<VaultCryptoException> { Crypto.open(k, sealed, byteArrayOf(2)) }
        assertFailsWith<VaultCryptoException> { Crypto.open(Crypto.randomBytes(32), sealed, byteArrayOf(1)) }
        sealed[sealed.size - 1] = (sealed.last() + 1).toByte()
        assertFailsWith<VaultCryptoException> { Crypto.open(k, sealed, byteArrayOf(1)) }
    }

    @Test fun recoveryKeyFormatAndParse() {
        val rk = RecoveryKey.generate()
        val text = rk.format()
        assertEquals(13, text.split("-").size)
        assertTrue(text.split("-").all { it.length == 4 })
        val parsed = RecoveryKey.parse(text.lowercase().replace("-", " "))
        assertContentEquals(rk.wrapKey(), parsed.wrapKey())
        assertFailsWith<IllegalArgumentException> { RecoveryKey.parse("ABCD") }
        assertFailsWith<IllegalArgumentException> { RecoveryKey.parse("1".repeat(52)) }
    }

    @Test fun recoveryWrapRoundTrip() {
        val vmk = VaultKeys.newMasterKey()
        val rk = RecoveryKey.generate()
        val wrapped = VaultKeys.wrapWithRecovery(vmk, rk)
        assertContentEquals(vmk, VaultKeys.unwrapWithRecovery(wrapped, rk))
        assertFailsWith<VaultCryptoException> { VaultKeys.unwrapWithRecovery(wrapped, RecoveryKey.generate()) }
    }

    @Test fun blobRoundTripAcrossChunkBoundaries() {
        val kek = Crypto.randomBytes(32)
        val c = BlobCipher.CHUNK
        for (size in listOf(0, 1, c - 1, c, c + 1, 3 * c, 3 * c + 17)) {
            val plain = Crypto.randomBytes(size)
            val enc = BlobCipher.encrypt(kek, plain)
            assertContentEquals(plain, BlobCipher.decrypt(kek, enc), "size $size")
        }
    }

    @Test fun blobDetectsTruncationReorderAndTamper() {
        val kek = Crypto.randomBytes(32)
        val c = BlobCipher.CHUNK
        val enc = BlobCipher.encrypt(kek, Crypto.randomBytes(3 * c))
        val header = enc.size - 3 * (c + 16) - 16 // 3 full chunks + final empty chunk
        // drop the final (empty) chunk -> previous chunk was not flagged "last"
        assertFailsWith<VaultCryptoException> { BlobCipher.decrypt(kek, enc.copyOf(enc.size - 16)) }
        // flip a byte
        val bad = enc.copyOf().also { it[header + 5] = (it[header + 5] + 1).toByte() }
        assertFailsWith<VaultCryptoException> { BlobCipher.decrypt(kek, bad) }
        // swap chunk 0 and 1
        val sw = enc.copyOf()
        enc.copyInto(sw, header, header + (c + 16), header + 2 * (c + 16))
        enc.copyInto(sw, header + (c + 16), header, header + (c + 16))
        assertFailsWith<VaultCryptoException> { BlobCipher.decrypt(kek, sw) }
        assertFailsWith<VaultCryptoException> { BlobCipher.decrypt(Crypto.randomBytes(32), enc) }
    }

    @Test fun storeRoundTripAndNoPlaintextOnDisk() {
        val root = tmp()
        val vmk = VaultKeys.newMasterKey()
        val store = VaultStore(root, vmk)
        val photo = "SECRET-PHOTO-BYTES".repeat(100).toByteArray()
        val item = store.addPhoto("a.jpg", ByteArrayInputStream(photo), "thumb".toByteArray())
        store.upsertPassword(PasswordItem("p1", "Bank", "alice", "hunter2-pw", "https://bank", "pin 1234"))

        val reopened = VaultStore(root, vmk)
        assertEquals(1, reopened.index.photos.size)
        assertContentEquals(photo, reopened.readPhoto(item))
        assertContentEquals("thumb".toByteArray(), reopened.readThumbnail(item))
        assertEquals("hunter2-pw", reopened.index.passwords.single().password)

        root.walkTopDown().filter { it.isFile }.forEach {
            val text = String(it.readBytes(), Charsets.ISO_8859_1)
            assertTrue("SECRET-PHOTO" !in text && "hunter2" !in text && "Bank" !in text, "plaintext in ${it.name}")
        }
        assertFailsWith<VaultCryptoException> { VaultStore(root, VaultKeys.newMasterKey()) }

        reopened.deletePhoto(item)
        assertTrue(!File(root, "blobs/${item.blobName}").exists())
    }

    @Test fun backupRoundTrip() {
        val root = tmp()
        val vmk = VaultKeys.newMasterKey()
        val rk = RecoveryKey.generate()
        File(root, VaultLayout.KEYS).mkdirs()
        VaultStore.atomicWrite(File(root, VaultLayout.RECOVERY_WRAP), VaultKeys.wrapWithRecovery(vmk, rk))
        val store = VaultStore(root, vmk)
        val photo = Crypto.randomBytes(200_000)
        val item = store.addPhoto("a.png", ByteArrayInputStream(photo), Crypto.randomBytes(500))
        store.upsertPassword(PasswordItem("p1", "Mail", "bob", "pw"))

        val bos = ByteArrayOutputStream()
        BackupFile.write(store, root, bos)
        val backup = bos.toByteArray()

        val fresh = tmp()
        val recovered = BackupFile.restore(backup.inputStream(), fresh, RecoveryKey.parse(rk.format()))
        assertContentEquals(vmk, recovered)
        val restored = VaultStore(fresh, recovered)
        assertContentEquals(photo, restored.readPhoto(restored.index.photos.single()))
        assertEquals("pw", restored.index.passwords.single().password)
        assertNotNull(item)

        assertFailsWith<VaultCryptoException> {
            BackupFile.restore(backup.inputStream(), tmp(), RecoveryKey.generate())
        }
        assertFailsWith<VaultCryptoException> {
            BackupFile.restore(backup.copyOf(backup.size - 100).inputStream(), tmp(), rk)
        }
    }

    @Test fun passwordGeneratorHonoursClasses() {
        repeat(50) {
            val p = PasswordGenerator.generate(12, upper = true, lower = true, digits = true, symbols = true)
            assertEquals(12, p.length)
            assertTrue(p.any { it.isUpperCase() } && p.any { it.isLowerCase() } && p.any { it.isDigit() } && p.any { !it.isLetterOrDigit() })
        }
        assertTrue(PasswordGenerator.generate(30, upper = false, lower = true, digits = false, symbols = false).all { it.isLowerCase() })
        assertFailsWith<IllegalArgumentException> { PasswordGenerator.generate(8, false, false, false, false) }
    }

    // ---- password history ----

    @Test fun passwordHistoryRecordsChangesNewestFirst() {
        val store = VaultStore(tmp(), VaultKeys.newMasterKey())
        store.upsertPassword(PasswordItem("p", "Site", "u", "one"))
        store.upsertPassword(PasswordItem("p", "Site", "u", "two"))
        store.upsertPassword(PasswordItem("p", "Site renamed", "u", "two")) // password unchanged: no new version
        store.upsertPassword(PasswordItem("p", "Site renamed", "u", "three"))
        val p = store.index.passwords.single()
        assertEquals("three", p.password)
        assertEquals(listOf("two", "one"), p.history.map { it.password })
    }

    @Test fun passwordHistoryIsCappedAndCanBeDisabledOrCleared() {
        val store = VaultStore(tmp(), VaultKeys.newMasterKey())
        store.upsertPassword(PasswordItem("p", "S", "u", "p0"))
        for (n in 1..15) store.upsertPassword(PasswordItem("p", "S", "u", "p$n"), maxVersions = 10)
        assertEquals(10, store.index.passwords.single().history.size)
        assertEquals("p14", store.index.passwords.single().history.first().password)

        store.upsertPassword(PasswordItem("p", "S", "u", "off"), keepHistory = false)
        assertEquals("p14", store.index.passwords.single().history.first().password) // nothing added

        store.clearPasswordHistory("p")
        assertTrue(store.index.passwords.single().history.isEmpty())
    }

    @Test fun callerCannotInjectHistory() {
        val store = VaultStore(tmp(), VaultKeys.newMasterKey())
        store.upsertPassword(PasswordItem("p", "S", "u", "a", history = listOf(PasswordVersion("forged", 1))))
        assertTrue(store.index.passwords.single().history.isEmpty())
    }

    @Test fun historySurvivesReopenAndBackup() {
        val root = tmp()
        val vmk = VaultKeys.newMasterKey()
        val rk = RecoveryKey.generate()
        File(root, VaultLayout.KEYS).mkdirs()
        VaultStore.atomicWrite(File(root, VaultLayout.RECOVERY_WRAP), VaultKeys.wrapWithRecovery(vmk, rk))
        val store = VaultStore(root, vmk)
        store.upsertPassword(PasswordItem("p", "S", "u", "old-secret"))
        store.upsertPassword(PasswordItem("p", "S", "u", "new-secret"))
        assertEquals("old-secret", VaultStore(root, vmk).index.passwords.single().history.single().password)

        val bos = ByteArrayOutputStream()
        BackupFile.write(store, root, bos)
        val fresh = tmp()
        val restored = VaultStore(fresh, BackupFile.restore(bos.toByteArray().inputStream(), fresh, rk))
        assertEquals("old-secret", restored.index.passwords.single().history.single().password)
    }

    @Test fun oldIndexFormatStillLoads() {
        // Hand-built version-1 index (no password history field), as written by the first release.
        val bos = ByteArrayOutputStream()
        java.io.DataOutputStream(bos).use { o ->
            fun str(s: String) { val b = s.toByteArray(); o.writeInt(b.size); o.write(b) }
            o.writeByte(1)
            o.writeInt(0) // photos
            o.writeInt(1) // passwords
            str("id1"); str("Bank"); str("alice"); str("pw"); str("https://b"); str("n")
            o.writeBoolean(true); o.writeLong(42)
        }
        val idx = VaultIndex.fromBytes(bos.toByteArray())
        val p = idx.passwords.single()
        assertEquals("pw", p.password)
        assertEquals(42L, p.updatedAt)
        assertTrue(p.history.isEmpty())
    }

    // ---- encryption audit ----

    private val canaries = listOf(
        "CANARY-PASSWORD-7f3a", "CANARY-OLD-PASSWORD-91bc", "CANARY-USER-alice", "CANARY-TITLE-Bank",
        "CANARY-URL-https://bank.example", "CANARY-NOTES-pin-1234", "CANARY-PHOTO-NAME.jpg",
        "CANARY-PHOTO-BYTES", "CANARY-THUMB-BYTES", "CANARY-TAG",
    )

    /** Returns the canaries found in [data], looking for both UTF-8 and UTF-16 spellings. */
    private fun leaks(data: ByteArray): List<String> {
        val hay = String(data, Charsets.ISO_8859_1)
        val hay16 = String(data, Charsets.UTF_16LE)
        val hay16b = String(data, Charsets.UTF_16BE)
        return canaries.filter { c ->
            hay.contains(c, ignoreCase = true) || hay16.contains(c, ignoreCase = true) || hay16b.contains(c, ignoreCase = true)
        }
    }

    private fun entropyBitsPerByte(d: ByteArray): Double {
        val counts = IntArray(256)
        d.forEach { counts[it.toInt() and 0xFF]++ }
        return -counts.filter { it > 0 }.sumOf { c -> (c.toDouble() / d.size).let { it * Math.log(it) / Math.log(2.0) } }
    }

    @Test fun auditNoPlaintextAnywhereOnDiskOrInBackups() {
        val root = tmp()
        val vmk = VaultKeys.newMasterKey()
        val rk = RecoveryKey.generate()
        File(root, VaultLayout.KEYS).mkdirs()
        VaultStore.atomicWrite(File(root, VaultLayout.RECOVERY_WRAP), VaultKeys.wrapWithRecovery(vmk, rk))
        val store = VaultStore(root, vmk)
        val photoBytes = ("CANARY-PHOTO-BYTES" + "x".repeat(5000)).toByteArray()
        store.addPhoto("CANARY-PHOTO-NAME.jpg", photoBytes.inputStream(), "CANARY-THUMB-BYTES".toByteArray())
        store.upsertPassword(
            PasswordItem("p1", "CANARY-TITLE-Bank", "CANARY-USER-alice", "CANARY-OLD-PASSWORD-91bc",
                "CANARY-URL-https://bank.example", "CANARY-NOTES-pin-1234"),
        )
        store.upsertPassword(
            PasswordItem("p1", "CANARY-TITLE-Bank", "CANARY-USER-alice", "CANARY-PASSWORD-7f3a",
                "CANARY-URL-https://bank.example", "CANARY-NOTES-pin-1234"),
        )
        assertEquals(1, store.index.passwords.single().history.size)

        // Control: the scanner must actually be able to see a plaintext leak.
        assertTrue(leaks("xx CANARY-PASSWORD-7f3a xx".toByteArray()).isNotEmpty())
        assertTrue(leaks("CANARY-PASSWORD-7f3a".toByteArray(Charsets.UTF_16LE)).isNotEmpty())

        val files = root.walkTopDown().filter { it.isFile }.toList()
        assertTrue(files.size >= 4, "expected index, recovery wrap, photo and thumbnail: ${files.map { it.name }}")
        assertTrue(files.none { it.name.endsWith(".tmp") }, "temp files left behind")
        for (f in files) {
            val b = f.readBytes()
            assertEquals(emptyList(), leaks(b), "plaintext found in ${f.name}")
            assertTrue(!f.name.contains("CANARY", ignoreCase = true), "plaintext in file name ${f.name}")
        }
        // The big photo blob must look like random data, not a lightly scrambled copy of the input.
        val blob = files.first { it.name.endsWith(".msb") && !it.name.contains("thumb") }.readBytes()
        assertTrue(entropyBitsPerByte(blob) > 7.9, "photo blob entropy too low: ${entropyBitsPerByte(blob)}")

        val bos = ByteArrayOutputStream()
        BackupFile.write(store, root, bos)
        assertEquals(emptyList(), leaks(bos.toByteArray()), "plaintext found in backup file")
        assertTrue(entropyBitsPerByte(bos.toByteArray()) > 7.5)

        // Same plaintext encrypts differently every time (fresh nonces / per-file keys).
        val kek = VaultKeys.fileKek(vmk)
        assertTrue(!BlobCipher.encrypt(kek, photoBytes).contentEquals(BlobCipher.encrypt(kek, photoBytes)))
    }
}
