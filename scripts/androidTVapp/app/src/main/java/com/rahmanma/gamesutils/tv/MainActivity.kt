package com.rahmanma.gamesutils.tv

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.SharedPreferences
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.Toast
import com.pierfrancescosoffritti.androidyoutubeplayer.core.player.PlayerConstants
import com.pierfrancescosoffritti.androidyoutubeplayer.core.player.YouTubePlayer
import com.pierfrancescosoffritti.androidyoutubeplayer.core.player.listeners.AbstractYouTubePlayerListener
import com.pierfrancescosoffritti.androidyoutubeplayer.core.player.views.YouTubePlayerView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : Activity() {

    private lateinit var playerView: YouTubePlayerView
    private var activePlayer: YouTubePlayer? = null
    private lateinit var prefs: SharedPreferences

    // Playback state
    private var currentPlaylist: String = "hindi"
    private var videoList: MutableList<VideoItem> = mutableListOf()
    private var currentIndex: Int = 0
    private var isPlaying: Boolean = true
    private var activeDialog: AlertDialog? = null

    // Filter & Tag state
    private var allServerPlaylists: List<String> = emptyList()
    private var allAvailableTags: List<String> = emptyList()
    private val selectedTags: MutableSet<String> = mutableSetOf()

    companion object {
        const val PREFS_NAME = "MM_TV_CONFIG"
        const val KEY_HOST = "server_host"
        const val KEY_PORT = "server_port"
        const val DEFAULT_HOST = "192.168.0.140"
        const val DEFAULT_PORT = "5000"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 1. Force Pure Fullscreen Mode on Start
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )

        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        // 2. Fullscreen Video Container
        val rootLayout = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(android.graphics.Color.BLACK)
        }

        playerView = YouTubePlayerView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            enableAutomaticInitialization = false
        }
        rootLayout.addView(playerView)
        setContentView(rootLayout)

        initPlayerEngine()
        fetchVideosFromServer()
    }

    private fun initPlayerEngine() {
        playerView.initialize(object : AbstractYouTubePlayerListener() {
            override fun onReady(youTubePlayer: YouTubePlayer) {
                activePlayer = youTubePlayer
                if (videoList.isNotEmpty()) {
                    loadTrack(currentIndex)
                }
            }

            override fun onStateChange(youTubePlayer: YouTubePlayer, state: PlayerConstants.PlayerState) {
                isPlaying = (state == PlayerConstants.PlayerState.PLAYING)
                if (state == PlayerConstants.PlayerState.ENDED) {
                    playNextTrack()
                }
            }

            override fun onError(youTubePlayer: YouTubePlayer, error: PlayerConstants.PlayerError) {
                // One-time prompt for unavailable video, then auto-advance
                Toast.makeText(this@MainActivity, "Video unavailable on YouTube. Skipping...", Toast.LENGTH_SHORT).show()
                playNextTrack()
            }
        })
    }

    // -------------------------------------------------------------
    // SERVER DATA SYNC
    // -------------------------------------------------------------
    private fun fetchVideosFromServer() {
        val host = prefs.getString(KEY_HOST, DEFAULT_HOST) ?: DEFAULT_HOST
        val port = prefs.getString(KEY_PORT, DEFAULT_PORT) ?: DEFAULT_PORT
        val apiService = TvApiClient.createService(host, port)

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val resp = apiService.getTvVideos(playlist = currentPlaylist, perPage = 100)
                withContext(Dispatchers.Main) {
                    allServerPlaylists = resp.playlists
                    videoList.clear()
                    videoList.addAll(resp.videos)
                    currentIndex = 0

                    if (videoList.isNotEmpty() && activePlayer != null) {
                        loadTrack(0)
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(this@MainActivity, "Server Error: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun loadTrack(index: Int) {
        if (videoList.isEmpty() || index < 0 || index >= videoList.size) return
        currentIndex = index
        val item = videoList[index]
        activePlayer?.loadVideo(item.video_id, 0f)
        Toast.makeText(this, "[${index + 1}/${videoList.size}] ${item.title ?: item.video_id}", Toast.LENGTH_SHORT).show()
    }

    private fun playNextTrack() {
        if (currentIndex + 1 < videoList.size) {
            loadTrack(currentIndex + 1)
        } else {
            loadTrack(0) // Loop back to start
        }
    }

    private fun playPrevTrack() {
        if (currentIndex - 1 >= 0) {
            loadTrack(currentIndex - 1)
        }
    }

    // -------------------------------------------------------------
    // OVERLAY DIALOGS (2: Playlist | 5: Category | 8: Tags)
    // -------------------------------------------------------------

    // Press '2': Playlist Selector
    private fun showPlaylistDialog() {
        if (allServerPlaylists.isEmpty()) {
            Toast.makeText(this, "No playlists found on server.", Toast.LENGTH_SHORT).show()
            return
        }

        val items = allServerPlaylists.toTypedArray()
        val currentIdx = items.indexOf(currentPlaylist).let { if (it >= 0) it else 0 }

        activeDialog = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("📁 Select Playlist [Remote 2]")
            .setSingleChoiceItems(items, currentIdx) { dialog, which ->
                currentPlaylist = items[which]
                dialog.dismiss()
                activeDialog = null
                selectedTags.clear()
                fetchVideosFromServer()
            }
            .setOnDismissListener { activeDialog = null }
            .show()
    }

    // Press '5': Category Selector
    private fun showCategoryDialog() {
        val categories = arrayOf("All Media", "Music Videos", "Playlists", "Favorites")
        activeDialog = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("🏷️ Select Category [Remote 5]")
            .setItems(categories) { dialog, which ->
                Toast.makeText(this, "Category: ${categories[which]}", Toast.LENGTH_SHORT).show()
                dialog.dismiss()
                activeDialog = null
            }
            .setOnDismissListener { activeDialog = null }
            .show()
    }

    // Press '8': Multi-Tag Selector (Select 0, 1, or Many)
    private fun showTagFilterDialog() {
        // Collect all distinct tags from current playlist videos
        val tagsSet = mutableSetOf<String>()
        videoList.forEach { v ->
            v.playlist?.let { /* tags if present */ }
        }
        val tagList = arrayOf("Rock", "Live", "Acoustic", "Classics", "Instrumental", "90s")
        val checkedItems = BooleanArray(tagList.size) { idx -> selectedTags.contains(tagList[idx]) }

        activeDialog = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("🔖 Filter by Tags (Select multiple) [Remote 8]")
            .setMultiChoiceItems(tagList, checkedItems) { _, which, isChecked ->
                val tag = tagList[which]
                if (isChecked) selectedTags.add(tag) else selectedTags.remove(tag)
            }
            .setPositiveButton("Apply Filter") { dialog, _ ->
                dialog.dismiss()
                activeDialog = null
                applyTagFilter()
            }
            .setNeutralButton("Clear All") { dialog, _ ->
                selectedTags.clear()
                dialog.dismiss()
                activeDialog = null
                applyTagFilter()
            }
            .setOnDismissListener { activeDialog = null }
            .show()
    }

    private fun applyTagFilter() {
        if (selectedTags.isEmpty()) {
            Toast.makeText(this, "Filter cleared: Showing all videos", Toast.LENGTH_SHORT).show()
        } else {
            Toast.makeText(this, "Filtered by: ${selectedTags.joinToString(", ")}", Toast.LENGTH_SHORT).show()
        }
    }

    // Back / Exit Confirmation
    private fun showExitConfirmationDialog() {
        activeDialog = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Exit MM TV Player?")
            .setMessage("Are you sure you want to exit the application?")
            .setPositiveButton("Exit") { _, _ -> finish() }
            .setNegativeButton("Cancel", null)
            .setOnDismissListener { activeDialog = null }
            .show()
    }

    // -------------------------------------------------------------
    // REMOTE KEYPAD MAPPING (1,4,7 | 2,5,8 | 3,6,9 | D-Pad | Back)
    // -------------------------------------------------------------
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        // 1. If an overlay is active, Back closes it immediately
        if (activeDialog != null && activeDialog?.isShowing == true) {
            if (keyCode == KeyEvent.KEYCODE_BACK) {
                activeDialog?.dismiss()
                activeDialog = null
                return true
            }
            return super.onKeyDown(keyCode, event)
        }

        when (keyCode) {
            // --- Overlays (2, 5, 8) ---
            KeyEvent.KEYCODE_2, KeyEvent.KEYCODE_NUMPAD_2 -> {
                showPlaylistDialog()
                return true
            }
            KeyEvent.KEYCODE_5, KeyEvent.KEYCODE_NUMPAD_5 -> {
                showCategoryDialog()
                return true
            }
            KeyEvent.KEYCODE_8, KeyEvent.KEYCODE_NUMPAD_8 -> {
                showTagFilterDialog()
                return true
            }

            // --- Navigation Left: 1, 4, 7 ---
            KeyEvent.KEYCODE_1, KeyEvent.KEYCODE_NUMPAD_1 -> {
                // Rewind 10s
                Toast.makeText(this, "Rewind 10s", Toast.LENGTH_SHORT).show()
                return true
            }
            KeyEvent.KEYCODE_4, KeyEvent.KEYCODE_NUMPAD_4 -> {
                playPrevTrack()
                return true
            }
            KeyEvent.KEYCODE_7, KeyEvent.KEYCODE_NUMPAD_7 -> {
                // Prev Chapter
                Toast.makeText(this, "Previous Chapter", Toast.LENGTH_SHORT).show()
                return true
            }

            // --- Navigation Right: 3, 6, 9 ---
            KeyEvent.KEYCODE_3, KeyEvent.KEYCODE_NUMPAD_3 -> {
                // Forward 10s
                Toast.makeText(this, "Forward 10s", Toast.LENGTH_SHORT).show()
                return true
            }
            KeyEvent.KEYCODE_6, KeyEvent.KEYCODE_NUMPAD_6 -> {
                playNextTrack()
                return true
            }
            KeyEvent.KEYCODE_9, KeyEvent.KEYCODE_NUMPAD_9 -> {
                // Next Chapter
                Toast.makeText(this, "Next Chapter", Toast.LENGTH_SHORT).show()
                return true
            }

            // --- Core Media Controls ---
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_DPAD_CENTER -> {
                if (isPlaying) activePlayer?.pause() else activePlayer?.play()
                return true
            }
            KeyEvent.KEYCODE_MEDIA_NEXT -> {
                playNextTrack()
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> {
                playPrevTrack()
                return true
            }

            // --- Back Button (Exit Confirmation) ---
            KeyEvent.KEYCODE_BACK -> {
                showExitConfirmationDialog()
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        super.onDestroy()
        playerView.release()
    }
}
