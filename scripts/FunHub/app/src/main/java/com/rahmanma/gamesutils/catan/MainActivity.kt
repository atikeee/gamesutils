package com.rahmanma.gamesutils.catan

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.SharedPreferences
import android.os.Bundle
import android.view.KeyEvent
import android.view.ViewGroup
import android.webkit.*
import android.widget.Toast
import android.view.WindowManager

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var prefs: SharedPreferences

    companion object {
        private const val PREFS_NAME = "CATAN_TV_CONFIG"
        private const val KEY_SELECTED_GAME = "selected_game_url"

        private const val URL_CATAN_1 = "https://atiq.us/catan/1/game"
        private const val URL_CATAN_2 = "https://atiq.us/catan/2/game"
        private const val URL_mm_mp3 = "https://atiq.us/mm/mp3/tv"
        private const val URL_mm_tv4 = "https://atiq.us/mm/tv"

        // FIX 1: Added 3rd option to match GAME_URLS array size
        val GAME_OPTIONS = arrayOf("1) Catan", "2) Catan 2", "3) MM MP3", "4) MM TV")
        val GAME_URLS = arrayOf(URL_CATAN_1, URL_CATAN_2, URL_mm_mp3, URL_mm_tv4)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        // Create Fullscreen WebView programmatically
        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            isFocusable = true
            isFocusableInTouchMode = true
        }
        setContentView(webView)

        setupWebView()

        val savedUrl = prefs.getString(KEY_SELECTED_GAME, null)
        if (savedUrl == null) {
            showGameSelectionDialog()
        } else {
            loadGameUrl(savedUrl)
        }
    }

    private fun setupWebView() {
        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.allowFileAccess = true
        s.mediaPlaybackRequiresUserGesture = false
        s.useWideViewPort = true
        s.loadWithOverviewMode = true
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        s.userAgentString = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 FunHub_Client"

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                val autoScrollJs = """
                    (function() {
                        const observer = new MutationObserver(function(mutations) {
                            const logs = document.querySelectorAll('.activity-log, .game-log, .chat-box, #activity-feed, #game-events');
                            logs.forEach(function(el) {
                                el.scrollTop = el.scrollHeight;
                            });
                        });
                        observer.observe(document.body, { childList: true, subtree: true });
                    })();
                """.trimIndent()
                view?.evaluateJavascript(autoScrollJs, null)
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (request?.isForMainFrame == true) {
                    Toast.makeText(this@MainActivity, "Connection Error: ${error?.description}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun loadGameUrl(url: String) {
        Toast.makeText(this, "@Developer Atiq ...", Toast.LENGTH_SHORT).show()
        webView.loadUrl(url)
    }

    private fun showGameSelectionDialog() {
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("FunHub")
            .setItems(GAME_OPTIONS) { _, which -> switchGame(which) } 
            .setCancelable(false)
            .show()
    }

    private fun switchGame(index: Int) {
        val url = GAME_URLS[index]
        prefs.edit().putString(KEY_SELECTED_GAME, url).apply()
        loadGameUrl(url)
    }

    // Catches number keys before WebView consumes them (works with keyboards / number-pad remotes)
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val index = when (event.keyCode) {
            KeyEvent.KEYCODE_1, KeyEvent.KEYCODE_NUMPAD_1 -> 0
            KeyEvent.KEYCODE_2, KeyEvent.KEYCODE_NUMPAD_2 -> 1
            KeyEvent.KEYCODE_3, KeyEvent.KEYCODE_NUMPAD_3 -> 2
            KeyEvent.KEYCODE_4, KeyEvent.KEYCODE_NUMPAD_4 -> 3 
            else -> -1
        }
        if (index >= 0) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                switchGame(index)
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SETTINGS || keyCode == KeyEvent.KEYCODE_INFO) {
            showGameSelectionDialog()
            return true
        }
        
        // FIX 2: Call startTracking() so onKeyLongPress can actually fire for Back / Center buttons
        if ((keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_DPAD_CENTER) && event != null) {
            if (event.repeatCount == 0) {
                event.startTracking()
                return true
            }
        }
        
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyLongPress(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_DPAD_CENTER) {
            showGameSelectionDialog()
            return true
        }
        return super.onKeyLongPress(keyCode, event)
    }
}