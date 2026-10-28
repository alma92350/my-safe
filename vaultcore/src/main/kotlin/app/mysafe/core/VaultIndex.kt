package app.mysafe.core

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream

data class PhotoItem(
    val id: String,
    val name: String,
    val addedAt: Long,
    val blobName: String,
    val thumbName: String?,
    val tags: List<String> = emptyList(),
)

data class PasswordItem(
    val id: String,
    val title: String,
    val username: String,
    val password: String,
    val url: String = "",
    val notes: String = "",
    val favourite: Boolean = false,
    val updatedAt: Long = 0,
)

/** Metadata and credentials; serialized, then sealed as a whole under the index key. */
class VaultIndex(
    val photos: MutableList<PhotoItem> = mutableListOf(),
    val passwords: MutableList<PasswordItem> = mutableListOf(),
) {
    fun toBytes(): ByteArray {
        val bos = ByteArrayOutputStream()
        DataOutputStream(bos).use { o ->
            o.writeByte(VERSION)
            o.writeInt(photos.size)
            for (p in photos) {
                o.str(p.id); o.str(p.name); o.writeLong(p.addedAt); o.str(p.blobName)
                o.str(p.thumbName ?: "")
                o.writeInt(p.tags.size); p.tags.forEach { o.str(it) }
            }
            o.writeInt(passwords.size)
            for (p in passwords) {
                o.str(p.id); o.str(p.title); o.str(p.username); o.str(p.password)
                o.str(p.url); o.str(p.notes); o.writeBoolean(p.favourite); o.writeLong(p.updatedAt)
            }
        }
        return bos.toByteArray()
    }

    companion object {
        private const val VERSION = 1

        fun fromBytes(data: ByteArray): VaultIndex {
            val i = DataInputStream(ByteArrayInputStream(data))
            val v = i.readUnsignedByte()
            if (v != VERSION) throw VaultCryptoException("Unsupported index version $v")
            val idx = VaultIndex()
            repeat(i.readInt()) {
                val id = i.str(); val name = i.str(); val at = i.readLong(); val blob = i.str()
                val thumb = i.str().ifEmpty { null }
                val tags = List(i.readInt()) { i.str() }
                idx.photos += PhotoItem(id, name, at, blob, thumb, tags)
            }
            repeat(i.readInt()) {
                idx.passwords += PasswordItem(
                    i.str(), i.str(), i.str(), i.str(), i.str(), i.str(),
                    i.readBoolean(), i.readLong(),
                )
            }
            return idx
        }

        private fun DataOutputStream.str(s: String) {
            val b = s.toByteArray(Charsets.UTF_8)
            writeInt(b.size); write(b)
        }

        private fun DataInputStream.str(): String {
            val n = readInt()
            require(n in 0..(16 * 1024 * 1024)) { "Corrupt string length" }
            return ByteArray(n).also { readFully(it) }.toString(Charsets.UTF_8)
        }
    }
}
