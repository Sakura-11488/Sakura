package com.millw14.sakura;

import android.os.Bundle;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.millw14.sakura.anime.AnimePlugin;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "SakuraMain";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AnimePlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        super.onCreate(savedInstanceState);

        // The Sakura app loads its bundled assets at https://sakura.milla.so
        // (a Capacitor-internal virtual scheme) but talks to the comics scraper
        // proxy and PsyopAnime CDN over plain HTTP at 165.232.83.159. The
        // capacitor.config flag `allowMixedContent: true` is not always honored
        // for image subresources by recent WebView builds, so explicitly force
        // the most permissive mixed-content mode here.
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            WebSettings settings = webView.getSettings();
            int before = settings.getMixedContentMode();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            int after = settings.getMixedContentMode();
            Log.i(TAG, "WebView mixed-content mode changed " + before + " -> " + after);
            WebView.setWebContentsDebuggingEnabled(true);
        } else {
            Log.w(TAG, "Bridge WebView was null in onCreate; mixed-content override skipped");
        }
    }
}
