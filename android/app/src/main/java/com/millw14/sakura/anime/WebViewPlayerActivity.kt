package com.millw14.sakura.anime

import android.app.Activity
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import androidx.appcompat.app.AppCompatActivity

class WebViewPlayerActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "WebViewPlayer"
        const val EXTRA_EMBED_URL = "embed_url"
        const val EXTRA_REFERER = "referer"
        const val EXTRA_TITLE = "title"
        const val EXTRA_EPISODE_ID = "episode_id"
        const val EXTRA_HAS_NEXT = "has_next"
        const val EXTRA_NEXT_TITLE = "next_title"
    }

    private lateinit var webView: WebView
    private lateinit var rootLayout: FrameLayout
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var resultSent = false
    private var episodeId = ""
    private var hasNext = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        hideSystemUI()

        episodeId = intent.getStringExtra(EXTRA_EPISODE_ID) ?: ""
        hasNext = intent.getBooleanExtra(EXTRA_HAS_NEXT, false)

        val embedUrl = intent.getStringExtra(EXTRA_EMBED_URL)
        if (embedUrl.isNullOrEmpty()) {
            Log.e(TAG, "No embed URL provided")
            finishWithResult(false)
            return
        }

        rootLayout = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        val progress = ProgressBar(this, null, android.R.attr.progressBarStyleLarge).apply {
            isIndeterminate = true
        }

        webView = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowContentAccess = true
                loadWithOverviewMode = true
                useWideViewPort = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                userAgentString = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
                setSupportMultipleWindows(false)
                cacheMode = WebSettings.LOAD_DEFAULT
                javaScriptCanOpenWindowsAutomatically = false
                setSupportZoom(false)
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false
                if (url.startsWith("intent://") || url.startsWith("market://")) {
                    return true
                }
                return false
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                Log.d(TAG, "Page loading: $url")
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                Log.d(TAG, "Page loaded: $url")
                progress.visibility = View.GONE
                view?.evaluateJavascript("""
                    (function() {
                        var s = document.createElement('style');
                        s.textContent = '' +
                            'body{background:#000!important}' +
                            '#header,.navbar,.footer,.film-stats,.detail-seasons,.prebid-ad,.ad-container,.ads,.ad,[class*="ad-"],[id*="ad-"],.popup,.popunder,.film-infor,.seasons-block,.block_area-episodes,.btn-expand,.player-notice{display:none!important}' +
                            '#watch-main,.watch-page{padding:0!important;margin:0!important}' +
                            '.player-area,.watching_player{width:100vw!important;height:100vh!important;max-height:100vh!important;position:fixed!important;top:0!important;left:0!important;z-index:99999!important}' +
                            '#iframe-embed,#player,iframe[src]{width:100%!important;height:100%!important;position:absolute!important;top:0!important;left:0!important}' +
                            'video{width:100vw!important;height:100vh!important;object-fit:contain!important}';
                        document.head.appendChild(s);
                        setTimeout(function(){
                            var iframe = document.querySelector('#iframe-embed, iframe[src*="megaplay"], iframe[src*="megacloud"], iframe[allow]');
                            if(iframe){
                                iframe.style.cssText='width:100vw!important;height:100vh!important;position:fixed!important;top:0!important;left:0!important;z-index:99999!important;border:none!important';
                            }
                            var v = document.querySelector('video');
                            if(v){ v.play().catch(function(){}); }
                        }, 1500);
                    })();
                """.trimIndent(), null)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                if (customView != null) {
                    callback?.onCustomViewHidden()
                    return
                }
                customView = view
                customViewCallback = callback
                rootLayout.addView(view, FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                ))
                webView.visibility = View.GONE
                hideSystemUI()
            }

            override fun onHideCustomView() {
                if (customView == null) return
                rootLayout.removeView(customView)
                customView = null
                customViewCallback?.onCustomViewHidden()
                customViewCallback = null
                webView.visibility = View.VISIBLE
                hideSystemUI()
            }

            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                Log.d(TAG, "JS: ${consoleMessage?.message()}")
                return true
            }
        }

        rootLayout.addView(webView, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))

        rootLayout.addView(progress, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.CENTER })

        setContentView(rootLayout)

        val referer = intent.getStringExtra(EXTRA_REFERER) ?: "https://hianime.dk/"
        val headers = mutableMapOf<String, String>()
        if (referer.isNotEmpty()) {
            headers["Referer"] = referer
            try {
                val u = java.net.URL(referer)
                headers["Origin"] = "${u.protocol}://${u.host}"
            } catch (_: Exception) {}
        }
        Log.d(TAG, "Loading embed URL: $embedUrl")
        webView.loadUrl(embedUrl, headers)
    }

    private fun finishWithResult(completed: Boolean) {
        if (resultSent) return
        resultSent = true
        setResult(Activity.RESULT_OK, Intent().apply {
            putExtra("completed", completed)
            putExtra("episodeId", episodeId)
        })
        finish()
    }

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
        if (customView != null) {
            webView.webChromeClient?.onHideCustomView()
            return
        }
        finishWithResult(false)
    }

    override fun onResume() {
        super.onResume()
        hideSystemUI()
        webView.onResume()
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
    }

    override fun onDestroy() {
        super.onDestroy()
        webView.destroy()
    }
}
