package app.mysafe

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat

class MainActivity : AppCompatActivity() {
    val vault: VaultManager get() = (application as MySafeApp).vault
    private var stoppedAt = 0L

    private val screenOff = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (!vault.externalInFlight) vault.lock()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Blocks screenshots, screen recording and the recent-apps thumbnail.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        ContextCompat.registerReceiver(this, screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF), ContextCompat.RECEIVER_NOT_EXPORTED)
        collectShares(intent)
        setContent { MySafeTheme { AppRoot(this) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        collectShares(intent)
    }

    private fun collectShares(intent: Intent?) {
        val uris: List<Uri> = when (intent?.action) {
            Intent.ACTION_SEND ->
                listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE ->
                IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java) ?: emptyList()
            else -> emptyList()
        }
        vault.pendingShares.addAll(uris)
    }

    override fun onStart() {
        super.onStart()
        val v = vault
        val away = if (stoppedAt == 0L) 0L else SystemClock.elapsedRealtime() - stoppedAt
        if (!v.externalInFlight && stoppedAt != 0L && away >= v.autoLockSeconds * 1000L) v.lock()
        v.externalInFlight = false
        stoppedAt = 0L
    }

    override fun onResume() {
        super.onResume()
        tryUnlock()
    }

    override fun onStop() {
        super.onStop()
        if (vault.externalInFlight) return
        stoppedAt = SystemClock.elapsedRealtime()
        if (vault.autoLockSeconds == 0) vault.lock()
    }

    override fun onDestroy() {
        unregisterReceiver(screenOff)
        if (isFinishing) vault.lock()
        super.onDestroy()
    }

    /** Shows the fingerprint prompt when the vault is locked and ready to be opened. */
    fun tryUnlock() {
        val v = vault
        if (v.unlocked || !v.setUp || v.needsRecovery || v.promptInFlight) return
        v.unlock(this) { err -> v.status = err }
    }
}
