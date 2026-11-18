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

/** An earlier password of an entry, kept so a mistaken change can be undone. */
data class PasswordVersion(val password: String, val changedAt: Long)

data class PasswordItem(
    val id: String,
    val title: String,
    val username: String,
    val password: String,
    val url: String = "",
    val notes: String = "",
    val favourite: Boolean = false,
    val updatedAt: Long = 0,
    /** Newest first. Maintained by [VaultStore.upsertPassword]; callers don't set it. */
    val history: List<PasswordVersion> = emptyList(),
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
                o.writeInt(p.history.size)
                for (h in p.history) { o.str(h.password); o.writeLong(h.changedAt) }
            }
        }
        return bos.toByteArray()
    }

    companion object {
        private const val VERSION = 2 // v1 had no password history

        fun fromBytes(data: ByteArray): VaultIndex {
            val i = DataInputStream(ByteArrayInputStream(data))
            val v = i.readUnsignedByte()
            if (v != 1 && v != VERSION) throw VaultCryptoException("Unsupported index version $v")
            val idx = VaultIndex()
            repeat(i.readInt()) {
                val id = i.str(); val name = i.str(); val at = i.readLong(); val blob = i.str()
                val thumb = i.str().ifEmpty { null }
                val tags = List(i.readInt()) { i.str() }
                idx.photos += PhotoItem(id, name, at, blob, thumb, tags)
            }
            repeat(i.readInt()) {
                val id = i.str(); val title = i.str(); val user = i.str(); val pass = i.str()
                val url = i.str(); val notes = i.str(); val fav = i.readBoolean(); val at = i.readLong()
                val history = if (v >= 2) List(i.readInt()) { PasswordVersion(i.str(), i.readLong()) } else emptyList()
                idx.passwords += PasswordItem(id, title, user, pass, url, notes, fav, at, history)
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
