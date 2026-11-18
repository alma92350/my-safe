package app.mysafe

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.mysafe.core.PasswordItem
import app.mysafe.core.PhotoItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(act: MainActivity) {
    val vault = act.vault
    var tab by remember { mutableIntStateOf(0) }
    var viewing by remember { mutableStateOf<PhotoItem?>(null) }
    var editing by remember { mutableStateOf<PasswordItem?>(null) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val toast: (String) -> Unit = { msg -> scope.launch { snackbar.showSnackbar(msg) } }

    // Photos shared into My-Safe from other apps are imported as soon as the vault is open.
    LaunchedEffect(vault.pendingShares.size) {
        if (vault.pendingShares.isNotEmpty()) {
            val uris = vault.pendingShares.toList()
            vault.pendingShares.clear()
            val r = withContext(Dispatchers.IO) { vault.importUris(uris) }
            toast("Imported ${r.imported.size} photo(s)" + if (r.failed > 0) ", ${r.failed} failed" else "")
        }
    }

    BackHandler(enabled = viewing != null || editing != null) { viewing = null; editing = null }

    val photo = viewing
    val pw = editing
    when {
        photo != null -> PhotoViewer(vault, photo, onClose = { viewing = null })
        pw != null -> PasswordEditor(act, pw, onClose = { editing = null }, toast = toast)
        else -> Column(Modifier.fillMaxSize()) {
            TabRow(selectedTabIndex = tab) {
                listOf("Photos", "Passwords", "Settings").forEachIndexed { i, t ->
                    Tab(selected = tab == i, onClick = { tab = i }, text = { Text(t) })
                }
            }
            Column(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp)) {
                when (tab) {
                    0 -> PhotosTab(act, onOpen = { viewing = it }, toast = toast)
                    1 -> PasswordsTab(act, onEdit = { editing = it })
                    else -> SettingsTab(act, toast = toast)
                }
            }
            SnackbarHost(snackbar)
        }
    }
}
