package app.mysafe

import android.app.Activity
import android.net.Uri
import android.provider.MediaStore
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.mysafe.core.PhotoItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun PhotosTab(act: MainActivity, onOpen: (PhotoItem) -> Unit, toast: (String) -> Unit) {
    val vault = act.vault
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var askDelete by remember { mutableStateOf<List<Uri>>(emptyList()) }

    val deleteLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { res ->
        toast(if (res.resultCode == Activity.RESULT_OK) "Originals deleted from the gallery" else "Originals were kept")
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        if (uris.isNotEmpty()) scope.launch {
            val r = withContext(Dispatchers.IO) { vault.importUris(uris) }
            toast("Imported ${r.imported.size} photo(s)" + if (r.failed > 0) ", ${r.failed} failed" else "")
            askDelete = r.imported
        }
    }

    val rev = vault.revision // re-read the list whenever the vault changes
    val photos = if (rev >= 0) vault.store?.index?.photos?.toList().orEmpty() else emptyList()

    Column(Modifier.fillMaxSize()) {
        Button(
            onClick = {
                vault.externalInFlight = true
                picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            },
            modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
        ) { Text("Import photos / screenshots") }

        if (photos.isEmpty()) {
            Text("No photos yet. You can also share a screenshot straight to My-Safe from the share sheet.")
        } else {
            LazyVerticalGrid(
                columns = GridCells.Fixed(3),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.weight(1f).fillMaxWidth(),
            ) {
                items(photos, key = { it.id }) { p ->
                    val bmp by produceState<android.graphics.Bitmap?>(null, p.id) {
                        value = withContext(Dispatchers.Default) { vault.thumbnail(p) }
                    }
                    Box(Modifier.aspectRatio(1f).clickable { onOpen(p) }, contentAlignment = Alignment.Center) {
                        bmp?.let { Image(it.asImageBitmap(), p.name, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
                    }
                }
            }
        }
    }

    if (askDelete.isNotEmpty()) {
        val uris = askDelete
        AlertDialog(
            onDismissRequest = { askDelete = emptyList() },
            title = { Text("Delete the originals?") },
            text = {
                Text(
                    "The photos are now encrypted in My-Safe. Delete the unprotected copies from your gallery? " +
                        "Android may keep them in the gallery's recycle bin for 30 days: empty it too.",
                )
            },
            confirmButton = {
                TextButton({
                    askDelete = emptyList()
                    try {
                        val pi = MediaStore.createDeleteRequest(ctx.contentResolver, uris)
                        vault.externalInFlight = true
                        deleteLauncher.launch(IntentSenderRequest.Builder(pi.intentSender).build())
                    } catch (e: Exception) {
                        toast("Couldn't delete the originals automatically. Delete them from your gallery.")
                    }
                }) { Text("Delete originals") }
            },
            dismissButton = { TextButton({ askDelete = emptyList() }) { Text("Keep") } },
        )
    }
}

@Composable
fun PhotoViewer(vault: VaultManager, item: PhotoItem, onClose: () -> Unit) {
    val bmp by produceState<android.graphics.Bitmap?>(null, item.id) {
        value = withContext(Dispatchers.Default) { vault.fullImage(item) }
    }
    var scale by remember { mutableFloatStateOf(1f) }
    var offsetX by remember { mutableFloatStateOf(0f) }
    var offsetY by remember { mutableFloatStateOf(0f) }
    val state = rememberTransformableState { zoom, pan, _ ->
        scale = (scale * zoom).coerceIn(1f, 6f)
        offsetX += pan.x; offsetY += pan.y
    }
    var confirm by remember { mutableStateOf(false) }

    Box(Modifier.fillMaxSize()) {
        bmp?.let {
            Image(
                it.asImageBitmap(), item.name,
                Modifier.fillMaxSize().transformable(state).graphicsLayer {
                    scaleX = scale; scaleY = scale; translationX = offsetX; translationY = offsetY
                },
                contentScale = ContentScale.Fit,
            )
        } ?: Text("Decrypting…", Modifier.align(Alignment.Center))
        Button(onClose, Modifier.align(Alignment.TopStart).padding(12.dp)) { Text("Back") }
        Button({ confirm = true }, Modifier.align(Alignment.TopEnd).padding(12.dp)) { Text("Delete") }
    }
    if (confirm) AlertDialog(
        onDismissRequest = { confirm = false },
        title = { Text("Delete this photo?") },
        text = { Text("It will be permanently removed from the vault.") },
        confirmButton = { TextButton({ vault.deletePhoto(item); confirm = false; onClose() }) { Text("Delete") } },
        dismissButton = { TextButton({ confirm = false }) { Text("Cancel") } },
    )
}
