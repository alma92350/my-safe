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
}
