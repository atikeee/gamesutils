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
let ytPlayer = null;
let currentTrackIndex = 0;
let playlistItems = [];
let activeChapters = [];
let pendingDeleteVideoId = null;

// Ensure YouTube API Script is loaded
(function loadYouTubeApi() {
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
    activeChapters = [];
    try {
        const raw = itemEl?.getAttribute('data-chapters');
        if (raw) activeChapters = JSON.parse(raw);
    } catch (e) {
        activeChapters = [];
    }
    ensureChapters(itemEl);
}

// One-time server lookup; the server marks chapter_checked so it never repeats
function ensureChapters(itemEl) {
    if (!itemEl || itemEl.dataset.chapterChecked !== '0') return;
    const dbId = itemEl.getAttribute('data-id');
    if (!dbId) return;
    itemEl.dataset.chapterChecked = 'pending';

    fetch(`/mm/api/video/${dbId}/chapters`, { method: 'POST' })
        .then(r => r.json())
        .then(res => {
            if (!res.success) throw new Error(res.error || 'lookup failed');
            itemEl.setAttribute('data-chapters', JSON.stringify(res.chapters));
            itemEl.dataset.chapterChecked = '1';
            if (playlistItems[currentTrackIndex] === itemEl) activeChapters = res.chapters;
            console.log(`[Chapters] ${res.chapters.length} chapter(s) for video ${dbId}`);
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

function onPlayerStateChange(event) {
    const isAudioOnly = document.getElementById('audioOnlyToggle')?.checked;
    const playBtn = document.getElementById('mainPlayBtn');
    const eq = document.getElementById('mainEqualizer');
    const activeCard = document.getElementById('activeVideoCard');

    if (isAudioOnly && event.data === YT.PlayerState.PLAYING) {
        if (typeof event.target.setPlaybackQuality === 'function') {
            event.target.setPlaybackQuality('small');
        }
    }

    if (event.data === YT.PlayerState.PLAYING) {
        localStorage.setItem('mm_continuous_play', 'true');
        if (playBtn) {
            playBtn.querySelector('.icon-play').style.display = 'none';
            playBtn.querySelector('.icon-pause').style.display = 'inline';
        }
        if (eq) eq.classList.add('playing');

        checkAndUpdateMetadata(activeCard);
    } else {
        if (playBtn) {
            playBtn.querySelector('.icon-play').style.display = 'inline';
            playBtn.querySelector('.icon-pause').style.display = 'none';
        }
        if (eq) eq.classList.remove('playing');
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

                fetch(`/mm/api/video/${dbId}/update_metadata`, {
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
    if ([100, 101, 150].includes(event.data)) {
        const activeCard = document.getElementById('activeVideoCard');
        const dbId = activeCard?.getAttribute('data-id');
        const title = playlistItems[currentTrackIndex]?.getAttribute('data-title') || 'This video';

        if (dbId) {
            showUnavailableModal(dbId, title);
        }
    }
}

function showUnavailableModal(videoId, title) {
    pendingDeleteVideoId = videoId;
    const modal = document.getElementById('unavailableModal');
    const desc = document.getElementById('unavailableDesc');
    if (desc) {
        desc.textContent = `"${title}" cannot be played or has been removed from YouTube.`;
    }
    if (modal) {
        modal.style.display = 'flex';
    }
}

function hideUnavailableModal() {
    pendingDeleteVideoId = null;
    const modal = document.getElementById('unavailableModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Single-click deletion without secondary alerts
function executeDeleteVideo(videoId) {
    if (!videoId) return;

    fetch(`/mm/api/video/${videoId}`, {
        method: 'DELETE'
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            hideUnavailableModal();
            const allItems = Array.from(document.querySelectorAll('.playlist-item'));
            if (allItems.length > 1) {
                const deletedItem = allItems[currentTrackIndex];
                if (deletedItem) deletedItem.remove();
                playlistItems = Array.from(document.querySelectorAll('.playlist-item'));
                if (currentTrackIndex >= playlistItems.length) {
                    currentTrackIndex = 0;
                }
                loadTrackByIndex(currentTrackIndex, true);
            } else {
                window.location.reload();
            }
        } else {
            alert("Failed to delete video from database.");
            hideUnavailableModal();
        }
    })
    .catch(() => {
        alert("Server error deleting video.");
        hideUnavailableModal();
    });
}

// Load a specific track by playlist index (controls=0 prevents native YouTube scrubber)
function loadTrackByIndex(index, autoPlay = true) {
    playlistItems = Array.from(document.querySelectorAll('.playlist-item'));
    if (!playlistItems.length || index < 0 || index >= playlistItems.length) return;
    currentTrackIndex = index;
    const targetItem = playlistItems[index];

    const vidId = targetItem.getAttribute('data-video-id');
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
    if (!ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;
    const current = ytPlayer.getCurrentTime();

    if (activeChapters && activeChapters.length > 0) {
        if (direction === 'next') {
            const nextCh = activeChapters.find(ch => ch.seconds > current + 1);
            if (nextCh) ytPlayer.seekTo(nextCh.seconds, true);
        } else {
            const prevChs = activeChapters.filter(ch => ch.seconds < current - 2);
            if (prevChs.length > 0) {
                const prevCh = prevChs[prevChs.length - 1];
                ytPlayer.seekTo(prevCh.seconds, true);
            } else {
                ytPlayer.seekTo(0, true);
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
        const badge = document.createElement('span');
        badge.className = 'tag-badge';
        badge.setAttribute('data-tag', tag);
        badge.innerHTML = `${tag} <button class="remove-tag-btn" data-tag="${tag}">&times;</button>`;
        badge.querySelector('.remove-tag-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            removeTagFromVideo(videoId, tag);
        });
        container.appendChild(badge);
    });
}

// In-Place Tag Addition (Zero Reload)
function addTagToVideo(videoId, tag) {
    if (!tag) return;
    fetch(`/mm/api/video/${videoId}/tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: tag })
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            const container = document.getElementById('activeTagList');
            if (container && !container.querySelector(`[data-tag="${tag}"]`)) {
                const badge = document.createElement('span');
                badge.className = 'tag-badge';
                badge.setAttribute('data-tag', tag);
                badge.innerHTML = `${tag} <button class="remove-tag-btn" data-tag="${tag}">&times;</button>`;
                badge.querySelector('.remove-tag-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    removeTagFromVideo(videoId, tag);
                });
                container.appendChild(badge);
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
    fetch(`/mm/api/video/${videoId}/tag`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: tag })
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            const badge = document.querySelector(`#activeTagList [data-tag="${tag}"]`);
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

// ── Inline playlist / category editor ─────────────────────────────────────────
// Click the value → editable input with a suggestion list; Enter/pick saves, Esc cancels.

const INLINE_EMPTY_LABEL = { playlist: '', category: '+ category' };

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderInlineValue(el, value) {
    if (!el) return;
    const field = el.dataset.field;
    el.classList.remove('editing');
    el.dataset.value = value;
    el.textContent = value || INLINE_EMPTY_LABEL[field];
    el.classList.toggle('empty', !value);
}

function setupInlineEdit(el) {
    el.addEventListener('click', () => openInlineEdit(el));
    el.addEventListener('keydown', (e) => {
        if (!el.classList.contains('editing') && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            openInlineEdit(el);
        }
    });
}

function openInlineEdit(el) {
    if (el.classList.contains('editing')) return;
    const field = el.dataset.field;
    const current = el.dataset.value || '';
    const options = (window.MM_OPTIONS && window.MM_OPTIONS[field]) || [];

    el.classList.add('editing');
    el.textContent = '';
    const input = document.createElement('input');
    input.className = 'inline-edit-input';
    input.value = current;
    input.placeholder = field === 'category' ? 'category (empty = none)' : 'playlist';
    input.autocomplete = 'off';
    const list = document.createElement('div');
    list.className = 'inline-suggest';
    el.append(input, list);

    const renderOptions = () => {
        const typed = input.value.trim().toLowerCase();
        // show every option until the user starts typing something new
        const q = input.value.trim() === current ? '' : typed;
        const matches = options.filter(o => o.toLowerCase().includes(q));
        list.innerHTML = matches.map(o =>
            `<div class="inline-suggest-item${o === current ? ' current' : ''}" data-v="${escapeHtml(o)}">${escapeHtml(o)}</div>`
        ).join('');
        list.hidden = !matches.length;
    };

    let done = false;
    const finish = (save, picked) => {
        if (done) return;
        done = true;
        const value = (picked ?? input.value).trim();
        const changed = value !== current && (value || field === 'category');
        if (save && changed) commitInlineEdit(el, value, current);
        else renderInlineValue(el, current);
    };

    list.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.inline-suggest-item');
        if (!item) return;
        e.preventDefault();   // keep focus so blur doesn't save the half-typed text first
        finish(true, item.dataset.v);
    });
    input.addEventListener('input', renderOptions);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));

    renderOptions();
    input.focus();
    input.select();
}

function commitInlineEdit(el, value, previous) {
    const field = el.dataset.field;
    const dbId = document.getElementById('activeVideoCard')?.getAttribute('data-id');
    if (!dbId) return renderInlineValue(el, previous);

    renderInlineValue(el, value);
    fetch(`/mm/api/video/${dbId}/${field}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value })
    })
    .then(r => r.json())
    .then(data => {
        if (!data.success) throw new Error(data.error || `Failed to update ${field}.`);
        const item = playlistItems[currentTrackIndex];
        if (item && item.getAttribute('data-id') === dbId) item.setAttribute(`data-${field}`, value);
        const opts = window.MM_OPTIONS?.[field];
        if (value && opts && !opts.includes(value)) {
            opts.push(value);
            opts.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        }
    })
    .catch(err => {
        console.warn(`[${field}] update error:`, err);
        renderInlineValue(el, previous);
        alert(err.message || `Failed to update ${field}.`);
    });
}

// Trigger browser cast
function triggerCastFlow() {
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

    // 9. Refined Tag Addition: NEVER auto-pick while typing single letters!
    const addTagBtn = document.getElementById('addInlineTagBtn');
    const tagInput = document.getElementById('inlineTagInput');
    const tagDatalist = document.getElementById('playlistTagsDatalist');

    if (tagInput) {
        function triggerAddTag(val) {
            const activeCard = document.getElementById('activeVideoCard');
            const videoId = activeCard?.getAttribute('data-id');
            const cleanVal = (val || tagInput.value).trim();
            if (videoId && cleanVal) {
                addTagToVideo(videoId, cleanVal);
                tagInput.value = '';
                tagInput.blur();
            }
        }

        // Only auto-add if the user specifically clicked/selected an item from the dropdown!
        tagInput.addEventListener('input', (e) => {
            // If user is actively typing with the keyboard (e.g. typing 'm', 'ml'), NEVER auto-pick!
            if (e.inputType === 'insertText' || e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') {
                return;
            }

            // In Chromium/Firefox, when selecting an item from datalist with mouse/arrow keys, inputType is 'insertReplacementText' or undefined
            const currentVal = tagInput.value.trim();
            if (!currentVal || !tagDatalist) return;

            const options = Array.from(tagDatalist.querySelectorAll('option')).map(o => o.value);
            const exactMatch = options.find(o => o.toLowerCase() === currentVal.toLowerCase());
            
            // Only auto-add when selected from dropdown
            if (exactMatch && (e.inputType === 'insertReplacementText' || !e.inputType)) {
                console.log(`[Tag] Picked from dropdown: "${exactMatch}"`);
                triggerAddTag(exactMatch);
            }
        });

        // Add on Enter key (accepts whatever is typed, e.g. 'ml', 'mx', or exact match)
        tagInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = tagInput.value.trim();
                if (val) triggerAddTag(val);
            }
        });

        // Add on '+' button click
        if (addTagBtn) {
            addTagBtn.addEventListener('click', () => triggerAddTag());
        }
    }

    // 10. Inline playlist / category editors
    document.querySelectorAll('.inline-edit').forEach(setupInlineEdit);

    // 11. Unavailable Warning Modal Controls
    const cancelDeleteBtn = document.getElementById('cancelDeleteModalBtn');
    const confirmDeleteBtn = document.getElementById('confirmDeleteModalBtn');

    if (cancelDeleteBtn) {
        cancelDeleteBtn.addEventListener('click', () => {
            hideUnavailableModal();
            playNextTrack(true);
        });
    }

    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', () => {
            if (pendingDeleteVideoId) {
                executeDeleteVideo(pendingDeleteVideoId);
            }
        });
    }

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

    // 7. Add Video Modal Handlers
    const addModal = document.getElementById('addVideoModal');
    const openAddBtn = document.getElementById('openAddModalBtn');
    const cancelAddBtn = document.getElementById('cancelAddBtn');
    const submitAddBtn = document.getElementById('submitAddBtn');

    if (openAddBtn && addModal) openAddBtn.addEventListener('click', () => addModal.style.display = 'flex');
    if (cancelAddBtn && addModal) cancelAddBtn.addEventListener('click', () => addModal.style.display = 'none');

    if (submitAddBtn) {
        submitAddBtn.addEventListener('click', () => {
            const url = document.getElementById('newVideoUrlInput').value.trim();
            const playlist = document.getElementById('newVideoPlaylistInput').value.trim();
            const category = document.getElementById('newVideoCategoryInput')?.value.trim() || '';
            const tagsRaw = document.getElementById('newVideoTagsInput').value.trim();
            const tags = tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

            if (!url) return alert("Please enter a YouTube link or ID.");

            submitAddBtn.textContent = "Saving...";
            submitAddBtn.disabled = true;

            fetch('/mm/api/video/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: url, playlist: playlist, category: category, tags: tags })
            })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    window.location.reload();
                } else {
                    alert(data.error || "Failed to add video.");
                    submitAddBtn.textContent = "Save Video";
                    submitAddBtn.disabled = false;
                }
            })
            .catch(() => {
                alert("Server error adding video.");
                submitAddBtn.textContent = "Save Video";
                submitAddBtn.disabled = false;
            });
        });
    }
});