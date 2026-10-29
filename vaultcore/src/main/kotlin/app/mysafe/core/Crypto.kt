package app.mysafe.core

import java.security.GeneralSecurityException
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class VaultCryptoException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** Small AES-256-GCM / HKDF toolbox shared by the app and the tests. */
object Crypto {
    const val KEY_LEN = 32
    const val NONCE_LEN = 12
    const val TAG_BITS = 128

    private val rng = SecureRandom()

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { rng.nextBytes(it) }

    /** Returns nonce || ciphertext || tag. */
    fun seal(key: ByteArray, plain: ByteArray, aad: ByteArray = ByteArray(0)): ByteArray {
        val nonce = randomBytes(NONCE_LEN)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
        c.updateAAD(aad)
        return nonce + c.doFinal(plain)
    }

    fun open(key: ByteArray, sealed: ByteArray, aad: ByteArray = ByteArray(0)): ByteArray {
        if (sealed.size < NONCE_LEN + TAG_BITS / 8) throw VaultCryptoException("Ciphertext too short")
        try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(TAG_BITS, sealed, 0, NONCE_LEN),
            )
            c.updateAAD(aad)
            return c.doFinal(sealed, NONCE_LEN, sealed.size - NONCE_LEN)
        } catch (e: GeneralSecurityException) {
            throw VaultCryptoException("Authentication failed (wrong key or corrupted data)", e)
        }
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val m = Mac.getInstance("HmacSHA256")
        m.init(SecretKeySpec(key, "HmacSHA256"))
        return m.doFinal(data)
    }

    /** HKDF-SHA256 with a zero salt; output up to 32 bytes (one expand block). */
    fun hkdf(ikm: ByteArray, info: String): ByteArray {
        val prk = hmac(ByteArray(32), ikm)
        return hmac(prk, info.toByteArray(Charsets.UTF_8) + 0x01)
    }
}
