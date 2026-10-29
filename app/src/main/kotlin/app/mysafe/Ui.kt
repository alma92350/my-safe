package app.mysafe

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.mysafe.core.RecoveryKey

@Composable
fun MySafeTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val ctx = LocalContext.current
    val scheme = when {
        Build.VERSION.SDK_INT >= 31 -> if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        dark -> darkColorScheme()
        else -> lightColorScheme()
    }
    MaterialTheme(colorScheme = scheme) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            // targetSdk 35 draws edge-to-edge, so keep content clear of the status bar, nav bar and keyboard.
            Box(Modifier.fillMaxSize().safeDrawingPadding()) { content() }
        }
    }
}

@Composable
fun AppRoot(act: MainActivity) {
    val vault = act.vault
    when {
        vault.unlocked -> MainScreen(act)
        !vault.setUp -> SetupScreen(act)
        else -> LockScreen(act)
    }
}

@Composable
fun Page(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) { content() }
}

@Composable
fun LockScreen(act: MainActivity) {
    val vault = act.vault
    var showRecovery by remember { mutableStateOf(vault.needsRecovery) }
    var message by remember { mutableStateOf<String?>(null) }
    var confirmErase by remember { mutableStateOf(false) }
    Page(Modifier) {
        Text("My-Safe", style = MaterialTheme.typography.headlineLarge)
        Text("Your vault is locked.")
        (message ?: vault.status)?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (!vault.needsRecovery) Button({ act.tryUnlock() }, Modifier.fillMaxWidth()) { Text("Unlock") }
        if (vault.needsRecovery && !vault.hasRecoveryKey) {
            Text("This vault was set up without a recovery key, so it can't be opened again.")
            Button({ confirmErase = true }, Modifier.fillMaxWidth()) { Text("Erase and start over") }
        } else if (vault.hasRecoveryKey) {
            if (!showRecovery && !vault.needsRecovery) {
                TextButton({ showRecovery = true }) { Text("Use recovery key instead") }
            } else {
                RecoveryEntry(act, onMessage = { message = it })
            }
        }
    }
    if (confirmErase) AlertDialog(
        onDismissRequest = { confirmErase = false },
        title = { Text("Erase everything?") },
        text = { Text("All photos and passwords in this vault are permanently deleted.") },
        confirmButton = { TextButton({ confirmErase = false; vault.wipe() }) { Text("Erase", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton({ confirmErase = false }) { Text("Cancel") } },
    )
}

@Composable
fun RecoveryEntry(act: MainActivity, onMessage: (String?) -> Unit) {
    var text by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Enter your 52-character recovery key.")
        OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth(), label = { Text("Recovery key") })
        Button(
            onClick = {
                val key = try {
                    RecoveryKey.parse(text)
                } catch (e: IllegalArgumentException) {
                    return@Button onMessage(e.message)
                }
                act.vault.recover(act, key) { err -> onMessage(err) }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Unlock with recovery key") }
    }
}

@Composable
fun RowSpaced(content: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { content() }
}
