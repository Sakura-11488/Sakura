package com.millw14.sakura.anime

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.AlphaAnimation
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.common.Tracks
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.upstream.DefaultBandwidthMeter
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

@OptIn(UnstableApi::class)
class PlayerActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "PlayerActivity"
        const val EXTRA_STREAM_URL = "stream_url"
        const val EXTRA_REFERER = "referer"
        const val EXTRA_TITLE = "title"
        const val EXTRA_SUBTITLES = "subtitles_json"
        const val EXTRA_IS_LOCAL = "is_local"
        const val EXTRA_EPISODE_ID = "episode_id"
        const val EXTRA_HAS_NEXT = "has_next"
        const val EXTRA_NEXT_TITLE = "next_title"
        private const val PREFS_NAME = "sakura_player_prefs"
        private const val UP_NEXT_THRESHOLD_MS = 60_000L
        private const val COUNTDOWN_SECONDS = 5
        private const val BUFFERING_TIMEOUT_MS = 15_000L
        private const val MAX_ERROR_RETRIES = 2
    }

    private var player: ExoPlayer? = null
    private lateinit var playerView: PlayerView
    private var hasSubtitles = false
    private var retriedWithoutSubs = false

    private var episodeId: String = ""
    private var hasNext = false
    private var nextTitle: String = ""
    private var resultSent = false
    private var positionRestored = false

    private lateinit var upNextCard: LinearLayout
    private lateinit var countdownText: TextView
    private var upNextShown = false
    private val handler = Handler(Looper.getMainLooper())
    private var countdownValue = COUNTDOWN_SECONDS

    private lateinit var titleOverlay: LinearLayout
    private var errorRetryCount = 0
    private var currentStreamUrl: String = ""
    private var currentReferer: String = ""

    private val positionChecker = object : Runnable {
        override fun run() {
            val p = player ?: return
            val duration = p.duration
            val position = p.currentPosition
            if (duration > 0 && hasNext && !upNextShown) {
                if (duration - position <= UP_NEXT_THRESHOLD_MS) {
                    showUpNextCard()
                }
            }
            if (p.isPlaying) {
                handler.postDelayed(this, 1000)
            }
        }
    }

    private val bufferingWatchdog = Runnable {
        val p = player ?: return@Runnable
        if (p.playbackState == Player.STATE_BUFFERING) {
            Log.w(TAG, "Buffering watchdog triggered — forcing re-seek")
            val pos = p.currentPosition
            p.seekTo(pos)
        }
    }

    private val countdownRunner = object : Runnable {
        override fun run() {
            countdownValue--
            if (countdownValue <= 0) {
                finishWithResult(true)
            } else {
                countdownText.text = "Starting in ${countdownValue}s\u2026"
                handler.postDelayed(this, 1000)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        hideSystemUI()

        episodeId = intent.getStringExtra(EXTRA_EPISODE_ID) ?: ""
        hasNext = intent.getBooleanExtra(EXTRA_HAS_NEXT, false)
        nextTitle = intent.getStringExtra(EXTRA_NEXT_TITLE) ?: ""
        val title = intent.getStringExtra(EXTRA_TITLE) ?: ""

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        playerView = PlayerView(this).apply {
            keepScreenOn = true
            resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
            setShowSubtitleButton(true)
            setShowNextButton(true)
            setShowPreviousButton(false)
        }
        root.addView(playerView, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))

        titleOverlay = buildTitleOverlay(title)
        titleOverlay.visibility = View.GONE
        root.addView(titleOverlay, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply {
            gravity = Gravity.TOP
        })

        playerView.setControllerVisibilityListener(
            PlayerView.ControllerVisibilityListener { visibility ->
                titleOverlay.visibility = visibility
            }
        )

        upNextCard = buildUpNextCard()
        upNextCard.visibility = View.GONE
        root.addView(upNextCard, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.END
            marginEnd = dp(24)
            bottomMargin = dp(80)
        })

        setContentView(root)

        val streamUrl = intent.getStringExtra(EXTRA_STREAM_URL)
        if (streamUrl.isNullOrEmpty()) {
            finishWithResult(false)
            return
        }

        currentStreamUrl = streamUrl
        val isLocal = intent.getBooleanExtra(EXTRA_IS_LOCAL, false)
        if (isLocal) {
            initializeLocalPlayer(streamUrl)
        } else {
            currentReferer = intent.getStringExtra(EXTRA_REFERER) ?: ""
            initializePlayer(streamUrl, currentReferer)
        }
    }

    /* ── Title Overlay ── */

    private fun buildTitleOverlay(title: String): LinearLayout {
        val overlay = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(20), dp(16), dp(20), dp(24))
            background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(Color.parseColor("#CC000000"), Color.TRANSPARENT)
            )
            gravity = Gravity.CENTER_VERTICAL
            isClickable = false
            isFocusable = false
        }

        val textColumn = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }

        textColumn.addView(TextView(this).apply {
            text = title.ifEmpty { "Now Playing" }
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setShadowLayer(4f, 0f, 2f, Color.BLACK)
        })

        val epLabel = intent.getStringExtra(EXTRA_EPISODE_ID)?.let { epId ->
            val num = epId.substringAfterLast("-episode-", "").substringBefore("-")
            if (num.isNotEmpty()) "Episode $num" else null
        }
        if (epLabel != null) {
            textColumn.addView(TextView(this).apply {
                text = epLabel
                setTextColor(Color.parseColor("#FFB7C5"))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                alpha = 0.9f
                setShadowLayer(4f, 0f, 2f, Color.BLACK)
            })
        }

        overlay.addView(textColumn)

        val qualityBtn = TextView(this).apply {
            text = "\u2699"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            setPadding(dp(12), dp(4), dp(4), dp(4))
            isClickable = true
            isFocusable = true
            setShadowLayer(4f, 0f, 2f, Color.BLACK)
            setOnClickListener { showQualitySelector() }
        }
        overlay.addView(qualityBtn)

        return overlay
    }

    /* ── UI Cards ── */

    private fun buildUpNextCard(): LinearLayout {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(16), dp(20), dp(16))
            background = GradientDrawable().apply {
                cornerRadius = dp(16).toFloat()
                colors = intArrayOf(
                    Color.parseColor("#E91E7B"),
                    Color.parseColor("#C2185B")
                )
                orientation = GradientDrawable.Orientation.LEFT_RIGHT
            }
            elevation = dp(8).toFloat()
            isClickable = true
            isFocusable = true
        }

        card.addView(TextView(this).apply {
            text = "\uD83C\uDF38 Up Next"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            alpha = 0.9f
        })

        card.addView(TextView(this).apply {
            text = nextTitle.ifEmpty { "Next Episode" }
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
            maxWidth = dp(220)
            ellipsize = TextUtils.TruncateAt.END
        })

        countdownText = TextView(this).apply {
            setTextColor(Color.parseColor("#FFE0F0"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            visibility = View.GONE
        }
        card.addView(countdownText)

        card.setOnClickListener {
            handler.removeCallbacks(countdownRunner)
            finishWithResult(true)
        }

        return card
    }

    private fun showUpNextCard() {
        if (upNextShown) return
        upNextShown = true
        upNextCard.visibility = View.VISIBLE
        upNextCard.startAnimation(AlphaAnimation(0f, 1f).apply { duration = 500 })
    }

    private fun startCountdown() {
        countdownValue = COUNTDOWN_SECONDS
        countdownText.text = "Starting in ${countdownValue}s\u2026"
        countdownText.visibility = View.VISIBLE
        handler.postDelayed(countdownRunner, 1000)
    }

    private fun finishWithResult(completed: Boolean) {
        if (resultSent) return
        resultSent = true
        handler.removeCallbacks(positionChecker)
        handler.removeCallbacks(countdownRunner)
        handler.removeCallbacks(bufferingWatchdog)

        if (completed && episodeId.isNotEmpty()) {
            clearSavedPosition()
        }

        setResult(Activity.RESULT_OK, Intent().apply {
            putExtra("completed", completed)
            putExtra("episodeId", episodeId)
        })
        finish()
    }

    /* ── Quality Selector ── */

    private fun wrapWithSkipNext(exo: ExoPlayer): ForwardingPlayer {
        return object : ForwardingPlayer(exo) {
            override fun seekToNext() {
                if (hasNext) finishWithResult(true) else exo.seekToNext()
            }
            override fun seekToNextMediaItem() {
                if (hasNext) finishWithResult(true) else exo.seekToNextMediaItem()
            }
            override fun hasNextMediaItem(): Boolean {
                return hasNext || exo.hasNextMediaItem()
            }
            override fun seekBack() {
                exo.seekBack()
            }
            override fun seekForward() {
                exo.seekForward()
            }
            override fun getAvailableCommands(): Player.Commands {
                val base = super.getAvailableCommands().buildUpon()
                    .add(Player.COMMAND_SEEK_BACK)
                    .add(Player.COMMAND_SEEK_FORWARD)
                if (hasNext) {
                    base.add(Player.COMMAND_SEEK_TO_NEXT)
                        .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                }
                return base.build()
            }
            override fun isCommandAvailable(command: Int): Boolean {
                if (command == Player.COMMAND_SEEK_BACK || command == Player.COMMAND_SEEK_FORWARD) return true
                if (hasNext && (command == Player.COMMAND_SEEK_TO_NEXT || command == Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)) {
                    return true
                }
                return super.isCommandAvailable(command)
            }
        }
    }

    private fun showQualitySelector() {
        val p = player ?: return
        val trackGroups = p.currentTracks.groups
        val videoHeights = mutableListOf<Pair<String, Int>>()
        videoHeights.add(Pair("Auto", 0))

        for (group in trackGroups) {
            if (group.type == C.TRACK_TYPE_VIDEO) {
                for (i in 0 until group.length) {
                    val format = group.getTrackFormat(i)
                    val h = format.height
                    if (h > 0 && videoHeights.none { it.second == h }) {
                        videoHeights.add(Pair("${h}p", h))
                    }
                }
            }
        }

        videoHeights.sortWith(compareByDescending<Pair<String, Int>> { it.second }.thenBy { it.first })

        val currentMaxH = p.trackSelectionParameters.maxVideoHeight
        val labels = videoHeights.map { it.first }.toTypedArray()
        var selectedIdx = videoHeights.indexOfFirst {
            if (it.second == 0) currentMaxH == Int.MAX_VALUE
            else it.second == currentMaxH
        }.coerceAtLeast(0)

        AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Video Quality")
            .setSingleChoiceItems(labels, selectedIdx) { dialog, which ->
                selectedIdx = which
                val chosen = videoHeights[which]
                val newParams = p.trackSelectionParameters.buildUpon()
                if (chosen.second == 0) {
                    newParams.setMaxVideoSize(Int.MAX_VALUE, Int.MAX_VALUE)
                } else {
                    newParams.setMaxVideoSize(Int.MAX_VALUE, chosen.second)
                }
                p.trackSelectionParameters = newParams.build()
                dialog.dismiss()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /* ── Position persistence ── */

    private fun getPrefs(): SharedPreferences =
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)

    private fun savePosition() {
        val pos = player?.currentPosition ?: return
        if (episodeId.isEmpty() || pos <= 0) return
        getPrefs().edit().putLong("anime_pos_$episodeId", pos).apply()
    }

    private fun restorePosition() {
        if (positionRestored || episodeId.isEmpty()) return
        positionRestored = true
        val pos = getPrefs().getLong("anime_pos_$episodeId", 0L)
        if (pos > 0) {
            player?.seekTo(pos)
            Log.d(TAG, "Restored position to ${pos}ms for $episodeId")
        }
    }

    private fun clearSavedPosition() {
        if (episodeId.isEmpty()) return
        getPrefs().edit().remove("anime_pos_$episodeId").apply()
    }

    /* ── Player initialization ── */

    private fun initializePlayer(url: String, referer: String) {
        val okHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build()

        val requestProps = mutableMapOf("Accept" to "*/*")
        if (referer.isNotEmpty()) {
            requestProps["Referer"] = referer
            try {
                val u = java.net.URL(referer)
                requestProps["Origin"] = "${u.protocol}://${u.host}"
            } catch (_: Exception) {}
        }

        val dataSourceFactory = OkHttpDataSource.Factory(okHttpClient)
            .setUserAgent(
                "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
            )
            .setDefaultRequestProperties(requestProps)

        val subtitleConfigs = if (!retriedWithoutSubs) buildSubtitleConfigs() else emptyList()
        hasSubtitles = subtitleConfigs.isNotEmpty()

        val mimeType = when {
            url.contains(".m3u8") -> MimeTypes.APPLICATION_M3U8
            url.contains(".mp4") -> MimeTypes.VIDEO_MP4
            url.contains(".webm") -> MimeTypes.VIDEO_WEBM
            else -> null
        }

        val mediaItem = MediaItem.Builder()
            .setUri(url)
            .apply {
                if (mimeType != null) setMimeType(mimeType)
                if (subtitleConfigs.isNotEmpty()) {
                    setSubtitleConfigurations(subtitleConfigs)
                }
            }
            .build()

        val mediaSource = DefaultMediaSourceFactory(dataSourceFactory)
            .createMediaSource(mediaItem)

        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(30_000, 120_000, 5_000, 8_000)
            .setPrioritizeTimeOverSizeThresholds(true)
            .build()

        val bandwidthMeter = DefaultBandwidthMeter.Builder(this)
            .setInitialBitrateEstimate(5_000_000L)
            .build()

        player = ExoPlayer.Builder(this)
            .setLoadControl(loadControl)
            .setBandwidthMeter(bandwidthMeter)
            .setSeekBackIncrementMs(5_000)
            .setSeekForwardIncrementMs(10_000)
            .build().also { exo ->
            playerView.player = wrapWithSkipNext(exo)

            val audioAttributes = AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .build()
            exo.setAudioAttributes(audioAttributes, true)

            exo.trackSelectionParameters = TrackSelectionParameters.Builder(this)
                .setMaxVideoSize(Int.MAX_VALUE, Int.MAX_VALUE)
                .setMinVideoSize(854, 480)
                .setPreferredAudioLanguage("ja")
                .setPreferredTextLanguage("en")
                .build()
            exo.setMediaSource(mediaSource)
            exo.playWhenReady = true
            exo.prepare()

            exo.addListener(object : Player.Listener {
                override fun onPlayerError(error: PlaybackException) {
                    Log.e(TAG, "Playback error (retries=$errorRetryCount)", error)
                    handler.removeCallbacks(bufferingWatchdog)

                    if (hasSubtitles && !retriedWithoutSubs) {
                        Log.d(TAG, "Retrying without subtitles")
                        retriedWithoutSubs = true
                        val savedPos = player?.currentPosition ?: 0L
                        player?.release()
                        player = null
                        initializePlayer(url, referer)
                        if (savedPos > 0) {
                            positionRestored = false
                        }
                        return
                    }

                    if (errorRetryCount < MAX_ERROR_RETRIES) {
                        errorRetryCount++
                        Log.d(TAG, "Error recovery: retry #$errorRetryCount from current position")
                        val savedPos = player?.currentPosition ?: 0L
                        player?.release()
                        player = null
                        positionRestored = true
                        initializePlayer(url, referer)
                        handler.postDelayed({
                            if (savedPos > 0) player?.seekTo(savedPos)
                        }, 500)
                        return
                    }
                }

                override fun onPlaybackStateChanged(playbackState: Int) {
                    when (playbackState) {
                        Player.STATE_BUFFERING -> {
                            handler.removeCallbacks(bufferingWatchdog)
                            handler.postDelayed(bufferingWatchdog, BUFFERING_TIMEOUT_MS)
                        }
                        Player.STATE_READY -> {
                            handler.removeCallbacks(bufferingWatchdog)
                            errorRetryCount = 0
                            restorePosition()
                            handler.post(positionChecker)
                        }
                        Player.STATE_ENDED -> {
                            handler.removeCallbacks(bufferingWatchdog)
                            onPlaybackEnded()
                        }
                    }
                }

                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    if (isPlaying) handler.post(positionChecker)
                }
            })
        }
    }

    private fun initializeLocalPlayer(uri: String) {
        val mediaItem = MediaItem.fromUri(android.net.Uri.parse(uri))

        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(15_000, 60_000, 1_000, 2_000)
            .build()

        player = ExoPlayer.Builder(this)
            .setLoadControl(loadControl)
            .setSeekBackIncrementMs(5_000)
            .setSeekForwardIncrementMs(10_000)
            .build().also { exo ->
            playerView.player = wrapWithSkipNext(exo)

            val audioAttributes = AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .build()
            exo.setAudioAttributes(audioAttributes, true)

            exo.setMediaItem(mediaItem)
            exo.playWhenReady = true
            exo.prepare()

            exo.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(playbackState: Int) {
                    when (playbackState) {
                        Player.STATE_BUFFERING -> {
                            handler.removeCallbacks(bufferingWatchdog)
                            handler.postDelayed(bufferingWatchdog, BUFFERING_TIMEOUT_MS)
                        }
                        Player.STATE_READY -> {
                            handler.removeCallbacks(bufferingWatchdog)
                            restorePosition()
                            handler.post(positionChecker)
                        }
                        Player.STATE_ENDED -> {
                            handler.removeCallbacks(bufferingWatchdog)
                            onPlaybackEnded()
                        }
                    }
                }

                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    if (isPlaying) handler.post(positionChecker)
                }
            })
        }
    }

    private fun onPlaybackEnded() {
        clearSavedPosition()
        if (hasNext) {
            showUpNextCard()
            startCountdown()
        } else {
            finishWithResult(true)
        }
    }

    private fun buildSubtitleConfigs(): List<MediaItem.SubtitleConfiguration> {
        val json = intent.getStringExtra(EXTRA_SUBTITLES) ?: return emptyList()
        if (json.isEmpty() || json == "[]") return emptyList()

        val configs = mutableListOf<MediaItem.SubtitleConfiguration>()
        try {
            val arr = org.json.JSONArray(json)
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val subUrl = obj.getString("url")
                val label = obj.optString("label", "Subtitle")

                val subMime = when {
                    subUrl.lowercase().endsWith(".srt") -> MimeTypes.APPLICATION_SUBRIP
                    subUrl.lowercase().endsWith(".ass") || subUrl.lowercase().endsWith(".ssa") -> MimeTypes.TEXT_SSA
                    else -> MimeTypes.TEXT_VTT
                }

                configs.add(
                    MediaItem.SubtitleConfiguration.Builder(Uri.parse(subUrl))
                        .setMimeType(subMime)
                        .setLabel(label)
                        .setLanguage("en")
                        .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                        .build()
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse subtitle configs", e)
        }
        return configs
    }

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics
        ).toInt()

    private fun hideSystemUI() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_FULLSCREEN
        )
    }

    @Deprecated("Use onBackPressedDispatcher", ReplaceWith("onBackPressedDispatcher"))
    override fun onBackPressed() {
        finishWithResult(false)
    }

    override fun onResume() {
        super.onResume()
        hideSystemUI()
        player?.playWhenReady = true
    }

    override fun onPause() {
        super.onPause()
        player?.playWhenReady = false
        savePosition()
    }

    override fun onStop() {
        super.onStop()
        player?.playWhenReady = false
        savePosition()
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacksAndMessages(null)
        player?.release()
        player = null
    }
}
