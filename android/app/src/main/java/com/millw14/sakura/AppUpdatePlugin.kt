package com.millw14.sakura

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

@CapacitorPlugin(name = "AppUpdate")
class AppUpdatePlugin : Plugin() {

    companion object {
        private const val TAG = "AppUpdatePlugin"
        private const val APK_NAME = "sakura-update.apk"
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.MINUTES)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    @PluginMethod
    fun getBuildInfo(call: PluginCall) {
        try {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            val result = JSObject()
            result.put("versionCode", packageInfo.longVersionCode)
            result.put("versionName", packageInfo.versionName ?: "")
            call.resolve(result)
        } catch (e: Exception) {
            call.reject("Unable to read build info", e)
        }
    }

    @PluginMethod
    fun canInstallPackages(call: PluginCall) {
        val allowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.packageManager.canRequestPackageInstalls()
        } else {
            true
        }
        call.resolve(JSObject().put("allowed", allowed))
    }

    @PluginMethod
    fun openInstallPermissionSettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
            data = Uri.parse("package:${context.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Unable to open install settings", e)
        }
    }

    @PluginMethod
    fun downloadAndInstall(call: PluginCall) {
        val url = call.getString("url")?.trim().orEmpty()
        if (url.isEmpty()) {
            call.reject("Missing url parameter")
            return
        }

        call.resolve(JSObject().put("started", true))

        Thread {
            try {
                emitProgress(0, "downloading")
                val request = Request.Builder()
                    .url(url)
                    .header("User-Agent", "Sakura-Android-Updater")
                    .header("Accept", "application/vnd.android.package-archive, application/octet-stream, */*")
                    .build()

                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        throw IllegalStateException("Download failed (${response.code})")
                    }

                    val body = response.body ?: throw IllegalStateException("Empty download body")
                    val totalBytes = body.contentLength()
                    val apkFile = File(context.cacheDir, APK_NAME)
                    if (apkFile.exists()) {
                        apkFile.delete()
                    }

                    body.byteStream().use { input ->
                        FileOutputStream(apkFile).use { output ->
                            val buffer = ByteArray(8192)
                            var downloaded = 0L
                            var lastProgress = -1
                            while (true) {
                                val read = input.read(buffer)
                                if (read == -1) break
                                output.write(buffer, 0, read)
                                downloaded += read
                                val progress = if (totalBytes > 0) {
                                    ((downloaded * 100) / totalBytes).toInt().coerceIn(0, 99)
                                } else {
                                    ((downloaded / (1024 * 1024)) % 99).toInt()
                                }
                                if (progress != lastProgress) {
                                    lastProgress = progress
                                    emitProgress(progress, "downloading")
                                }
                            }
                            output.flush()
                        }
                    }

                    if (!apkFile.exists() || apkFile.length() < 1024) {
                        throw IllegalStateException("Downloaded APK is empty or invalid")
                    }

                    emitProgress(100, "installing")
                    promptInstall(apkFile)
                    emitProgress(100, "completed")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Update download/install failed", e)
                emitProgress(0, "error", e.message ?: "Update failed")
            }
        }.start()
    }

    private fun promptInstall(apkFile: File) {
        val hostActivity = activity ?: throw IllegalStateException("App is not in the foreground")

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !context.packageManager.canRequestPackageInstalls()
        ) {
            emitProgress(
                100,
                "needs_permission",
                "Allow Sakura to install updates, then tap Download again."
            )
            hostActivity.runOnUiThread {
                val settingsIntent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                    data = Uri.parse("package:${context.packageName}")
                }
                hostActivity.startActivity(settingsIntent)
            }
            return
        }

        hostActivity.runOnUiThread {
            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                apkFile
            )

            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }

            hostActivity.startActivity(installIntent)
        }
    }

    private fun emitProgress(progress: Int, state: String, message: String? = null) {
        val payload = JSObject()
        payload.put("progress", progress)
        payload.put("state", state)
        if (!message.isNullOrBlank()) {
            payload.put("message", message)
        }
        notifyListeners("downloadProgress", payload)
    }
}
