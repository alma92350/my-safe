package app.mysafe

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import app.mysafe.core.PasswordGenerator
import app.mysafe.core.PasswordItem

@Composable
fun PasswordsTab(act: MainActivity, onEdit: (PasswordItem) -> Unit) {
    val vault = act.vault
    var query by remember { mutableStateOf("") }
    val rev = vault.revision
    val all = if (rev >= 0) vault.store?.index?.passwords?.toList().orEmpty() else emptyList()
    val shown = all.filter { query.isBlank() || it.title.contains(query, true) || it.username.contains(query, true) }

    Column(Modifier.padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Button({ onEdit(PasswordItem(vault.newPasswordId(), "", "", "")) }, Modifier.fillMaxWidth()) { Text("Add password") }
        OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), label = { Text("Search") }, singleLine = true)
        if (all.isEmpty()) Text("No passwords yet.")
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(shown, key = { it.id }) { p ->
                Card(Modifier.fillMaxWidth().clickable { onEdit(p) }) {
                    Column(Modifier.padding(16.dp)) {
                        Text(p.title.ifBlank { "(untitled)" }, style = MaterialTheme.typography.titleMedium)
                        if (p.username.isNotBlank()) Text(p.username, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
    }
}

@Composable
fun PasswordEditor(act: MainActivity, initial: PasswordItem, onClose: () -> Unit, toast: (String) -> Unit) {
    val vault = act.vault
    val isNew = vault.store?.index?.passwords?.none { it.id == initial.id } ?: true
    var title by remember { mutableStateOf(initial.title) }
    var user by remember { mutableStateOf(initial.username) }
    var pass by remember { mutableStateOf(initial.password) }
    var url by remember { mutableStateOf(initial.url) }
    var notes by remember { mutableStateOf(initial.notes) }
    var reveal by remember { mutableStateOf(isNew) }
    var confirmDelete by remember { mutableStateOf(false) }

    Page {
        Text(if (isNew) "New password" else "Edit password", style = MaterialTheme.typography.titleLarge)
        OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth(), label = { Text("Title") }, singleLine = true)
        OutlinedTextField(user, { user = it }, Modifier.fillMaxWidth(), label = { Text("Username") }, singleLine = true)
        OutlinedTextField(
            pass, { pass = it }, Modifier.fillMaxWidth(), label = { Text("Password") }, singleLine = true,
            visualTransformation = if (reveal) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
        )
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({
                if (reveal) reveal = false
                else vault.requireRecentAuth(act, { reveal = true }, { toast(it) })
            }) { Text(if (reveal) "Hide" else "Reveal") }
            OutlinedButton({
                vault.requireRecentAuth(act, { vault.copySensitive(pass); toast("Copied. Clipboard clears in 30 s") }, { toast(it) })
            }) { Text("Copy password") }
            OutlinedButton({ pass = PasswordGenerator.generate(); reveal = true }) { Text("Generate strong password") }
        }
        OutlinedTextField(url, { url = it }, Modifier.fillMaxWidth(), label = { Text("Website") }, singleLine = true)
        OutlinedTextField(notes, { notes = it }, Modifier.fillMaxWidth(), label = { Text("Notes") }, minLines = 3)
        Button({
            vault.savePassword(initial.copy(title = title.trim(), username = user.trim(), password = pass, url = url.trim(), notes = notes))
            onClose()
        }, Modifier.fillMaxWidth(), enabled = title.isNotBlank()) { Text("Save") }
        TextButton(onClose) { Text("Cancel") }
        if (!isNew) TextButton({ confirmDelete = true }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
    }
    if (confirmDelete) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        title = { Text("Delete this password?") },
        confirmButton = { TextButton({ vault.deletePassword(initial.id); onClose() }) { Text("Delete") } },
        dismissButton = { TextButton({ confirmDelete = false }) { Text("Cancel") } },
    )
}
