package app.mysafe

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/**
 * Hardware-backed AES key that wraps the vault master key. It requires a fresh fingerprint
 * (or, if allowed, the device PIN/pattern/password) for every single use, and is invalidated
 * when a new fingerprint is enrolled.
 */
object DeviceKey {
    private const val PROVIDER = "AndroidKeyStore"
    val ALIASES = listOf("mysafe_device_key_a", "mysafe_device_key_b")

    private fun ks(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    fun exists(alias: String) = ks().containsAlias(alias)

    fun delete(alias: String) {
        if (exists(alias)) ks().deleteEntry(alias)
    }

    fun create(alias: String, allowDeviceCredential: Boolean) {
        delete(alias)
        try {
            generate(alias, allowDeviceCredential, strongBox = true)
        } catch (e: StrongBoxUnavailableException) {
            generate(alias, allowDeviceCredential, strongBox = false)
        }
    }

    private fun generate(alias: String, allowDeviceCredential: Boolean, strongBox: Boolean) {
        val types = if (allowDeviceCredential) {
            KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
        } else {
            KeyProperties.AUTH_BIOMETRIC_STRONG
        }
        val spec = KeyGenParameterSpec.Builder(
            alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(0, types) // 0 = authenticate for every use
            .setInvalidatedByBiometricEnrollment(true)
            .setIsStrongBoxBacked(strongBox)
            .build()
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER).apply { init(spec) }.generateKey()
    }

    private fun key(alias: String): SecretKey = ks().getKey(alias, null) as SecretKey

    /** Throws [android.security.keystore.KeyPermanentlyInvalidatedException] if fingerprints changed. */
    fun encryptCipher(alias: String): Cipher =
        Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key(alias)) }

    fun decryptCipher(alias: String, iv: ByteArray): Cipher =
        Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(alias), GCMParameterSpec(128, iv)) }

    fun protectionLevel(alias: String): String = try {
        val k = key(alias)
        val info = SecretKeyFactory.getInstance(k.algorithm, PROVIDER).getKeySpec(k, KeyInfo::class.java) as KeyInfo
        if (Build.VERSION.SDK_INT >= 31) {
            when (info.securityLevel) {
                KeyProperties.SECURITY_LEVEL_STRONGBOX -> "StrongBox (dedicated secure chip)"
                KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "Trusted Execution Environment"
                else -> "Software only (weak)"
            }
        } else if (info.isInsideSecureHardware) "Secure hardware" else "Software only (weak)"
    } catch (e: Exception) {
        "Unknown"
    }
}
