package com.millw14.sakura.anime

import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

@CapacitorPlugin(name = "Anime")
class AnimePlugin : Plugin() {

    companion object {
        private const val TAG = "AnimePlugin"
    }

    private val activeCalls = ConcurrentHashMap<String, Call>()
    private val cancelledDownloads = ConcurrentHashMap.newKeySet<String>()

    @PluginMethod
    fun playEpisode(call: PluginCall) {
        val streamUrl = call.getString("streamUrl") ?: ""
        val referer = call.getString("referer") ?: ""
        val title = call.getString("title") ?: "Episode"
        val episodeId = call.getString("episodeId") ?: ""
        val hasNext = call.getBoolean("hasNext", false) ?: false
        val nextEpisodeTitle = call.getString("nextEpisodeTitle") ?: ""
        val introStartSec = call.getDouble("introStart", -1.0) ?: -1.0
        val introEndSec = call.getDouble("introEnd", -1.0) ?: -1.0

        if (streamUrl.isEmpty()) {
            call.reject("Missing streamUrl parameter")
            return
        }

        Log.d(TAG, "playEpisode: stream=$streamUrl referer=$referer")

        activity.runOnUiThread {
            val intent = Intent(context, PlayerActivity::class.java).apply {
                putExtra(PlayerActivity.EXTRA_STREAM_URL, streamUrl)
                putExtra(PlayerActivity.EXTRA_REFERER, referer)
                putExtra(PlayerActivity.EXTRA_TITLE, title)
                putExtra(PlayerActivity.EXTRA_EPISODE_ID, episodeId)
                putExtra(PlayerActivity.EXTRA_HAS_NEXT, hasNext)
                putExtra(PlayerActivity.EXTRA_NEXT_TITLE, nextEpisodeTitle)
                putIntroExtras(this, introStartSec, introEndSec)
            }
            startActivityForResult(call, intent, "handlePlayerResult")
        }
    }

    @PluginMethod
    fun playLocalEpisode(call: PluginCall) {
        val filePath = call.getString("filePath")
        val title = call.getString("title") ?: "Episode"
        val episodeId = call.getString("episodeId") ?: ""
        val hasNext = call.getBoolean("hasNext", false) ?: false
        val nextEpisodeTitle = call.getString("nextEpisodeTitle") ?: ""
        val introStartSec = call.getDouble("introStart", -1.0) ?: -1.0
        val introEndSec = call.getDouble("introEnd", -1.0) ?: -1.0
        if (filePath.isNullOrEmpty()) {
            call.reject("Missing filePath")
            return
        }
        activity.runOnUiThread {
            val intent = Intent(context, PlayerActivity::class.java).apply {
                putExtra(PlayerActivity.EXTRA_STREAM_URL, filePath)
                putExtra(PlayerActivity.EXTRA_TITLE, title)
                putExtra(PlayerActivity.EXTRA_IS_LOCAL, true)
                putExtra(PlayerActivity.EXTRA_EPISODE_ID, episodeId)
                putExtra(PlayerActivity.EXTRA_HAS_NEXT, hasNext)
                putExtra(PlayerActivity.EXTRA_NEXT_TITLE, nextEpisodeTitle)
                putIntroExtras(this, introStartSec, introEndSec)
            }
            startActivityForResult(call, intent, "handlePlayerResult")
        }
    }

    private fun putIntroExtras(intent: Intent, introStartSec: Double, introEndSec: Double) {
        if (introStartSec < 0 || introEndSec <= introStartSec) return
        val startMs = (introStartSec * 1000.0).toLong().coerceAtLeast(0L)
        val endMs = (introEndSec * 1000.0).toLong().coerceAtLeast(startMs + 1L)
        intent.putExtra(PlayerActivity.EXTRA_INTRO_START_MS, startMs)
        intent.putExtra(PlayerActivity.EXTRA_INTRO_END_MS, endMs)
    }

    @PluginMethod
    fun downloadEpisode(call: PluginCall) {
        val episodeId = call.getString("episodeId")
        if (episodeId.isNullOrEmpty()) {
            call.reject("Missing episodeId")
            return
        }
        val m3u8Url = call.getString("m3u8Url") ?: ""
        val referer = call.getString("referer") ?: ""
        val isM3U8 = call.getBoolean("isM3U8", true) ?: true
        val title = call.getString("title") ?: "Episode"
        val animeTitle = call.getString("animeTitle") ?: "Anime"

        if (m3u8Url.isNotEmpty()) {
            startDownload(call, episodeId, m3u8Url, referer, title, animeTitle, isM3U8)
        } else {
            call.reject("Download requires a direct stream URL. Play the episode first.")
        }
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        val episodeId = call.getString("episodeId")
        if (episodeId.isNullOrEmpty()) {
            call.reject("Missing episodeId")
            return
        }
        cancelledDownloads.add(episodeId)
        activeCalls[episodeId]?.cancel()
        notifyDownload(episodeId, 0, "cancelled")
        call.resolve(JSObject().put("cancelled", true))
    }

    private fun startDownload(
        call: PluginCall,
        episodeId: String,
        m3u8Url: String,
        referer: String,
        title: String,
        animeTitle: String,
        isM3U8: Boolean
    ) {
        Thread {
            try {
                cancelledDownloads.remove(episodeId)
                notifyDownload(episodeId, 0, "extracting")

                val client = OkHttpClient.Builder()
                    .connectTimeout(15, TimeUnit.SECONDS)
                    .readTimeout(30, TimeUnit.SECONDS)
                    .build()

                notifyDownload(episodeId, 8, "extracting")

                val safeName = "$animeTitle - $title"
                    .replace(Regex("[^a-zA-Z0-9 \\-]"), "")
                    .trim()
                    .take(200)

                if (!isM3U8 || !m3u8Url.contains(".m3u8", ignoreCase = true)) {
                    val outputStream = createGalleryOutputStream(safeName, "mp4", "video/mp4")
                        ?: throw Exception("Failed to create file in gallery")
                    outputStream.use { out ->
                        downloadFileToStream(client, episodeId, m3u8Url, referer, out)
                    }
                    val filePath = pendingMediaUri?.toString() ?: ""
                    finalizeGalleryEntry()
                    notifyDownload(episodeId, 100, "completed", filePath)
                    call.resolve(JSObject().put("success", true).put("filePath", filePath))
                    return@Thread
                }

                notifyDownload(episodeId, 12, "downloading")
                val m3u8Content = httpGet(client, m3u8Url, referer)
                val baseUrl = m3u8Url.substringBeforeLast("/") + "/"
                var segments = parseM3u8Segments(m3u8Content, baseUrl, m3u8Url)

                if (segments.isEmpty()) throw Exception("No segments in manifest")

                if (segments.size == 1 && segments[0].endsWith(".m3u8")) {
                    notifyDownload(episodeId, 16, "downloading")
                    val variantContent = httpGet(client, segments[0], referer)
                    val variantBase = segments[0].substringBeforeLast("/") + "/"
                    segments = parseM3u8Segments(variantContent, variantBase, segments[0])
                    if (segments.isEmpty()) throw Exception("No segments in variant playlist")
                }

                notifyDownload(episodeId, 20, "downloading")

                val outputStream = createGalleryOutputStream(safeName, "ts", "video/mp2t")
                    ?: throw Exception("Failed to create file in gallery")

                outputStream.use { out ->
                    for ((index, segUrl) in segments.withIndex()) {
                        checkCancelled(episodeId)
                        downloadSegmentToStream(client, episodeId, segUrl, referer, out)
                        val progress = 20 + ((index + 1).toFloat() / segments.size * 80).toInt()
                        notifyDownload(episodeId, progress, "downloading")
                    }
                }

                val filePath = pendingMediaUri?.toString() ?: ""
                finalizeGalleryEntry()
                notifyDownload(episodeId, 100, "completed", filePath)
                call.resolve(JSObject().put("success", true).put("filePath", filePath))
            } catch (e: Exception) {
                Log.e(TAG, "downloadEpisode failed", e)
                if (cancelledDownloads.remove(episodeId)) {
                    notifyDownload(episodeId, 0, "cancelled")
                    call.reject("Download cancelled")
                } else {
                    notifyDownload(episodeId, 0, "error")
                    call.reject("Download failed: ${e.message}", e)
                }
            } finally {
                activeCalls.remove(episodeId)
            }
        }.start()
    }

    private var pendingMediaUri: android.net.Uri? = null

    private fun createGalleryOutputStream(fileName: String, extension: String, mimeType: String): OutputStream? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Video.Media.DISPLAY_NAME, "$fileName.$extension")
                put(MediaStore.Video.Media.MIME_TYPE, mimeType)
                put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/Sakura")
                put(MediaStore.Video.Media.IS_PENDING, 1)
            }
            val uri = context.contentResolver.insert(
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values
            ) ?: return null
            pendingMediaUri = uri
            context.contentResolver.openOutputStream(uri)
        } else {
            @Suppress("DEPRECATION")
            val dir = File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES),
                "Sakura"
            )
            dir.mkdirs()
            val file = File(dir, "$fileName.$extension")
            pendingMediaUri = null
            FileOutputStream(file)
        }
    }

    private fun finalizeGalleryEntry() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && pendingMediaUri != null) {
            val values = ContentValues().apply {
                put(MediaStore.Video.Media.IS_PENDING, 0)
            }
            context.contentResolver.update(pendingMediaUri!!, values, null, null)
            pendingMediaUri = null
        }
    }

    private fun notifyDownload(episodeId: String, progress: Int, state: String, filePath: String = "") {
        notifyListeners("downloadProgress", JSObject().apply {
            put("episodeId", episodeId)
            put("progress", progress)
            put("state", state)
            if (filePath.isNotEmpty()) put("filePath", filePath)
        })
    }

    private fun checkCancelled(episodeId: String) {
        if (cancelledDownloads.contains(episodeId)) {
            throw Exception("cancelled")
        }
    }

    @ActivityCallback
    fun handlePlayerResult(call: PluginCall, result: ActivityResult) {
        val data = result.data
        val completed = data?.getBooleanExtra("completed", false) ?: false
        val episodeId = data?.getStringExtra("episodeId") ?: ""

        notifyListeners("playbackEnded", JSObject().apply {
            put("episodeId", episodeId)
            put("completed", completed)
        })

        call.resolve(JSObject().apply {
            put("success", true)
            put("completed", completed)
        })
    }

    private fun httpGet(client: OkHttpClient, url: String, referer: String): String {
        val builder = Request.Builder()
            .url(url)
            .header("User-Agent", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36")
        if (referer.isNotEmpty()) {
            builder.header("Referer", referer)
            builder.header("Origin", referer.substringBeforeLast("/"))
        }
        val response = client.newCall(builder.build()).execute()
        response.use {
            if (!it.isSuccessful) throw Exception("HTTP ${it.code}")
            return it.body?.string() ?: throw Exception("Empty response")
        }
    }

    private fun downloadSegmentToStream(client: OkHttpClient, episodeId: String, url: String, referer: String, output: OutputStream) {
        val builder = Request.Builder()
            .url(url)
            .header("User-Agent", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36")
        if (referer.isNotEmpty()) {
            builder.header("Referer", referer)
            builder.header("Origin", referer.substringBeforeLast("/"))
        }
        val activeCall = client.newCall(builder.build())
        activeCalls[episodeId] = activeCall
        val response = activeCall.execute()
        response.use {
            if (!it.isSuccessful) throw Exception("HTTP ${it.code} for segment")
            it.body?.byteStream()?.use { input ->
                input.copyTo(output, bufferSize = 8192)
            } ?: throw Exception("Empty segment body")
        }
    }

    private fun downloadFileToStream(client: OkHttpClient, episodeId: String, url: String, referer: String, output: OutputStream) {
        val builder = Request.Builder()
            .url(url)
            .header("User-Agent", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36")
        if (referer.isNotEmpty()) {
            builder.header("Referer", referer)
            builder.header("Origin", referer.substringBeforeLast("/"))
        }
        val activeCall = client.newCall(builder.build())
        activeCalls[episodeId] = activeCall
        val response = activeCall.execute()
        response.use {
            if (!it.isSuccessful) throw Exception("HTTP ${it.code}")
            val total = it.body?.contentLength() ?: -1L
            it.body?.byteStream()?.use { input ->
                val buffer = ByteArray(8192)
                var downloaded = 0L
                while (true) {
                    checkCancelled(episodeId)
                    val read = input.read(buffer)
                    if (read == -1) break
                    output.write(buffer, 0, read)
                    downloaded += read
                    if (total > 0) {
                        val progress = 12 + ((downloaded.toFloat() / total) * 88).toInt()
                        notifyDownload(episodeId, progress.coerceIn(12, 99), "downloading")
                    }
                }
            } ?: throw Exception("Empty response body")
        }
    }

    private fun parseM3u8Segments(content: String, baseUrl: String, manifestUrl: String): List<String> {
        val lines = content.lines().map { it.trim() }

        val variants = mutableListOf<Pair<Int, String>>()
        for (i in lines.indices) {
            if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
                val bw = Regex("BANDWIDTH=(\\d+)").find(lines[i])?.groupValues?.get(1)?.toIntOrNull() ?: 0
                val next = lines.getOrNull(i + 1)?.trim() ?: continue
                if (next.isNotEmpty() && !next.startsWith("#")) {
                    variants.add(bw to resolveUrl(next, baseUrl, manifestUrl))
                }
            }
        }
        if (variants.isNotEmpty()) {
            val best = variants.maxByOrNull { it.first }?.second ?: return emptyList()
            return listOf(best)
        }

        val segments = mutableListOf<String>()
        for (line in lines) {
            if (line.isEmpty() || line.startsWith("#")) continue
            segments.add(resolveUrl(line, baseUrl, manifestUrl))
        }
        return segments
    }

    private fun resolveUrl(path: String, baseUrl: String, manifestUrl: String): String {
        return when {
            path.startsWith("http://") || path.startsWith("https://") -> path
            path.startsWith("/") -> {
                val url = java.net.URL(manifestUrl)
                "${url.protocol}://${url.host}$path"
            }
            else -> baseUrl + path
        }
    }

    @PluginMethod
    fun clearCache(call: PluginCall) {
        call.resolve(JSObject().put("cleared", true))
    }
}
