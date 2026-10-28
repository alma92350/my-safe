package app.mysafe

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.provider.OpenableColumns
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

object ImageUtil {
    private fun sampleSize(w: Int, h: Int, max: Int): Int {
        var s = 1
        while (w / (s * 2) >= max || h / (s * 2) >= max) s *= 2
        return s
    }

    private fun rotation(exif: Int) = when (exif) {
        ExifInterface.ORIENTATION_ROTATE_90 -> 90f
        ExifInterface.ORIENTATION_ROTATE_180 -> 180f
        ExifInterface.ORIENTATION_ROTATE_270 -> 270f
        else -> 0f
    }

    private fun rotate(bmp: Bitmap, degrees: Float): Bitmap =
        if (degrees == 0f) bmp
        else Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(degrees) }, true)

    /** Decodes encrypted-then-decrypted image bytes to a bitmap no larger than [max] px per side. */
    fun decode(bytes: ByteArray, max: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0) return null
        val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, max) }
        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
        val deg = try {
            rotation(ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1))
        } catch (e: Exception) { 0f }
        return rotate(bmp, deg)
    }

    /** Builds a JPEG thumbnail from a content Uri without keeping the original in memory. */
    fun thumbnail(ctx: Context, uri: Uri, max: Int = 320): ByteArray? {
        val cr = ctx.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0) return null
        val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, max) }
        val bmp = cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null
        val deg = try {
            cr.openInputStream(uri)?.use { rotation(ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1)) } ?: 0f
        } catch (e: Exception) { 0f }
        val out = ByteArrayOutputStream()
        rotate(bmp, deg).compress(Bitmap.CompressFormat.JPEG, 80, out)
        return out.toByteArray()
    }

    fun displayName(ctx: Context, uri: Uri): String {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) return it.getString(0) ?: "image"
        }
        return uri.lastPathSegment ?: "image"
    }
}
