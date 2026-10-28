package app.mysafe.core

import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID

/** On-disk layout inside [root]: index.bin, the blobs and keys directories. */
object VaultLayout {
    const val INDEX = "index.bin"
    const val BLOBS = "blobs"
    const val KEYS = "keys"
    const val RECOVERY_WRAP = "keys/recovery.bin"
    const val DEVICE_WRAP = "keys/device.bin"
    val SAFE_BLOB_NAME = Regex("^[A-Za-z0-9._-]{1,80}\\.msb$")
}

/**
 * Encrypted vault on disk. Everything written here is ciphertext; the VMK lives only in memory.
 * Writes are atomic (temp file + rename) so a crash never leaves a half-written file visible.
 */
class VaultStore(private val root: File, vmk: ByteArray) {
    private val vmk = vmk.copyOf()
    private val indexKey = VaultKeys.indexKey(vmk)
    private val kek = VaultKeys.fileKek(vmk)
    private val blobDir = File(root, VaultLayout.BLOBS).apply { mkdirs() }

    var index: VaultIndex = loadIndex()
        private set

    val masterKeyCopy: ByteArray get() = vmk.copyOf()

    private fun loadIndex(): VaultIndex {
        val f = File(root, VaultLayout.INDEX)
        if (!f.exists()) return VaultIndex()
        return VaultIndex.fromBytes(Crypto.open(indexKey, f.readBytes(), INDEX_AAD))
    }

    private fun saveIndex() =
        atomicWrite(File(root, VaultLayout.INDEX), Crypto.seal(indexKey, index.toBytes(), INDEX_AAD))

    fun addPhoto(name: String, source: InputStream, thumbnail: ByteArray?): PhotoItem {
        val id = UUID.randomUUID().toString()
        val blob = "$id.msb"
        val thumb = thumbnail?.let { "$id.thumb.msb" }
        writeBlob(blob) { out -> BlobCipher.encrypt(kek, source, out) }
        if (thumb != null) writeBlob(thumb) { out -> BlobCipher.encrypt(kek, thumbnail.inputStream(), out) }
        val item = PhotoItem(id, name, System.currentTimeMillis(), blob, thumb)
        index.photos.add(0, item)
        saveIndex()
        return item
    }

    fun readPhoto(item: PhotoItem): ByteArray = readBlob(item.blobName)

    fun readThumbnail(item: PhotoItem): ByteArray? = item.thumbName?.let { readBlob(it) }

    fun deletePhoto(item: PhotoItem) {
        index.photos.removeAll { it.id == item.id }
        saveIndex()
        File(blobDir, item.blobName).delete()
        item.thumbName?.let { File(blobDir, it).delete() }
    }

    fun upsertPassword(item: PasswordItem) {
        val stamped = item.copy(updatedAt = System.currentTimeMillis())
        val i = index.passwords.indexOfFirst { it.id == item.id }
        if (i >= 0) index.passwords[i] = stamped else index.passwords.add(0, stamped)
        saveIndex()
    }

    fun deletePassword(id: String) {
        index.passwords.removeAll { it.id == id }
        saveIndex()
    }

    fun blobFile(name: String): File {
        require(VaultLayout.SAFE_BLOB_NAME.matches(name)) { "Unsafe blob name" }
        return File(blobDir, name)
    }

    private fun readBlob(name: String): ByteArray =
        blobFile(name).inputStream().use { BlobCipher.decrypt(kek, it.readBytes()) }

    private fun writeBlob(name: String, writer: (java.io.OutputStream) -> Unit) {
        val target = blobFile(name)
        val tmp = File(blobDir, "$name.tmp")
        tmp.outputStream().use { writer(it) }
        Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }

    /** Zeroes in-memory keys. The store must not be used afterwards. */
    fun close() {
        vmk.fill(0); indexKey.fill(0); kek.fill(0)
    }

    companion object {
        internal val INDEX_AAD = "mysafe-index-v1".toByteArray()

        fun atomicWrite(target: File, data: ByteArray) {
            target.parentFile?.mkdirs()
            val tmp = File(target.parentFile, target.name + ".tmp")
            tmp.writeBytes(data)
            Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        }
    }
}
