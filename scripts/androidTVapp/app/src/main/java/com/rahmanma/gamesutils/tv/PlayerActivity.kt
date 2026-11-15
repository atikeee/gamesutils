package com.rahmanma.gamesutils.tv

import android.app.Activity
import android.os.Bundle
import android.view.KeyEvent
import com.pierfrancescosoffritti.androidyoutubeplayer.core.player.PlayerConstants
import com.pierfrancescosoffritti.androidyoutubeplayer.core.player.YouTubePlayer
import com.pierfrancescosoffritti.androidyoutubeplayer.core.player.listeners.AbstractYouTubePlayerListener
import com.pierfrancescosoffritti.androidyoutubeplayer.core.player.views.YouTubePlayerView

class PlayerActivity : Activity() {

    private lateinit var playerView: YouTubePlayerView
    private var activePlayer: YouTubePlayer? = null
    private var currentVideoId: String = ""
    private var isPlaying: Boolean = true

    companion object {
        const val EXTRA_VIDEO_ID = "extra_video_id"
        const val EXTRA_TITLE = "extra_title"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)

        currentVideoId = intent.getStringExtra(EXTRA_VIDEO_ID) ?: "dQw4w9WgXcQ"
        playerView = findViewById(R.id.youtube_player_view)

        playerView.initialize(object : AbstractYouTubePlayerListener() {
            override fun onReady(youTubePlayer: YouTubePlayer) {
                activePlayer = youTubePlayer
                youTubePlayer.loadVideo(currentVideoId, 0f)
            }

            override fun onStateChange(youTubePlayer: YouTubePlayer, state: PlayerConstants.PlayerState) {
                isPlaying = (state == PlayerConstants.PlayerState.PLAYING)
                if (state == PlayerConstants.PlayerState.ENDED) {
                    finish()
                }
            }
        })
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_DPAD_CENTER -> {
                if (isPlaying) activePlayer?.pause() else activePlayer?.play()
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY -> {
                activePlayer?.play()
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                activePlayer?.pause()
                return true
            }
            KeyEvent.KEYCODE_BACK -> {
                finish()
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
