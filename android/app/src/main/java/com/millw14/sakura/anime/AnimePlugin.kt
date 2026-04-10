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
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.concurrent.TimeUnit

@CapacitorPlugin(name = "Anime")
class AnimePlugin : Plugin() {

    companion object {
        private const val TAG = "AnimePlugin"
    }

    @PluginMethod
    fun playEpisode(call: PluginCall) {
        val streamUrl = call.getString("streamUrl") ?: ""
        val referer = call.getString("referer") ?: ""
        val title = call.getString("title") ?: "Episode"
        val episodeId = call.getString("episodeId") ?: ""
        val hasNext = call.getBoolean("hasNext", false) ?: false
        val nextEpisodeTitle = call.getString("nextEpisodeTitle") ?: ""

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
            }
            startActivityForResult(call, intent, "handlePlayerResult")
        }
    }

    @PluginMethod
    fun downloadEpisode(call: PluginCall) {
        val episodeId = call.getString("episodeId")
        if (episodeId.isNullOrEmpty()) {
            call.reject("Missing episodeId")
            return
        }
        val m3u8Url = call.getString("m3u8Url") ?: ""
        val title = call.getString("title") ?: "Episode"
        val animeTitle = call.getString("animeTitle") ?: "Anime"

        if (m3u8Url.isNotEmpty()) {
            startDownload(call, episodeId, m3u8Url, "", title, animeTitle)
        } else {
            call.reject("Download requires a direct stream URL. Play the episode first.")
        }
    }

    private fun startDownload(
        call: PluginCall,
        episodeId: String,
        m3u8Url: String,
        referer: String,
        title: String,
        animeTitle: String
    ) {
        Thread {
            try {
                notifyDownload(episodeId, 0, "extracting")

                val client = OkHttpClient.Builder()
                    .connectTimeout(15, TimeUnit.SECONDS)
                    .readTimeout(30, TimeUnit.SECONDS)
                    .build()

                notifyDownload(episodeId, 3, "downloading")

                val m3u8Content = httpGet(client, m3u8Url, referer)
                val baseUrl = m3u8Url.substringBeforeLast("/") + "/"
                var segments = parseM3u8Segments(m3u8Content, baseUrl, m3u8Url)

                if (segments.isEmpty()) throw Exception("No segments in manifest")

                if (segments.size == 1 && segments[0].endsWith(".m3u8")) {
                    val variantContent = httpGet(client, segments[0], "")
                    val variantBase = segments[0].substringBeforeLast("/") + "/"
                    segments = parseM3u8Segments(variantContent, variantBase, segments[0])
                    if (segments.isEmpty()) throw Exception("No segments in variant playlist")
                }

                notifyDownload(episodeId, 5, "downloading")

                val safeName = "$animeTitle - $title"
                    .replace(Regex("[^a-zA-Z0-9 \\-]"), "")
                    .trim()
                    .take(200)

                val outputStream = createGalleryOutputStream(safeName)
                    ?: throw Exception("Failed to create file in gallery")

                outputStream.use { out ->
                    for ((index, segUrl) in segments.withIndex()) {
                        downloadSegmentToStream(client, segUrl, referer, out)
                        val progress = 5 + ((index + 1).toFloat() / segments.size * 95).toInt()
                        notifyDownload(episodeId, progress, "downloading")
                    }
                }

                finalizeGalleryEntry()

                val filePath = pendingMediaUri?.toString() ?: ""
                notifyDownload(episodeId, 100, "completed", filePath)
                call.resolve(JSObject().put("success", true).put("filePath", filePath))
            } catch (e: Exception) {
                Log.e(TAG, "downloadEpisode failed", e)
                notifyDownload(episodeId ?: "", 0, "error")
                call.reject("Download failed: ${e.message}", e)
            }
        }.start()
    }

    private var pendingMediaUri: android.net.Uri? = null

    private fun createGalleryOutputStream(fileName: String): OutputStream? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Video.Media.DISPLAY_NAME, "$fileName.ts")
                put(MediaStore.Video.Media.MIME_TYPE, "video/mp2t")
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
            val file = File(dir, "$fileName.ts")
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
        if (!response.isSuccessful) throw Exception("HTTP ${response.code}")
        return response.body?.string() ?: throw Exception("Empty response")
    }

    private fun downloadSegmentToStream(client: OkHttpClient, url: String, referer: String, output: OutputStream) {
        val builder = Request.Builder()
            .url(url)
            .header("User-Agent", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36")
        if (referer.isNotEmpty()) {
            builder.header("Referer", referer)
            builder.header("Origin", referer.substringBeforeLast("/"))
        }
        val response = client.newCall(builder.build()).execute()
        if (!response.isSuccessful) throw Exception("HTTP ${response.code} for segment")
        response.body?.byteStream()?.use { input ->
            input.copyTo(output, bufferSize = 8192)
        } ?: throw Exception("Empty segment body")
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
