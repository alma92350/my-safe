package app.mysafe

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import app.mysafe.core.RecoveryKey
import app.mysafe.core.VaultKeys
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private enum class Step { Intro, ShowKey, ConfirmKey, Restore }

@Composable
fun SetupScreen(act: MainActivity) {
    val vault = act.vault
    var step by remember { mutableStateOf(Step.Intro) }
    val vmk = remember { VaultKeys.newMasterKey() }
    val recovery = remember { RecoveryKey.generate() }
    var error by remember { mutableStateOf<String?>(null) }

    Page {
        Text("Set up My-Safe", style = MaterialTheme.typography.headlineMedium)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        when (step) {
            Step.Intro -> {
                Text(
                    "Your photos, screenshots and passwords are encrypted on this phone and open only with your " +
                        "fingerprint (or your phone PIN if you allow it).\n\n" +
                        "You will get a recovery key. It is the only way back in if your fingerprints change, " +
                        "you reset the phone, or you restore a backup. Nobody, including us, can recover it for you.",
                )
                Button({ step = Step.ShowKey }, Modifier.fillMaxWidth()) { Text("Create my vault") }
                TextButton({ step = Step.Restore }) { Text("Restore from a backup file") }
            }

            Step.ShowKey -> {
                Text("Write this recovery key down and keep it somewhere safe (not on this phone). It is shown only once.")
                Text(
                    recovery.groups().chunked(4).joinToString("\n") { it.joinToString("  ") },
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.titleLarge,
                )
                Button({ step = Step.ConfirmKey }, Modifier.fillMaxWidth()) { Text("I have saved it") }
            }

            Step.ConfirmKey -> {
                val groups = recovery.groups()
                val asked = remember { (0 until RecoveryKey.GROUP_COUNT).shuffled().take(3).sorted() }
                val answers = remember { mutableStateOf(List(3) { "" }) }
                Text("To make sure you saved it, enter these groups of your recovery key.")
                asked.forEachIndexed { i, g ->
                    OutlinedTextField(
                        answers.value[i],
                        { v -> answers.value = answers.value.toMutableList().also { it[i] = v } },
                        Modifier.fillMaxWidth(),
                        label = { Text("Group ${g + 1}") },
                        singleLine = true,
                    )
                }
                Button(
                    onClick = {
                        val ok = asked.indices.all { answers.value[it].trim().uppercase() == groups[asked[it]] }
                        if (!ok) {
                            error = "Those groups don't match. Check what you wrote down."
                        } else {
                            error = null
                            vault.completeSetup(act, vmk, recovery) { err -> error = err }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Confirm and protect with fingerprint") }
                TextButton({ step = Step.ShowKey }) { Text("Show the key again") }
            }

            Step.Restore -> RestoreFlow(act, onBack = { step = Step.Intro }, onError = { error = it })
        }
    }
}

@Composable
private fun RestoreFlow(act: MainActivity, onBack: () -> Unit, onError: (String?) -> Unit) {
    val vault = act.vault
    var picked by remember { mutableStateOf<android.net.Uri?>(null) }
    var keyText by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { picked = it }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Pick your backup file, then enter the recovery key you saved when you created the vault.")
        Button({
            vault.externalInFlight = true
            picker.launch(arrayOf("*/*"))
        }, Modifier.fillMaxWidth()) { Text(if (picked == null) "Choose backup file" else "Backup file selected") }
        OutlinedTextField(keyText, { keyText = it }, Modifier.fillMaxWidth(), label = { Text("Recovery key") })
        Button(
            enabled = picked != null && keyText.isNotBlank() && !busy,
            onClick = {
                val key = try { RecoveryKey.parse(keyText) } catch (e: IllegalArgumentException) { return@Button onError(e.message) }
                busy = true
                onError(null)
                scope.launch {
                    val vmk = try {
                        withContext(Dispatchers.IO) { vault.restoreFiles(picked!!, key) }
                    } catch (e: Exception) {
                        busy = false
                        return@launch onError(e.message ?: "Restore failed")
                    }
                    vault.finishRestore(act, vmk) { err -> busy = false; onError(err) }
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (busy) "Restoring…" else "Restore") }
        TextButton(onBack) { Text("Back") }
    }
}
