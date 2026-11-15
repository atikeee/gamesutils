package com.rahmanma.gamesutils.tv

import android.view.ViewGroup
import androidx.leanback.widget.ImageCardView
import androidx.leanback.widget.Presenter
import com.bumptech.glide.Glide

class VideoCardPresenter : Presenter() {
    override fun onCreateViewHolder(parent: ViewGroup): ViewHolder {
        val cardView = ImageCardView(parent.context).apply {
            isFocusable = true
            isFocusableInTouchMode = true
            setMainImageDimensions(310, 175)
        }
        return ViewHolder(cardView)
    }

    override fun onBindViewHolder(viewHolder: ViewHolder, item: Any) {
        val video = item as VideoItem
        val cardView = viewHolder.view as ImageCardView

        cardView.titleText = video.title ?: "Untitled"
        cardView.contentText = video.artist ?: ""

        val thumbUrl = video.thumbnail_url ?: "https://img.youtube.com/vi/${video.video_id}/mqdefault.jpg"
        Glide.with(cardView.context)
            .load(thumbUrl)
            .centerCrop()
            .into(cardView.mainImageView)
    }

    override fun onUnbindViewHolder(viewHolder: ViewHolder) {
        val cardView = viewHolder.view as ImageCardView
        cardView.badgeImage = null
        cardView.mainImage = null
    }
}
