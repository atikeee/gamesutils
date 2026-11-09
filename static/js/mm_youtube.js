// Google Cast Initialization
window['__onGCastApiAvailable'] = function(isAvailable) {
    if (isAvailable) {
        try {
            cast.framework.CastContext.getInstance().setOptions({
                receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
                autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
            });
            console.log("[Cast] Google Cast SDK initialized.");

            const ctx = cast.framework.CastContext.getInstance();
            const syncCastVisibility = () => {
                const w = document.getElementById('castWrapper');
                if (w) w.hidden = ctx.getCastState() === cast.framework.CastState.NO_DEVICES_AVAILABLE;
            };
            ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, syncCastVisibility);
            document.addEventListener('DOMContentLoaded', syncCastVisibility);
            syncCastVisibility();
        } catch (e) {
            console.warn("[Cast] Init notice:", e);
        }
    }
};

// Global state
const appContainer = document.getElementById('appContainer');
const MEDIA_SOURCE = appContainer?.dataset.sourceType || 'youtube';
const API_BASE = appContainer?.dataset.apiBase || '/mm/api/video';
const mediaApi = path => `${API_BASE}${path}`;
let ytPlayer = null;
let currentTrackIndex = 0;
let playlistItems = [];
let activeChapters = [];
let pendingDeleteVideoId = null;

// Ensure YouTube API Script is loaded
(function loadYouTubeApi() {
    if (MEDIA_SOURCE !== 'youtube') return;
    window.onYouTubeIframeAPIReady = initMainPlayer;
    if (!window.YT) {
        const tag = document.createElement('script');
        tag.src = "https://www.youtube.com/iframe_api";
        const first = document.getElementsByTagName('script')[0];
        if (first && first.parentNode) {
            first.parentNode.insertBefore(tag, first);
        } else {
            document.head.appendChild(tag);
        }
    } else if (window.YT && window.YT.Player) {
        initMainPlayer();
    }
})();

// YouTube Player Factory
function initMainPlayer() {
    playlistItems = Array.from(document.querySelectorAll('.playlist-item'));
    if (MEDIA_SOURCE === 'local') return;
    if (!playlistItems.length) return;

    if (ytPlayer) return;

    const iframe = document.getElementById('main-yt-player');
    if (!iframe) return;

    try {
        ytPlayer = new YT.Player('main-yt-player', {
            playerVars: {
                'controls': 1,        // native on-video timeline + fullscreen
                'rel': 0,
                'modestbranding': 1,
                'playsinline': 1,
                'fs': 1,
                'origin': window.location.origin
            },
            events: {
                'onReady': onPlayerReady,
                'onStateChange': onPlayerStateChange,
                'onError': onPlayerError
            }
        });
    } catch (e) {
        console.warn("[Player] Note initializing YT.Player:", e);
    }
}

function parseChaptersFromItem(itemEl) {
    activeChapters = parseChapterTimestamps(itemEl?.getAttribute('data-chapters'));
    const chapterInput = document.getElementById('youtubeChapterInput');
    if (chapterInput) chapterInput.value = itemEl?.getAttribute('data-chapters') || '';
    const chapterStatus = document.getElementById('youtubeChapterStatus');
    if (chapterStatus) chapterStatus.textContent = '';
    ensureChapters(itemEl);
}

// One-time server lookup; the server marks chapter_checked so it never repeats
function ensureChapters(itemEl) {
    if (!itemEl || itemEl.dataset.chapterChecked !== '0' || itemEl.getAttribute('data-chapters')?.trim()) return;
    const dbId = itemEl.getAttribute('data-id');
    if (!dbId) return;
    itemEl.dataset.chapterChecked = 'pending';

    fetch(mediaApi(`/${dbId}/chapters`), { method: 'POST' })
        .then(r => r.json())
        .then(res => {
            if (!res.success) throw new Error(res.error || 'lookup failed');
            itemEl.setAttribute('data-chapters', res.chapter || '');
            itemEl.dataset.chapterChecked = '1';
            if (playlistItems[currentTrackIndex] === itemEl) {
                activeChapters = parseChapterTimestamps(res.chapter);
                const chapterInput = document.getElementById('youtubeChapterInput');
                if (chapterInput) chapterInput.value = res.chapter || '';
            }
            console.log(`[Chapters] ${activeChapters.length} chapter(s) for video ${dbId}`);
        })
        .catch(err => {
            itemEl.dataset.chapterChecked = '0';
            console.warn('[Chapters] lookup error:', err);
        });
}

function onPlayerReady(event) {
    console.log("[Player] YouTube API Player is Ready.");

    const isAudioOnly = document.getElementById('audioOnlyToggle')?.checked;
    if (isAudioOnly && typeof event.target.setPlaybackQuality === 'function') {
        event.target.setPlaybackQuality('small');
    }

    const continuousPlay = localStorage.getItem('mm_continuous_play') === 'true';
    if (continuousPlay && typeof event.target.playVideo === 'function') {
        event.target.playVideo();
    }
}

function setPlaybackButtonState(playing) {
    const playBtn = document.getElementById('mainPlayBtn');
    const eq = document.getElementById('mainEqualizer');
    if (playBtn) {
        playBtn.querySelector('.icon-play').style.display = playing ? 'none' : 'inline';
        playBtn.querySelector('.icon-pause').style.display = playing ? 'inline' : 'none';
    }
    if (eq) eq.classList.toggle('playing', playing);
}

function onPlayerStateChange(event) {
    const isAudioOnly = document.getElementById('audioOnlyToggle')?.checked;
    const activeCard = document.getElementById('activeVideoCard');

    if (isAudioOnly && event.data === YT.PlayerState.PLAYING) {
        if (typeof event.target.setPlaybackQuality === 'function') {
            event.target.setPlaybackQuality('small');
        }
    }

    if (event.data === YT.PlayerState.PLAYING) {
        localStorage.setItem('mm_continuous_play', 'true');
        setPlaybackButtonState(true);

        checkAndUpdateMetadata(activeCard);
    } else {
        setPlaybackButtonState(false);
    }

    // Auto-advance to next track on video end (No suggestion screen shown)
    if (event.data === YT.PlayerState.ENDED) {
        playNextTrack(true);
    }
}

// Automatic metadata updater when is_new == 1
function checkAndUpdateMetadata(activeCard) {
    if (!activeCard || !ytPlayer) return;
    const isNew = activeCard.getAttribute('data-is-new');
    const dbId = activeCard.getAttribute('data-id');

    if (isNew === '1' && dbId && typeof ytPlayer.getVideoData === 'function') {
        try {
            const data = ytPlayer.getVideoData();
            const duration = Math.round(ytPlayer.getDuration ? ytPlayer.getDuration() : 0);

            if (data && data.title) {
                const title = data.title;
                const artist = data.author || 'YouTube';

                fetch(mediaApi(`/${dbId}/update_metadata`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: title,
                        artist: artist,
                        duration: duration
                    })
                })
                .then(r => r.json())
                .then(res => {
                    if (res && res.success) {
                        activeCard.setAttribute('data-is-new', '0');
                        document.getElementById('overlayTitle').textContent = title;
                        document.getElementById('overlayArtist').textContent = artist;

                        const curItem = playlistItems[currentTrackIndex];
                        if (curItem) {
                            curItem.setAttribute('data-is-new', '0');
                            curItem.setAttribute('data-title', title);
                            curItem.setAttribute('data-artist', artist);
                            const tEl = curItem.querySelector('.item-title');
                            const aEl = curItem.querySelector('.item-artist');
                            if (tEl) tEl.textContent = title;
                            if (aEl) aEl.textContent = artist;
                        }
                    }
                })
                .catch(err => console.warn("[Metadata] Update fetch error:", err));
            }
        } catch (e) {
            console.warn("[Metadata] Error reading video data:", e);
        }
    }
}

// YouTube error handler (detects deleted/unavailable videos)
function onPlayerError(event) {
console.warn(`[Player] Video unavailable (error code ${event.data}). Skipping to next track.`);
    setTimeout(() => {
        playNextTrack(true);
    }, 10000);
}

// Load a specific track by playlist index (controls=0 prevents native YouTube scrubber)
function loadTrackByIndex(index, autoPlay = true) {
    playlistItems = Array.from(document.querySelectorAll('.playlist-item'));
    if (!playlistItems.length || index < 0 || index >= playlistItems.length) return;
    currentTrackIndex = index;
    const targetItem = playlistItems[index];

    const vidId = targetItem.getAttribute('data-video-id');
    const mediaUrl = targetItem.getAttribute('data-url');
    const dbId = targetItem.getAttribute('data-id');
    const title = targetItem.getAttribute('data-title');
    const artist = targetItem.getAttribute('data-artist');
    const thumb = targetItem.getAttribute('data-thumb');
    const playlist = targetItem.getAttribute('data-playlist') || 'none';
    const isNew = targetItem.getAttribute('data-is-new') || '0';
    const tags = targetItem.getAttribute('data-tags') || '';

    // Update Player & Overlays
    const activeCard = document.getElementById('activeVideoCard');
    if (activeCard) {
        activeCard.setAttribute('data-video-id', vidId);
        activeCard.setAttribute('data-id', dbId);
        activeCard.setAttribute('data-is-new', isNew);
        activeCard.setAttribute('data-url', mediaUrl || '');
    }

    const oTitle = document.getElementById('overlayTitle');
    const oArtist = document.getElementById('overlayArtist');

    if (oTitle) oTitle.textContent = title;
    if (oArtist) oArtist.textContent = artist;
    renderInlineValue(document.getElementById('playlistEdit'), playlist);
    renderInlineValue(document.getElementById('categoryEdit'), targetItem.getAttribute('data-category') || '');

    const bgThumb = document.getElementById('audioBgThumb');
    const coverImg = document.getElementById('audioCoverImg');
    if (bgThumb) bgThumb.style.backgroundImage = `url('${thumb}')`;
    if (coverImg) coverImg.src = thumb;

    renderActiveTags(dbId, tags);

    // Highlight active in playlist sidebar
    playlistItems.forEach(el => el.classList.remove('active'));
    targetItem.classList.add('active');

    parseChaptersFromItem(targetItem);

    if (autoPlay) {
        localStorage.setItem('mm_continuous_play', 'true');
    }

    if (MEDIA_SOURCE === 'local') {
        const localPlayer = document.getElementById('main-local-player');
        if (!localPlayer || !mediaUrl) return;
        localPlayer.src = mediaUrl;
        localPlayer.load();
        if (autoPlay) localPlayer.play().catch(error => console.warn('[Player] Playback could not start:', error));
        else localPlayer.pause();
        return;
    }

    // Try YouTube Player API first
    if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
        const isAudioOnly = document.getElementById('audioOnlyToggle')?.checked;
        ytPlayer.loadVideoById(vidId);
        if (isAudioOnly && typeof ytPlayer.setPlaybackQuality === 'function') {
            ytPlayer.setPlaybackQuality('small');
        }
        if (!autoPlay && typeof ytPlayer.pauseVideo === 'function') {
            ytPlayer.pauseVideo();
        }
    } else {
        // Direct Iframe Fallback
        const iframe = document.getElementById('main-yt-player');
        if (iframe) {
            const autoplayParam = autoPlay ? '&autoplay=1' : '';
            iframe.src = `https://www.youtube.com/embed/${vidId}?enablejsapi=1&controls=1&fs=1&rel=0&modestbranding=1&playsinline=1${autoplayParam}`;
        }
    }
}

// Play Next Track with automatic Cross-Page Navigation
function playNextTrack(autoPlay = true) {
    playlistItems = Array.from(document.querySelectorAll('.playlist-item'));
    if (currentTrackIndex + 1 < playlistItems.length) {
        loadTrackByIndex(currentTrackIndex + 1, autoPlay);
    } else {
        const container = document.getElementById('appContainer');
        const curPage = parseInt(container?.getAttribute('data-page') || '1', 10);
        const totalPages = parseInt(container?.getAttribute('data-total-pages') || '1', 10);
        const playlist = container?.getAttribute('data-playlist') || '';

        let nextPage = curPage + 1;
        if (nextPage > totalPages) {
            nextPage = 1;
        }

        if (autoPlay) {
            localStorage.setItem('mm_continuous_play', 'true');
        }

        const url = new URL(window.location.href);
        url.searchParams.set('page', nextPage.toString());
        if (playlist) {
            url.searchParams.set('playlist', playlist);
        }
        window.location.href = url.toString();
    }
}

// Play Previous Track with Cross-Page Navigation
function playPrevTrack(autoPlay = true) {
    playlistItems = Array.from(document.querySelectorAll('.playlist-item'));
    if (currentTrackIndex - 1 >= 0) {
        loadTrackByIndex(currentTrackIndex - 1, autoPlay);
    } else {
        const container = document.getElementById('appContainer');
        const curPage = parseInt(container?.getAttribute('data-page') || '1', 10);
        const playlist = container?.getAttribute('data-playlist') || '';

        if (curPage > 1) {
            if (autoPlay) localStorage.setItem('mm_continuous_play', 'true');
            const url = new URL(window.location.href);
            url.searchParams.set('page', (curPage - 1).toString());
            if (playlist) url.searchParams.set('playlist', playlist);
            window.location.href = url.toString();
        }
    }
}

function seekRelative(seconds) {
    if (MEDIA_SOURCE === 'local') {
        const localPlayer = document.getElementById('main-local-player');
        if (!localPlayer || !Number.isFinite(localPlayer.duration)) return;
        localPlayer.currentTime = Math.max(0, Math.min(localPlayer.duration, localPlayer.currentTime + seconds));
        return;
    }
    if (ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
        const current = ytPlayer.getCurrentTime();
        const duration = ytPlayer.getDuration ? ytPlayer.getDuration() : 0;
        const target = Math.max(0, Math.min(duration, current + seconds));
        ytPlayer.seekTo(target, true);
    } else {
        const iframe = document.getElementById('main-yt-player');
        if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage(JSON.stringify({
                event: 'command',
                func: 'seekTo',
                args: [0, true]
            }), '*');
        }
    }
}

function jumpChapter(direction) {
    const localPlayer = MEDIA_SOURCE === 'local' ? document.getElementById('main-local-player') : null;
    if (!localPlayer && (!ytPlayer || typeof ytPlayer.getCurrentTime !== 'function')) return;
    const current = localPlayer ? localPlayer.currentTime : ytPlayer.getCurrentTime();
    const seek = seconds => {
        if (localPlayer) localPlayer.currentTime = seconds;
        else ytPlayer.seekTo(seconds, true);
    };

    if (activeChapters && activeChapters.length > 0) {
        if (direction === 'next') {
            const nextCh = activeChapters.find(seconds => seconds > current + 1);
            if (nextCh !== undefined) seek(nextCh);
        } else {
            const prevChs = activeChapters.filter(seconds => seconds < current - 2);
            if (prevChs.length > 0) {
                const prevCh = prevChs[prevChs.length - 1];
                seek(prevCh);
            } else {
                seek(0);
            }
        }
    } else {
        seekRelative(direction === 'next' ? 30 : -30);
    }
}

// Fullscreen Toggle on the Video Player
function toggleFullscreen() {
    const container = document.getElementById('activeVideoCard');
    if (!container) return;

    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (container.requestFullscreen) {
            container.requestFullscreen();
        } else if (container.webkitRequestFullscreen) {
            container.webkitRequestFullscreen();
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        }
    }
}

function renderActiveTags(videoId, tagString) {
    const container = document.getElementById('activeTagList');
    if (!container) return;
    container.innerHTML = '';
    const tags = tagString ? tagString.split(',').map(s => s.trim()).filter(Boolean) : [];
    tags.forEach(tag => {
        container.appendChild(makeTagBadge(tag, t => removeTagFromVideo(videoId, t)));
    });
}

// In-Place Tag Addition (Zero Reload)
function addTagToVideo(videoId, tag) {
    if (!tag) return;
    fetch(mediaApi(`/${videoId}/tag`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: tag })
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            const container = document.getElementById('activeTagList');
            if (container && !container.querySelector(`[data-tag="${CSS.escape(tag)}"]`)) {
                container.appendChild(makeTagBadge(tag, t => removeTagFromVideo(videoId, t)));
            }

            const allItems = Array.from(document.querySelectorAll('.playlist-item'));
            const curItem = allItems[currentTrackIndex];
            if (curItem) {
                const existing = curItem.getAttribute('data-tags') || '';
                const tagArr = existing.split(',').map(s => s.trim()).filter(Boolean);
                if (!tagArr.includes(tag)) {
                    tagArr.push(tag);
                    curItem.setAttribute('data-tags', tagArr.join(','));
                    
                    let tagsDiv = curItem.querySelector('.item-tags');
                    if (!tagsDiv) {
                        tagsDiv = document.createElement('div');
                        tagsDiv.className = 'item-tags';
                        curItem.querySelector('.item-info')?.appendChild(tagsDiv);
                    }
                    const mini = document.createElement('span');
                    mini.className = 'mini-tag';
                    mini.textContent = tag;
                    tagsDiv.appendChild(mini);
                }
            }
        }
    })
    .catch(err => console.warn("[Tag] Error adding tag:", err));
}

// In-Place Tag Removal (Zero Reload)
function removeTagFromVideo(videoId, tag) {
    fetch(mediaApi(`/${videoId}/tag`), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: tag })
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            const badge = document.querySelector(`#activeTagList [data-tag="${CSS.escape(tag)}"]`);
            if (badge) badge.remove();

            const allItems = Array.from(document.querySelectorAll('.playlist-item'));
            const curItem = allItems[currentTrackIndex];
            if (curItem) {
                const existing = curItem.getAttribute('data-tags') || '';
                const tagArr = existing.split(',').map(s => s.trim()).filter(t => t !== tag);
                curItem.setAttribute('data-tags', tagArr.join(','));

                const miniTags = curItem.querySelectorAll('.item-tags .mini-tag');
                miniTags.forEach(m => {
                    if (m.textContent.trim() === tag) m.remove();
                });
            }
        }
    })
    .catch(err => console.warn("[Tag] Error removing tag:", err));
}

// Persist an inline playlist / category edit (editor itself lives in mm_common.js)
function commitInlineEdit(el, value, previous) {
    const field = el.dataset.field;
    const dbId = document.getElementById('activeVideoCard')?.getAttribute('data-id');
    if (!dbId) return renderInlineValue(el, previous);

    renderInlineValue(el, value);
    fetch(mediaApi(`/${dbId}/${field}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value })
    })
    .then(r => r.json())
    .then(data => {
        if (!data.success) throw new Error(data.error || `Failed to update ${field}.`);
        const item = playlistItems[currentTrackIndex];
        if (item && item.getAttribute('data-id') === dbId) item.setAttribute(`data-${field}`, value);
        addInlineOption(field, value);
    })
    .catch(err => {
        console.warn(`[${field}] update error:`, err);
        renderInlineValue(el, previous);
        alert(err.message || `Failed to update ${field}.`);
    });
}

// Trigger browser cast
function triggerCastFlow() {
    if (MEDIA_SOURCE === 'local') return;
    console.log("[Cast] Triggering Cast flow...");
    if (window.cast && cast.framework && cast.framework.CastContext) {
        try {
            const ctx = cast.framework.CastContext.getInstance();
            ctx.requestSession()
                .then(() => console.log("[Cast] Active Cast session started."))
                .catch(err => {
                    console.log("[Cast] Cast session prompt closed or not ready:", err);
                    showBrowserCastHelp();
                });
            return;
        } catch (e) {
            console.warn("[Cast] SDK trigger error:", e);
        }
    }

    const launcher = document.getElementById('castbutton');
    if (launcher && typeof launcher.click === 'function') {
        launcher.click();
    } else {
        showBrowserCastHelp();
    }
}

function showBrowserCastHelp() {
    alert("📺 How to Cast to your TV in Chrome/Edge:\n\n1. Right-click anywhere on this page.\n2. Click 'Cast...' from the menu.\n3. Under 'Sources', choose 'Cast tab' and click your TV!");
}

function togglePlay() {
    if (MEDIA_SOURCE === 'local') {
        const localPlayer = document.getElementById('main-local-player');
        if (!localPlayer) return;
        if (localPlayer.paused) {
            localStorage.setItem('mm_continuous_play', 'true');
            localPlayer.play().catch(error => console.warn('[Player] Playback could not start:', error));
        } else {
            localStorage.removeItem('mm_continuous_play');
            localPlayer.pause();
        }
        return;
    }
    if (ytPlayer && typeof ytPlayer.getPlayerState === 'function') {
        const state = ytPlayer.getPlayerState();
        const isAudioOnly = document.getElementById('audioOnlyToggle')?.checked;
        if (state === YT.PlayerState.PLAYING) {
            localStorage.removeItem('mm_continuous_play');
            ytPlayer.pauseVideo();
        } else {
            localStorage.setItem('mm_continuous_play', 'true');
            if (isAudioOnly && typeof ytPlayer.setPlaybackQuality === 'function') {
                ytPlayer.setPlaybackQuality('small');
            }
            ytPlayer.playVideo();
        }
    } else {
        const iframe = document.getElementById('main-yt-player');
        if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*');
            localStorage.setItem('mm_continuous_play', 'true');
        }
    }
}

// Comprehensive Control Bar Binding
function setupControls() {
    playlistItems = Array.from(document.querySelectorAll('.playlist-item'));
    setupChapterEditorToggle(document.getElementById('youtubeChapterToggle'), document.getElementById('youtubeChapterForm'));

    const localPlayer = document.getElementById('main-local-player');
    if (localPlayer) {
        const saveLocalDuration = () => {
            const duration = Math.round(localPlayer.duration || 0);
            const item = playlistItems[currentTrackIndex];
            if (!duration || !item || Number(item.dataset.duration) === duration) return;
            item.dataset.duration = String(duration);
            const dbId = item.getAttribute('data-id');
            fetch(mediaApi(`/${dbId}/update_metadata`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ duration })
            }).catch(error => console.warn('[Metadata] Local duration save failed:', error));
        };
        localPlayer.addEventListener('play', () => {
            localStorage.setItem('mm_continuous_play', 'true');
            setPlaybackButtonState(true);
        });
        localPlayer.addEventListener('pause', () => setPlaybackButtonState(false));
        localPlayer.addEventListener('ended', () => playNextTrack(true));
        localPlayer.addEventListener('loadedmetadata', saveLocalDuration);
        if (localPlayer.readyState >= 1) saveLocalDuration();
        if (localStorage.getItem('mm_continuous_play') === 'true') {
            localPlayer.play().catch(error => console.warn('[Player] Autoplay was blocked:', error));
        }
    }

    document.getElementById('youtubeChapterForm')?.addEventListener('submit', async event => {
        event.preventDefault();
        const item = playlistItems[currentTrackIndex];
        const chapterInput = document.getElementById('youtubeChapterInput');
        const status = document.getElementById('youtubeChapterStatus');
        const saveButton = document.getElementById('youtubeChapterSave');
        const dbId = item?.getAttribute('data-id');
        if (!dbId || !chapterInput) return;

        const chapter = formatChapterTimestamps(chapterInput.value);
        saveButton.disabled = true;
        status.textContent = 'Saving';
        try {
            const response = await fetch(mediaApi(`/${dbId}/chapters`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chapter })
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.error || 'Could not save chapters');
            item.setAttribute('data-chapters', chapter);
            item.dataset.chapterChecked = '1';
            chapterInput.value = chapter;
            activeChapters = parseChapterTimestamps(chapter);
            status.textContent = 'Saved';
        } catch (error) {
            status.textContent = 'Not saved';
            console.warn('[Chapters] save error:', error);
        } finally {
            saveButton.disabled = false;
        }
    });

    // 1. Play / Pause
    document.getElementById('mainPlayBtn')?.addEventListener('click', togglePlay);

    // 2. Track Navigation buttons
    document.getElementById('prevTrackBtn')?.addEventListener('click', () => playPrevTrack(true));
    document.getElementById('nextTrackBtn')?.addEventListener('click', () => playNextTrack(true));

    // 3. 10s & 1min Seeking
    document.getElementById('rev10sBtn')?.addEventListener('click', () => seekRelative(-10));
    document.getElementById('fwd10sBtn')?.addEventListener('click', () => seekRelative(10));
    document.getElementById('rev1mBtn')?.addEventListener('click', () => seekRelative(-60));
    document.getElementById('fwd1mBtn')?.addEventListener('click', () => seekRelative(60));

    // 4. Chapter Navigation
    document.getElementById('prevChapterBtn')?.addEventListener('click', () => jumpChapter('prev'));
    document.getElementById('nextChapterBtn')?.addEventListener('click', () => jumpChapter('next'));

    // 5. Dynamic Playlist Item Clicks via Event Delegation
    const playlistContainer = document.getElementById('playlistList');
    if (playlistContainer) {
        playlistContainer.addEventListener('click', (e) => {
            const clickedCard = e.target.closest('.playlist-item');
            if (!clickedCard) return;
            e.preventDefault();

            const allItems = Array.from(document.querySelectorAll('.playlist-item'));
            const idx = allItems.indexOf(clickedCard);
            if (idx !== -1) {
                console.log(`[Playlist] Dynamically selected live track index ${idx}`);
                loadTrackByIndex(idx, true);
            }
        });
    }

    // 9. Tag addition: Enter / '+' adds typed text, picking from the dropdown adds immediately
    setupTagInput(
        document.getElementById('inlineTagInput'),
        document.getElementById('addInlineTagBtn'),
        document.getElementById('playlistTagsDatalist'),
        (tag) => {
            const videoId = document.getElementById('activeVideoCard')?.getAttribute('data-id');
            if (videoId) addTagToVideo(videoId, tag);
        }
    );

    // 10. Inline playlist / category editors
    document.querySelectorAll('.inline-edit').forEach(el => setupInlineEdit(el, commitInlineEdit));


    // 12. Keyboard Shortcuts Guide Modal
    const shortcutsModal = document.getElementById('shortcutsModal');
    const shortcutsBtn = document.getElementById('shortcutsHelpBtn');
    const closeShortcutsBtn = document.getElementById('closeShortcutsBtn');
    const gotItShortcutsBtn = document.getElementById('gotItShortcutsBtn');

    function openShortcutsModal() {
        if (shortcutsModal) shortcutsModal.style.display = 'flex';
    }
    function closeShortcutsModal() {
        if (shortcutsModal) shortcutsModal.style.display = 'none';
    }

    if (shortcutsBtn) shortcutsBtn.addEventListener('click', openShortcutsModal);
    if (closeShortcutsBtn) closeShortcutsBtn.addEventListener('click', closeShortcutsModal);
    if (gotItShortcutsBtn) gotItShortcutsBtn.addEventListener('click', closeShortcutsModal);
}

// Global Event Listeners & Modals on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
    // 1. Immediately bind all controls
    setupControls();
    const bgThumb = document.getElementById('audioBgThumb');
    if (bgThumb?.dataset.thumb) bgThumb.style.backgroundImage = `url('${bgThumb.dataset.thumb}')`;
    // the first video is shown without loadTrackByIndex, so load its chapters here
    parseChaptersFromItem(playlistItems[0]);

    // 2. Audio-Only Mode Toggle
    const toggle = document.getElementById('audioOnlyToggle');
    const savedAudio = localStorage.getItem('mm_audio_only_mode') === 'true';

    if (savedAudio && toggle) {
        toggle.checked = true;
        document.body.classList.add('audio-mode');
    }

    if (toggle) {
        toggle.addEventListener('change', (e) => {
            const isAudio = e.target.checked;
            localStorage.setItem('mm_audio_only_mode', isAudio);
            if (isAudio) {
                document.body.classList.add('audio-mode');
                if (ytPlayer && typeof ytPlayer.setPlaybackQuality === 'function') {
                    ytPlayer.setPlaybackQuality('small');
                }
            } else {
                document.body.classList.remove('audio-mode');
                if (ytPlayer && typeof ytPlayer.setPlaybackQuality === 'function') {
                    ytPlayer.setPlaybackQuality('default');
                }
            }
        });
    }

    // 4. Playlist (required) and Category (optional) filter dropdowns
    const playlistSelect = document.getElementById('playlistFilterSelect');
    if (playlistSelect) {
        playlistSelect.addEventListener('change', (e) => {
            const selected = e.target.value;
            const url = new URL(window.location.href);
            if (selected) {
                url.searchParams.set('playlist', selected);
            }
            url.searchParams.delete('category');
            url.searchParams.delete('tags');
            url.searchParams.set('page', '1');
            window.location.href = url.toString();
        });
    }

    const categorySelect = document.getElementById('categoryFilterSelect');
    if (categorySelect) {
        categorySelect.addEventListener('change', (e) => {
            const url = new URL(window.location.href);
            if (e.target.value) url.searchParams.set('category', e.target.value);
            else url.searchParams.delete('category');
            url.searchParams.delete('tags');
            url.searchParams.set('page', '1');
            window.location.href = url.toString();
        });
    }

    // 5. Global Keyboard Shortcuts Listener
    // centre the current page number inside the pagination strip (strip only, not the window)
    const activePill = document.querySelector('.page-num-pill.active');
    const pageTrack = document.getElementById('pageScrollTrack');
    if (activePill && pageTrack) {
        pageTrack.scrollLeft = activePill.offsetLeft - pageTrack.offsetLeft
            - pageTrack.clientWidth / 2 + activePill.offsetWidth / 2;
    }
    document.addEventListener('keydown', (e) => {
        const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
        const isEditing = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select';

        if (e.key === 'Escape') {
            document.getElementById('shortcutsModal').style.display = 'none';
            document.getElementById('addVideoModal').style.display = 'none';
            document.getElementById('unavailableModal').style.display = 'none';
            if (isEditing) document.activeElement.blur();
            return;
        }

        if (isEditing) return;

        switch (e.key) {
            case ' ':
            case 'k':
            case 'K':
                e.preventDefault();
                togglePlay();
                break;
            case 'f':
            case 'F':
                e.preventDefault();
                toggleFullscreen();
                break;
            case 'n':
            case 'N':
                playNextTrack(true);
                break;
            case 'p':
            case 'P':
                playPrevTrack(true);
                break;
            case 'j':
            case 'J':
            case 'ArrowLeft':
                e.preventDefault();
                seekRelative(-10);
                break;
            case 'l':
            case 'L':
            case 'ArrowRight':
                e.preventDefault();
                seekRelative(10);
                break;
            case '[':
                e.preventDefault();
                seekRelative(-60);
                break;
            case ']':
                e.preventDefault();
                seekRelative(60);
                break;
            case '<':
            case ',':
                jumpChapter('prev');
                break;
            case '>':
            case '.':
                jumpChapter('next');
                break;
            case 'a':
            case 'A':
                const audioTog = document.getElementById('audioOnlyToggle');
                if (audioTog) {
                    audioTog.checked = !audioTog.checked;
                    audioTog.dispatchEvent(new Event('change'));
                }
                break;
            case 'c':
            case 'C':
                triggerCastFlow();
                break;
            case '+':
            case 'v':
            case 'V':
                const addModal = document.getElementById('addVideoModal');
                if (addModal) addModal.style.display = 'flex';
                break;
            case '?':
            case 'h':
            case 'H':
                const sModal = document.getElementById('shortcutsModal');
                if (sModal) sModal.style.display = 'flex';
                break;
        }
    });

    window.lucide?.createIcons({ attrs: { width: 18, height: 18 } });
    const openDownloadButton = document.getElementById('openDownloadBtn');
    if (openDownloadButton) {
        const dialog = document.getElementById('downloadDialog');
        const form = document.getElementById('downloadForm');
        const status = document.getElementById('downloadStatus');
        const cancel = document.getElementById('downloadCancel');
        const audioButton = document.getElementById('downloadAudio');
        const videoButton = document.getElementById('downloadVideo');
        let busy = false;
        let selectedId = null;
        function finishDownload() {
            busy = false;
            audioButton.disabled = false;
            videoButton.disabled = false;
            cancel.textContent = 'Cancel';
            form.removeAttribute('aria-busy');
        }
        openDownloadButton.addEventListener('click', () => {
            if (!busy) {
                const item = playlistItems[currentTrackIndex];
                if (!item) return;
                selectedId = item.dataset.id;
                document.getElementById('downloadSelection').textContent = item.dataset.title || 'Untitled';
                status.textContent = '';
            }
            dialog.showModal();
        });
        cancel.addEventListener('click', () => dialog.close());
        async function pollDownload(jobId) {
            try {
                const response = await fetch(`/mm/api/video/download/${jobId}`);
                const result = await response.json();
                if (!response.ok || !result.success) throw new Error(result.error || 'Could not read download status.');
                status.textContent = `${result.message}${result.status === 'downloading' ? ` ${result.progress}%` : ''}`;
                if (result.status === 'complete' || result.status === 'failed') {
                    if (result.filename) status.textContent += `\n${result.filename}`;
                    finishDownload();
                } else {
                    window.setTimeout(() => pollDownload(jobId), 2000);
                }
            } catch (error) {
                status.textContent = error.message || 'Download status unavailable.';
                finishDownload();
            }
        }
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const kind = event.submitter?.dataset.kind;
            if (busy || !selectedId || !kind) return;
            busy = true;
            audioButton.disabled = true;
            videoButton.disabled = true;
            cancel.textContent = 'Close';
            form.setAttribute('aria-busy', 'true');
            status.textContent = 'Starting download...';
            try {
                const response = await fetch(`/mm/api/video/${selectedId}/download`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ kind })
                });
                const result = await response.json();
                if (!response.ok || !result.success) throw new Error(result.error || 'Could not start download.');
                pollDownload(result.job_id);
            } catch (error) {
                status.textContent = error.message || 'Could not start download.';
                finishDownload();
            }
        });
    }

    // 7. Add Video Modal Handlers
    const addModal = document.getElementById('addVideoModal');
    const openAddBtn = document.getElementById('openAddModalBtn');
    const cancelAddBtn = document.getElementById('cancelAddBtn');
    const submitAddBtn = document.getElementById('submitAddBtn');

    if (openAddBtn && addModal) openAddBtn.addEventListener('click', () => addModal.style.display = 'flex');
    if (cancelAddBtn && addModal) cancelAddBtn.addEventListener('click', () => addModal.style.display = 'none');

    if (submitAddBtn) {
        submitAddBtn.addEventListener('click', async () => {
            const urlInput = document.getElementById('newVideoUrlInput');
            const urls = [...new Set(urlInput.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
            const title = document.getElementById('newVideoTitleInput')?.value.trim() || '';
            const playlist = document.getElementById('newVideoPlaylistInput').value.trim();
            const category = document.getElementById('newVideoCategoryInput')?.value.trim() || '';
            const tagsRaw = document.getElementById('newVideoTagsInput').value.trim();
            const tags = tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

            const status = document.getElementById('addVideoStatus');
            if (!urls.length || urls.length > 50 || !playlist) {
                status.textContent = !playlist ? 'Playlist is required.' : 'Enter between 1 and 50 entries.';
                return;
            }

            submitAddBtn.textContent = "Saving...";
            submitAddBtn.disabled = true;
            cancelAddBtn.disabled = true;
            const failures = [];
            let saved = 0;
            try {
                for (const [index, url] of urls.entries()) {
                    status.textContent = `Saving ${index + 1} of ${urls.length}...`;
                    try {
                        const response = await fetch(mediaApi('/add'), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url, title: urls.length === 1 ? title : '', playlist, category, tags })
                        });
                        const data = await response.json();
                        if (!response.ok || !data.success) throw new Error(data.error || 'Failed to add video.');
                        saved++;
                    } catch (error) {
                        failures.push({ url, error: error.message || 'Server error adding video.' });
                    }
                }
                if (!failures.length) {
                    window.location.reload();
                } else {
                    urlInput.value = failures.map(failure => failure.url).join('\n');
                    status.textContent = `Saved ${saved} of ${urls.length}.\n` + failures.map(failure => `${failure.url}: ${failure.error}`).join('\n');
                }
            } finally {
                submitAddBtn.textContent = "Save Video";
                submitAddBtn.disabled = false;
                cancelAddBtn.disabled = false;
            }
        });
    }
});