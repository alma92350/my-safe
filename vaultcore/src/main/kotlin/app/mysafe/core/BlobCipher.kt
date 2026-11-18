package app.mysafe.core

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Streaming file encryption (STREAM construction over AES-256-GCM).
 *
 * Layout: "MSB1" | u16 wrappedDekLen | wrappedDek | 7-byte nonce prefix | chunks.
 * Each chunk is encrypted with nonce = prefix || u32 counter || lastFlag, so reordering,
 * dropping or truncating chunks fails authentication. A fresh random data key (DEK) is
 * generated per file and wrapped under the vault's file KEK.
 */
object BlobCipher {
    const val CHUNK = 64 * 1024
    private val MAGIC = "MSB1".toByteArray()
    private val DEK_AAD = "mysafe-dek-v1".toByteArray()
    private const val PREFIX_LEN = 7

    fun encrypt(kek: ByteArray, input: InputStream, output: OutputStream) {
        val dek = Crypto.randomBytes(Crypto.KEY_LEN)
        val out = DataOutputStream(output)
        out.write(MAGIC)
        val wrapped = Crypto.seal(kek, dek, DEK_AAD)
        out.writeShort(wrapped.size)
        out.write(wrapped)
        val prefix = Crypto.randomBytes(PREFIX_LEN)
        out.write(prefix)

        var current = readFully(input, CHUNK)
        var counter = 0
        while (true) {
            val next = readFully(input, CHUNK)
            val last = next.isEmpty()
            out.write(crypt(Cipher.ENCRYPT_MODE, dek, nonce(prefix, counter, last), current))
            if (last) break
            current = next
            counter++
        }
        out.flush()
        dek.fill(0)
    }

    fun decrypt(kek: ByteArray, input: InputStream, output: OutputStream) {
        val din = DataInputStream(input)
        val magic = ByteArray(MAGIC.size)
        try {
            din.readFully(magic)
            if (!magic.contentEquals(MAGIC)) throw VaultCryptoException("Not a My-Safe file")
            val wrapped = ByteArray(din.readUnsignedShort())
            din.readFully(wrapped)
            val prefix = ByteArray(PREFIX_LEN)
            din.readFully(prefix)
            val dek = Crypto.open(kek, wrapped, DEK_AAD)
            try {
                val enc = CHUNK + Crypto.TAG_BITS / 8
                var current = readFully(din, enc)
                if (current.isEmpty()) throw VaultCryptoException("Truncated file")
                var counter = 0
                while (true) {
                    val next = readFully(din, enc)
                    val last = next.isEmpty()
                    output.write(crypt(Cipher.DECRYPT_MODE, dek, nonce(prefix, counter, last), current))
                    if (last) break
                    current = next
                    counter++
                }
                output.flush()
            } finally {
                dek.fill(0)
            }
        } catch (e: EOFException) {
            throw VaultCryptoException("Truncated file", e)
        }
    }

    fun encrypt(kek: ByteArray, plain: ByteArray): ByteArray =
        ByteArrayOutputStream().also { encrypt(kek, ByteArrayInputStream(plain), it) }.toByteArray()

    fun decrypt(kek: ByteArray, blob: ByteArray): ByteArray =
        ByteArrayOutputStream().also { decrypt(kek, ByteArrayInputStream(blob), it) }.toByteArray()

    private fun nonce(prefix: ByteArray, counter: Int, last: Boolean): ByteArray {
        val n = ByteArray(Crypto.NONCE_LEN)
        prefix.copyInto(n)
        for (i in 0 until 4) n[PREFIX_LEN + i] = (counter ushr (24 - 8 * i)).toByte()
        n[11] = if (last) 1 else 0
        return n
    }

    private fun crypt(mode: Int, key: ByteArray, nonce: ByteArray, data: ByteArray): ByteArray {
        try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(Crypto.TAG_BITS, nonce))
            return c.doFinal(data)
        } catch (e: java.security.GeneralSecurityException) {
            throw VaultCryptoException("Authentication failed (wrong key or corrupted data)", e)
        }
    }

    /** Reads up to [n] bytes, returning fewer only at end of stream. */
    private fun readFully(input: InputStream, n: Int): ByteArray {
        val buf = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = input.read(buf, off, n - off)
            if (r < 0) break
            off += r
        }
        return if (off == n) buf else buf.copyOf(off)
    }
}
