package com.rahmanma.gamesutils.tv

data class VideoItem(
    val id: Int = 0,
    val video_id: String = "",
    val title: String? = null,
    val artist: String? = null,
    val duration: Int? = 0,
    val thumbnail_url: String? = null,
    val playlist: String? = null
)

data class TvApiResponse(
    val status: String = "",
    val current_playlist: String = "",
    val page: Int = 1,
    val playlists: List<String> = emptyList(),
    val videos: List<VideoItem> = emptyList()
)
