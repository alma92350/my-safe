package app.mysafe.core

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream

/**
 * Encrypted single-file backup. It contains no new secrets: the VMK wrapped by the recovery key,
 * the sealed index, and every blob exactly as stored on disk (already encrypted). Restoring needs
 * only the recovery key.
 *
 * Layout: "MSBK1" | int len | recoveryWrap | int len | sealedIndex | int count |
 *         { UTF name | long len | bytes }*
 */
object BackupFile {
    private val MAGIC = "MSBK1".toByteArray()

    fun write(store: VaultStore, root: File, out: OutputStream) {
        val d = DataOutputStream(out.buffered())
        val wrap = File(root, VaultLayout.RECOVERY_WRAP).readBytes()
        val index = File(root, VaultLayout.INDEX).readBytes()
        val names = store.index.photos.flatMap { listOfNotNull(it.blobName, it.thumbName) }
        d.write(MAGIC)
        d.writeInt(wrap.size); d.write(wrap)
        d.writeInt(index.size); d.write(index)
        d.writeInt(names.size)
        for (n in names) {
            val f = store.blobFile(n)
            d.writeUTF(n)
            d.writeLong(f.length())
            f.inputStream().use { it.copyTo(d) }
        }
        d.flush()
    }

    /**
     * Restores into [root] (which should be empty) and returns the recovered VMK.
     * Throws [VaultCryptoException] on a wrong key or a damaged/incomplete backup.
     */
    fun restore(input: InputStream, root: File, key: RecoveryKey): ByteArray {
        val d = DataInputStream(input.buffered())
        try {
            val magic = ByteArray(MAGIC.size).also { d.readFully(it) }
            if (!magic.contentEquals(MAGIC)) throw VaultCryptoException("Not a My-Safe backup")
            val wrap = readChunk(d)
            val vmk = VaultKeys.unwrapWithRecovery(wrap, key)
            val sealedIndex = readChunk(d)
            val index = VaultIndex.fromBytes(Crypto.open(VaultKeys.indexKey(vmk), sealedIndex, VaultStore.INDEX_AAD))

            val blobDir = File(root, VaultLayout.BLOBS).apply { mkdirs() }
            val seen = HashSet<String>()
            repeat(d.readInt()) {
                val name = d.readUTF()
                val len = d.readLong()
                require(VaultLayout.SAFE_BLOB_NAME.matches(name) && len >= 0) { "Corrupt backup" }
                val tmp = File(blobDir, "$name.tmp")
                tmp.outputStream().use { o -> copyExactly(d, o, len) }
                if (!tmp.renameTo(File(blobDir, name))) throw VaultCryptoException("Could not write $name")
                seen += name
            }
            val missing = index.photos.flatMap { listOfNotNull(it.blobName, it.thumbName) }.filter { it !in seen }
            if (missing.isNotEmpty()) throw VaultCryptoException("Backup is incomplete (${missing.size} files missing)")

            VaultStore.atomicWrite(File(root, VaultLayout.RECOVERY_WRAP), wrap)
            VaultStore.atomicWrite(File(root, VaultLayout.INDEX), sealedIndex)
            return vmk
        } catch (e: java.io.EOFException) {
            throw VaultCryptoException("Backup is truncated", e)
        }
    }

    private fun readChunk(d: DataInputStream): ByteArray {
        val n = d.readInt()
        require(n in 0..(512 * 1024 * 1024)) { "Corrupt backup" }
        return ByteArray(n).also { d.readFully(it) }
    }

    private fun copyExactly(from: DataInputStream, to: OutputStream, len: Long) {
        val buf = ByteArray(64 * 1024)
        var left = len
        while (left > 0) {
            val r = from.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (r < 0) throw java.io.EOFException()
            to.write(buf, 0, r)
            left -= r
        }
    }
}
