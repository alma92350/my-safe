package app.mysafe

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import javax.crypto.Cipher

object Biometrics {
    private fun authenticators(allowCredential: Boolean) =
        if (allowCredential) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_STRONG

    /** True when the phone can authenticate with the requested strength right now. */
    fun available(ctx: Context, allowCredential: Boolean): Boolean =
        BiometricManager.from(ctx).canAuthenticate(authenticators(allowCredential)) == BiometricManager.BIOMETRIC_SUCCESS

    /**
     * Shows the system prompt. With a [cipher] the key is released only on success (the real
     * cryptographic gate); without one it is a plain "is the owner present" check.
     */
    fun prompt(
        activity: FragmentActivity,
        title: String,
        subtitle: String?,
        allowCredential: Boolean,
        cipher: Cipher?,
        onSuccess: (Cipher?) -> Unit,
        onFailure: (userCancelled: Boolean, message: String) -> Unit,
    ) {
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                onSuccess(result.cryptoObject?.cipher)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                val cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                    errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                    errorCode == BiometricPrompt.ERROR_CANCELED
                onFailure(cancelled, errString.toString())
            }
        }
        val builder = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setAllowedAuthenticators(authenticators(allowCredential))
            .setConfirmationRequired(false)
        if (subtitle != null) builder.setSubtitle(subtitle)
        if (!allowCredential) builder.setNegativeButtonText("Cancel")
        val bp = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback)
        if (cipher != null) bp.authenticate(builder.build(), BiometricPrompt.CryptoObject(cipher))
        else bp.authenticate(builder.build())
    }
}
