let hlsPlayer = null;
let currentTrackIndex = 0;
let playlistItems = [];

document.addEventListener('DOMContentLoaded', () => {
    playlistItems = Array.from(document.querySelectorAll('.playlist-item'));
    const videoElement = document.getElementById('main-hls-player');

    if (playlistItems.length > 0 && videoElement) {
        loadTrackByIndex(0, false);
    }

    // Playlist selector change
    document.getElementById('playlistFilterSelect')?.addEventListener('change', (e) => {
        const url = new URL(window.location.href);
        url.searchParams.set('playlist', e.target.value);
        url.searchParams.set('page', '1');
        window.location.href = url.toString();
    });

    // Playlist Item Selection
    document.getElementById('playlistList')?.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item');
        if (!item) return;
        const idx = playlistItems.indexOf(item);
        if (idx !== -1) loadTrackByIndex(idx, true);
    });

    // Controls
    document.getElementById('mainPlayBtn')?.addEventListener('click', () => {
        if (videoElement.paused) videoElement.play();
        else videoElement.pause();
    });
    document.getElementById('rev10sBtn')?.addEventListener('click', () => { videoElement.currentTime -= 10; });
    document.getElementById('fwd10sBtn')?.addEventListener('click', () => { videoElement.currentTime += 10; });
    document.getElementById('prevTrackBtn')?.addEventListener('click', () => {
        if (currentTrackIndex > 0) loadTrackByIndex(currentTrackIndex - 1, true);
    });
    document.getElementById('nextTrackBtn')?.addEventListener('click', () => {
        if (currentTrackIndex + 1 < playlistItems.length) loadTrackByIndex(currentTrackIndex + 1, true);
    });

    // Modal Add
    const modal = document.getElementById('addVideoModal');
    document.getElementById('openAddModalBtn')?.addEventListener('click', () => modal.style.display = 'flex');
    document.getElementById('cancelAddBtn')?.addEventListener('click', () => modal.style.display = 'none');
    document.getElementById('submitAddBtn')?.addEventListener('click', () => {
        const input_url = document.getElementById('newInputUrl').value.trim();
        const out_url = document.getElementById('newOutUrl').value.trim();
        const title = document.getElementById('newTitle').value.trim();
        const playlist = document.getElementById('newPlaylist').value.trim();

        fetch('/mm/api/x/video/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input_url, out_url, title, playlist })
        }).then(r => r.json()).then(res => {
            if (res.success) window.location.reload();
            else alert(res.error || 'Failed to add');
        });
    });
});
// Bulk text file upload handler
document.addEventListener('DOMContentLoaded', () => {
    const uploadInput = document.getElementById('bulkUploadInput');
    const openUploadBtn = document.getElementById('openUploadBtn');
    const container = document.getElementById('appContainer');

    if (openUploadBtn && uploadInput) {
        openUploadBtn.addEventListener('click', () => {
            uploadInput.click();
        });

        uploadInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const currentPlaylist = container?.getAttribute('data-playlist') || 'Default';
            const formData = new FormData();
            formData.append('file', file);
            formData.append('playlist', currentPlaylist);

            openUploadBtn.textContent = '⏳';
            openUploadBtn.disabled = true;

            fetch('/mm/api/x/video/upload', {
                method: 'POST',
                body: formData
            })
            .then(r => r.json())
            .then(res => {
                if (res.success) {
                    alert(`✅ Bulk upload complete!\n• Added: ${res.added} new links\n• Skipped: ${res.duplicates} duplicates`);
                    window.location.reload();
                } else {
                    alert(res.error || 'Upload failed.');
                    openUploadBtn.textContent = '📁+';
                    openUploadBtn.disabled = false;
                }
            })
            .catch(err => {
                console.warn('Upload error:', err);
                alert('Server error during upload.');
                openUploadBtn.textContent = '📁+';
                openUploadBtn.disabled = false;
            });

            // Reset file input value so the same file can be selected again if needed
            uploadInput.value = '';
        });
    }
});
function loadTrackByIndex(index, autoPlay = true) {
    playlistItems = Array.from(document.querySelectorAll('.playlist-item'));
    if (index < 0 || index >= playlistItems.length) return;
    currentTrackIndex = index;
    const item = playlistItems[index];

    // THIS IS THE CRITICAL LINE: It grabs the output URL, not the input URL
    const outUrl = item.getAttribute('data-out-url');
    const videoElement = document.getElementById('main-hls-player');

    playlistItems.forEach(el => el.classList.remove('active'));
    item.classList.add('active');

    console.log("[Player] Loading output URL:", outUrl); // Check your browser console to verify

    if (Hls.isSupported()) {
        if (hlsPlayer) {
            hlsPlayer.destroy();
        }
        hlsPlayer = new Hls();
        hlsPlayer.loadSource(outUrl); // Loads the .m3u8 stream link
        hlsPlayer.attachMedia(videoElement);
        hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
            if (autoPlay) videoElement.play().catch(e => console.warn("Autoplay blocked:", e));
        });
        hlsPlayer.on(Hls.Events.ERROR, function (event, data) {
            console.error("HLS error details:", data);
        });
    } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
        // Native Safari HLS support
        videoElement.src = outUrl;
        if (autoPlay) videoElement.play().catch(e => console.warn("Autoplay blocked:", e));
    }
}