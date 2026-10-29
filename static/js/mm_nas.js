const isPrivate = window.location.pathname.includes('/mm/nas/x');
const queryParam = isPrivate ? '?private=1' : '';
let currentTrackIndex = 0;
let playlistItems = [];

document.addEventListener('DOMContentLoaded', () => {
    playlistItems = Array.from(document.querySelectorAll('.playlist-item'));
    const videoElem = document.getElementById('nasVideoPlayer');

    if (playlistItems.length > 0 && videoElem) {
        loadTrackByIndex(0, false);
    }

    // Playlist filter change
    document.getElementById('playlistFilterSelect')?.addEventListener('change', (e) => {
        const url = new URL(window.location.href);
        url.searchParams.set('playlist', e.target.value);
        url.searchParams.delete('category');
        url.searchParams.delete('tags');
        url.searchParams.set('page', '1');
        window.location.href = url.toString();
    });

    // Category filter change
    document.getElementById('categoryFilterSelect')?.addEventListener('change', (e) => {
        const url = new URL(window.location.href);
        if (e.target.value) {
            url.searchParams.set('category', e.target.value);
        } else {
            url.searchParams.delete('category');
        }
        url.searchParams.delete('tags');
        url.searchParams.set('page', '1');
        window.location.href = url.toString();
    });

    // Scan Modal event bindings
    const scanModal = document.getElementById('scanModal');
    document.getElementById('openScanModalBtn')?.addEventListener('click', () => {
        if (scanModal) scanModal.style.display = 'flex';
    });
    document.getElementById('cancelScanBtn')?.addEventListener('click', () => {
        if (scanModal) scanModal.style.display = 'none';
    });
    document.getElementById('submitScanBtn')?.addEventListener('click', () => {
        const path = document.getElementById('scanPathInput').value.trim();
        const playlist = document.getElementById('scanPlaylistInput').value.trim();
        const category = document.getElementById('scanCategoryInput').value.trim();
        if (!path) return alert('Enter a valid directory path.');

        fetch(`/mm/api/nas/scan${queryParam}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, playlist, category })
        })
        .then(r => r.json())
        .then(res => {
            if (res.success) {
                alert(`Successfully added ${res.added} new videos!`);
                window.location.reload();
            } else {
                alert(res.error || 'Scan failed.');
            }
        })
        .catch(err => {
            alert('Scan error: ' + err);
        });
    });

    // Item click in sidebar (User gesture triggers play immediately)
    document.getElementById('playlistList')?.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item');
        if (!item) return;
        const idx = playlistItems.indexOf(item);
        if (idx !== -1) loadTrackByIndex(idx, true);
    });

    // Player jump controls (-60s / +60s)
    document.getElementById('rev60sBtn')?.addEventListener('click', () => {
        if (videoElem) videoElem.currentTime = Math.max(0, videoElem.currentTime - 60);
    });
    document.getElementById('fwd60sBtn')?.addEventListener('click', () => {
        if (videoElem) videoElem.currentTime = Math.min(videoElem.duration || 0, videoElem.currentTime + 60);
    });
    document.getElementById('mainPlayBtn')?.addEventListener('click', () => {
        if (videoElem.paused) videoElem.play();
        else videoElem.pause();
    });
    document.getElementById('prevTrackBtn')?.addEventListener('click', () => {
        if (currentTrackIndex > 0) loadTrackByIndex(currentTrackIndex - 1, true);
    });
    document.getElementById('nextTrackBtn')?.addEventListener('click', () => {
        if (currentTrackIndex + 1 < playlistItems.length) loadTrackByIndex(currentTrackIndex + 1, true);
    });
    videoElem?.addEventListener('ended', () => {
        if (currentTrackIndex + 1 < playlistItems.length) loadTrackByIndex(currentTrackIndex + 1, true);
    });

    // Tag input handler (Press Enter to add tag)
    document.getElementById('newTagInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const val = e.target.value.trim();
            if (!val) return;
            const bar = document.getElementById('activeVideoMetaBar');
            const vidId = bar.getAttribute('data-id');
            const playlist = bar.getAttribute('data-playlist');
            const category = bar.getAttribute('data-category');
            let currentTags = JSON.parse(bar.getAttribute('data-tags') || '[]');
            if (!currentTags.includes(val)) {
                currentTags.push(val);
                updateVideoMetadata(vidId, playlist, category, currentTags, () => {
                    e.target.value = '';
                    renderBottomMeta(playlist, category, currentTags);
                });
            }
        }
    });
});

function loadTrackByIndex(index, autoPlay = true) {
    playlistItems = Array.from(document.querySelectorAll('.playlist-item'));
    if (index < 0 || index >= playlistItems.length) return;
    currentTrackIndex = index;
    const item = playlistItems[index];

    playlistItems.forEach(el => el.classList.remove('active'));
    item.classList.add('active');

    const vidId = item.getAttribute('data-id');
    const playlist = item.getAttribute('data-playlist');
    const category = item.getAttribute('data-category');
    const tags = JSON.parse(item.getAttribute('data-tags') || '[]');

    const bar = document.getElementById('activeVideoMetaBar');
    bar.setAttribute('data-id', vidId);
    bar.setAttribute('data-playlist', playlist);
    bar.setAttribute('data-category', category);
    bar.setAttribute('data-tags', JSON.stringify(tags));

    renderBottomMeta(playlist, category, tags);

    const videoElem = document.getElementById('nasVideoPlayer');
    videoElem.src = `/mm/api/nas/stream/${vidId}${queryParam}`;
    videoElem.load(); // Force reload stream source
    
    if (autoPlay) {
        videoElem.play().catch(err => console.warn("Autoplay blocked by browser policy:", err));
    }
}

function renderBottomMeta(playlist, category, tags) {
    // 1. Playlist Pill & Editor
    const plContainer = document.getElementById('playlistPillsContainer');
    plContainer.innerHTML = `<span class="playlist-pill" id="editablePlaylistPill" title="Click to edit playlist">${playlist}</span>`;
    
    document.getElementById('editablePlaylistPill').addEventListener('click', function() {
        const wrapper = document.createElement('div');
        wrapper.style.display = 'flex';
        wrapper.style.gap = '5px';

        const select = document.createElement('select');
        select.className = 'inline-edit-select';
        ALL_PLAYLISTS.forEach(pl => {
            const opt = document.createElement('option');
            opt.value = pl;
            opt.textContent = pl;
            if (pl === playlist) opt.selected = true;
            select.appendChild(opt);
        });

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-edit-input';
        input.placeholder = 'Or new name...';
        input.value = playlist;

        wrapper.appendChild(select);
        wrapper.appendChild(input);
        this.replaceWith(wrapper);
        input.focus();

        const saveChanges = () => {
            const newPl = input.value.trim() || select.value;
            savePlaylistAndCategoryChange(newPl, category);
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveChanges();
        });
        select.addEventListener('change', () => {
            input.value = select.value;
        });
        input.addEventListener('blur', () => {
            setTimeout(saveChanges, 200);
        });
    });

    // 2. Category Pill & Editor
    const catContainer = document.getElementById('categoryPillsContainer');
    const catDisplay = category || '(None)';
    catContainer.innerHTML = `<span class="category-pill" id="editableCategoryPill" title="Click to edit category">${catDisplay}</span>`;

    document.getElementById('editableCategoryPill').addEventListener('click', function() {
        const wrapper = document.createElement('div');
        wrapper.style.display = 'flex';
        wrapper.style.gap = '5px';

        const select = document.createElement('select');
        select.className = 'inline-edit-select';
        
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '(None)';
        select.appendChild(emptyOpt);

        ALL_CATEGORIES.forEach(cat => {
            if (cat) {
                const opt = document.createElement('option');
                opt.value = cat;
                opt.textContent = cat;
                if (cat === category) opt.selected = true;
                select.appendChild(opt);
            }
        });

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-edit-input';
        input.placeholder = 'Or new category...';
        input.value = category;

        wrapper.appendChild(select);
        wrapper.appendChild(input);
        this.replaceWith(wrapper);
        input.focus();

        const saveChanges = () => {
            const newCat = input.value.trim();
            savePlaylistAndCategoryChange(playlist, newCat);
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveChanges();
        });
        select.addEventListener('change', () => {
            input.value = select.value;
        });
        input.addEventListener('blur', () => {
            setTimeout(saveChanges, 200);
        });
    });

    // 3. Tags Container
    const tagsContainer = document.getElementById('tagsPillsContainer');
    const inputElem = document.getElementById('newTagInput');
    tagsContainer.innerHTML = '';
    
    tags.forEach(tag => {
        const pill = document.createElement('span');
        pill.className = 'tag-pill';
        pill.innerHTML = `${tag} <span class="tag-remove" data-tag="${tag}">&times;</span>`;
        tagsContainer.appendChild(pill);
    });
    tagsContainer.appendChild(inputElem);

    // Bind remove tag events
    tagsContainer.querySelectorAll('.tag-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tagToRemove = e.target.getAttribute('data-tag');
            const bar = document.getElementById('activeVideoMetaBar');
            const vidId = bar.getAttribute('data-id');
            let currentTags = JSON.parse(bar.getAttribute('data-tags') || '[]');
            currentTags = currentTags.filter(t => t !== tagToRemove);
            
            updateVideoMetadata(vidId, playlist, category, currentTags, () => {
                renderBottomMeta(playlist, category, currentTags);
            });
        });
    });
}

function savePlaylistAndCategoryChange(newPlaylist, newCategory) {
    const bar = document.getElementById('activeVideoMetaBar');
    const vidId = bar.getAttribute('data-id');
    const currentTags = JSON.parse(bar.getAttribute('data-tags') || '[]');
    
    updateVideoMetadata(vidId, newPlaylist, newCategory, currentTags, () => {
        bar.setAttribute('data-playlist', newPlaylist);
        bar.setAttribute('data-category', newCategory);
        renderBottomMeta(newPlaylist, newCategory, currentTags);
    });
}

function updateVideoMetadata(vidId, playlist, category, tags, onSuccess) {
    fetch(`/mm/api/nas/update/${vidId}${queryParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playlist, category, tags })
    })
    .then(r => r.json())
    .then(res => {
        if (res.success) {
            const item = document.querySelector(`.playlist-item[data-id="${vidId}"]`);
            if (item) {
                item.setAttribute('data-playlist', playlist);
                item.setAttribute('data-category', category);
                item.setAttribute('data-tags', JSON.stringify(tags));
            }
            if (typeof onSuccess === 'function') onSuccess();
        } else {
            alert(res.error || 'Update failed.');
        }
    });
}