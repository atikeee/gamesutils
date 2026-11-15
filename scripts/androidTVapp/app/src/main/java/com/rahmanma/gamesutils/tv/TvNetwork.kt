package com.rahmanma.gamesutils.tv

import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.GET
import retrofit2.http.Query

interface TvApiService {
    @GET("mm/api/tv/videos")
    suspend fun getTvVideos(
        @Query("playlist") playlist: String? = null,
        @Query("page") page: Int = 1,
        @Query("per_page") perPage: Int = 50
    ): TvApiResponse
}

object TvApiClient {
    fun createService(host: String, port: String): TvApiService {
        val baseUrl = "http://$host:$port/"
        return Retrofit.Builder()
            .baseUrl(baseUrl)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(TvApiService::class.java)
    }
}
