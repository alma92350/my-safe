package app.mysafe

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import app.mysafe.core.RecoveryKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun SettingsTab(act: MainActivity, toast: (String) -> Unit) {
    val vault = act.vault
    val scope = rememberCoroutineScope()
    var newKey by remember { mutableStateOf<RecoveryKey?>(null) }
    var confirmWipe by remember { mutableStateOf(false) }

    val exporter = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        if (uri != null) scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    act.contentResolver.openOutputStream(uri)!!.use { vault.exportBackup(it) }
                }
                toast("Encrypted backup saved. Restoring it needs your recovery key.")
            } catch (e: Exception) {
                toast("Backup failed: ${e.message}")
            }
        }
    }

    Column(
        Modifier.verticalScroll(rememberScrollState()).padding(vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Auto-lock after leaving the app", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(0 to "Instantly", 30 to "30 s", 60 to "1 min", 300 to "5 min").forEach { (s, label) ->
                FilterChip(vault.autoLockSeconds == s, { vault.setAutoLock(s) }, { Text(label) })
            }
        }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Column(Modifier.weight(1f)) {
                Text("Allow phone PIN as fallback", style = MaterialTheme.typography.titleMedium)
                Text("Off = fingerprint only. Anyone who knows your PIN could open the vault while this is on.")
            }
            Switch(vault.allowDeviceCredential, { on ->
                vault.setAllowCredential(act, on) { err -> toast(err ?: if (on) "PIN fallback enabled" else "Fingerprint only") }
            })
        }

        Text("Key protection: ${vault.keyProtection()}")

        Text("Backup", style = MaterialTheme.typography.titleMedium)
        Text("Creates one encrypted file you can copy to a USB drive or computer. It is useless without your recovery key.")
        Button({
            vault.requireRecentAuth(act, {
                vault.externalInFlight = true
                exporter.launch("my-safe-backup-${SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(Date())}.msbk")
            }, { toast(it) })
        }, Modifier.fillMaxWidth()) { Text("Back up vault") }

        Text("Recovery key", style = MaterialTheme.typography.titleMedium)
        Text("Your recovery key isn't stored on this phone, so it can't be shown again. You can replace it with a new one; old backups then need the old key.")
        OutlinedButton({
            vault.requireRecentAuth(act, { newKey = RecoveryKey.generate() }, { toast(it) })
        }, Modifier.fillMaxWidth()) { Text("Generate a new recovery key") }

        OutlinedButton({ confirmWipe = true }, Modifier.fillMaxWidth()) {
            Text("Erase the vault", color = MaterialTheme.colorScheme.error)
        }
        Text("My-Safe 0.1.0 · no network access · data stays on this phone")
    }

    newKey?.let { key ->
        AlertDialog(
            onDismissRequest = {},
            title = { Text("Your new recovery key") },
            text = {
                Text(
                    "Write it down now. It will not be shown again.\n\n" +
                        key.groups().chunked(4).joinToString("\n") { it.joinToString("  ") },
                    fontFamily = FontFamily.Monospace,
                )
            },
            confirmButton = {
                TextButton({ vault.commitRecoveryKey(key); newKey = null; toast("Recovery key replaced") }) { Text("I have saved it") }
            },
            dismissButton = { TextButton({ newKey = null }) { Text("Cancel") } },
        )
    }

    if (confirmWipe) AlertDialog(
        onDismissRequest = { confirmWipe = false },
        title = { Text("Erase everything?") },
        text = { Text("All photos and passwords are deleted from this phone. You can only get them back from a backup file and your recovery key.") },
        confirmButton = { TextButton({ confirmWipe = false; vault.wipe() }) { Text("Erase", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton({ confirmWipe = false }) { Text("Cancel") } },
    )
}
