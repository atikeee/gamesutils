(() => {
    window.lucide?.createIcons();
    const root = document.querySelector('#remoteApp, #tvApp');
    if (!root || typeof io !== 'function') return;

    const socket = io();
    const mode = root.dataset.mode;

    function formatTime(value) {
        const seconds = Math.max(0, Math.floor(Number(value) || 0));
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainder = seconds % 60;
        return hours
            ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
            : `${minutes}:${String(remainder).padStart(2, '0')}`;
    }

    async function readJson(response) {
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`Server returned HTTP ${response.status}${response.status === 504 ? ' (gateway timeout)' : ''} instead of JSON. Check the NAS container logs.`);
        }
    }

    function parseChapters(value) {
        const values = String(value || '').trim().split(/[\s,]+/).map(token => {
            const parts = token.split(':');
            if (!token || parts.length > 3 || !parts.every(part => /^\d+(?:\.\d+)?$/.test(part))
                || !parts.slice(0, -1).every(part => /^\d+$/.test(part))) return null;
            const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
            return Number.isFinite(seconds) ? seconds : null;
        }).filter(value => value !== null && value >= 0);
        return [...new Set(values)].sort((first, second) => first - second);
    }

    if (mode === 'remote') initRemote();
    else initTv();

    function initRemote() {
        const databaseButton = document.getElementById('databaseButton');
        const playlistSelect = document.getElementById('playlistSelect');
        const categorySelect = document.getElementById('categorySelect');
        const searchInput = document.getElementById('mediaSearch');
        const tagFilters = document.getElementById('tagFilters');
        const mediaList = document.getElementById('mediaList');
        const currentMedia = document.getElementById('currentMedia');
        const remoteMessage = document.getElementById('remoteMessage');
        const togglePlayback = document.getElementById('togglePlayback');
        const seekSlider = document.getElementById('seekSlider');
        const timeDisplay = document.getElementById('timeDisplay');
        const volumeSlider = document.getElementById('volumeSlider');
        const audioOnlyToggle = document.getElementById('audioOnlyToggle');
        const previousPage = document.getElementById('previousPage');
        const nextPage = document.getElementById('nextPage');
        const pageIndicator = document.getElementById('pageIndicator');
        const pageNumbers = document.getElementById('pageNumbers');
        const editMediaButton = document.getElementById('editMediaBtn');
        const addChapterButton = document.getElementById('addChapter');
        let addingChapter = false;
        let items = [];
        let state = null;
        let selectedTags = new Set();
        let chapterLookupKey = '';
        let libraryRequest = 0;
        let page = 1;
        let pages = 1;
        let renderedPlayingKey = '';
        let mediaAccessToken = null;
        let selectedDatabase = 'youtube';
        let focusMediaId = null;
        let highlightMediaId = null;
        let resolveDatabasePin = null;
        let pendingView = null;
        let viewRestored = false;
        let viewReady = false;
        const lastMediaIds = {};
        const viewTimers = {};
        const databaseLabels = { youtube: 'YouTube', mov: 'Movie', vdo: 'VDO', x: 'X' };
        let unlockedDatabases = new Set(JSON.parse(root.dataset.unlocked || '["youtube"]'));

        const send = (action, data = {}) => {
            if (!socket.connected) {
                remoteMessage.textContent = 'Remote disconnected. Reconnecting...';
                return;
            }
            if (state?.media_id) {
                if (action === 'play') state.paused = 0;
                else if (action === 'pause') state.paused = 1;
                else if (action === 'seek') state.position = data.position;
                else if (action === 'volume') state.volume = data.volume;
                else if (action === 'audio_only') state.audio_only = Number(data.enabled);
                progressAt = Date.now();
                renderState(state);
            }
            socket.emit('media_control', {
                action, ...data, x_token: mediaAccessToken,
                ...(action === 'load' ? { queue: { playlist: playlistSelect.value, category: categorySelect.value, tags: [...selectedTags] } } : {})
            });
        };
        let progressAt = 0;

        const xPinDialog = document.getElementById('xPinDialog');
        const xPinForm = document.getElementById('xPinForm');
        const xPinInput = document.getElementById('remoteXPin');
        const xPinStatus = document.getElementById('xPinStatus');
        const xPinSubmit = document.getElementById('xPinSubmit');
        const xPinCancel = document.getElementById('xPinCancel');
        const unlockedChoices = document.getElementById('unlockedDatabases');
        function finishDatabaseChoice(result) {
            unlockedDatabases.add(result.database);
            const resolve = resolveDatabasePin;
            resolveDatabasePin = null;
            if (resolve) resolve(result);
            xPinDialog.close();
        }
        function askDatabasePin() {
            xPinStatus.textContent = '';
            xPinInput.value = '';
            unlockedChoices.replaceChildren(...[...unlockedDatabases].filter(database => database !== selectedDatabase).map(database => {
                const button = document.createElement('button');
                button.type = 'button';
                button.dataset.database = database;
                button.textContent = databaseLabels[database] || database;
                return button;
            }));
            xPinDialog.showModal();
            xPinInput.focus();
            return new Promise(resolve => { resolveDatabasePin = resolve; });
        }
        unlockedChoices.addEventListener('click', async event => {
            const button = event.target.closest('[data-database]');
            if (!button) return;
            xPinStatus.textContent = 'Switching...';
            try {
                const response = await fetch('/mm/api/remote/database', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ database: button.dataset.database })
                });
                const result = await response.json();
                if (!response.ok || !result.success) {
                    unlockedDatabases.delete(button.dataset.database);
                    button.remove();
                    throw new Error(result.error || 'Enter the PIN for this database.');
                }
                finishDatabaseChoice(result);
            } catch (error) {
                xPinStatus.textContent = error.message || 'Could not switch database.';
            }
        });
        xPinCancel.addEventListener('click', () => xPinDialog.close());
        xPinDialog.addEventListener('cancel', event => {
            if (xPinSubmit.disabled) event.preventDefault();
        });
        xPinDialog.addEventListener('close', () => {
            xPinInput.value = '';
            if (resolveDatabasePin) resolveDatabasePin(null);
            resolveDatabasePin = null;
        });
        xPinForm.addEventListener('submit', async event => {
            event.preventDefault();
            xPinSubmit.disabled = true;
            xPinCancel.disabled = true;
            xPinStatus.textContent = 'Checking PIN...';
            try {
                const response = await fetch('/mm/api/remote/database', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin: xPinInput.value })
                });
                const result = await response.json();
                if (!response.ok || !result.success) throw new Error(result.error || 'Incorrect PIN.');
                finishDatabaseChoice(result);
            } catch (error) {
                xPinStatus.textContent = error.message || 'PIN check failed.';
            } finally {
                xPinSubmit.disabled = false;
                xPinCancel.disabled = false;
            }
        });

        const startTvButton = document.getElementById('startTvBtn');
        startTvButton.addEventListener('click', async () => {
            if (startTvButton.disabled) return;
            startTvButton.disabled = true;
            remoteMessage.textContent = 'Starting TV...';
            try {
                const response = await fetch('/mm/api/remote/tv/start', { method: 'POST' });
                const result = await readJson(response);
                if (!response.ok || !result.success) throw new Error(result.error || 'TV command failed.');
                const displayLink = document.createElement('a');
                displayLink.href = result.display_url;
                displayLink.textContent = 'TV display';
                displayLink.target = '_blank';
                displayLink.rel = 'noopener';
                remoteMessage.replaceChildren('TV wake command sent; FunHub launched. ', displayLink);
            } catch (error) {
                remoteMessage.textContent = error.message || 'TV connection failed.';
            } finally {
                startTvButton.disabled = false;
            }
        });

        function renderState(nextState) {
            state = ['x', 'mov'].includes(nextState?.database_name) && (!mediaAccessToken || selectedDatabase !== nextState.database_name) ? null : nextState;
            const hasMedia = Boolean(state?.media_id);
            currentMedia.textContent = hasMedia
                ? `${state.title} · ${state.database_name.toUpperCase()}`
                : 'Nothing playing';
            togglePlayback.disabled = !hasMedia;
            const isPaused = Boolean(state?.paused);
            togglePlayback.querySelector('.icon-play').hidden = !isPaused;
            togglePlayback.querySelector('.icon-pause').hidden = isPaused;
            togglePlayback.setAttribute('aria-label', isPaused ? 'Play' : 'Pause');
            togglePlayback.title = isPaused ? 'Play' : 'Pause';
            const duration = Math.max(0, Number(state?.duration) || 0);
            seekSlider.max = String(Math.max(duration, 1));
            seekSlider.disabled = !hasMedia || duration <= 0;
            if (document.activeElement !== seekSlider) {
                seekSlider.value = String(Math.min(Number(state?.position) || 0, duration || 1));
                timeDisplay.textContent = `${formatTime(state?.position)}${duration ? ` / ${formatTime(duration)}` : ''}`;
            }
            volumeSlider.disabled = !hasMedia;
            if (document.activeElement !== volumeSlider) {
                volumeSlider.value = String(Math.max(0, Math.min(100, Number(state?.volume ?? 100))));
            }
            audioOnlyToggle.disabled = !hasMedia;
            audioOnlyToggle.setAttribute('aria-pressed', String(Boolean(Number(state?.audio_only))));
            const chapters = parseChapters(state?.chapter || '');
            document.getElementById('previousTrack').disabled = !hasMedia;
            document.getElementById('nextTrack').disabled = !hasMedia;
            document.getElementById('previousChapter').disabled = !hasMedia || !chapters.length;
            document.getElementById('nextChapter').disabled = !hasMedia || !chapters.length;
            ['seekBack', 'seekBackMinute', 'seekForward', 'seekForwardMinute'].forEach(id => {
                document.getElementById(id).disabled = !hasMedia;
            });
            const playingKey = hasMedia ? `${state.database_name}:${state.media_id}` : '';
            editMediaButton.disabled = !hasMedia || state.database_name !== selectedDatabase;
            addChapterButton.disabled = addingChapter || !hasMedia || state.database_name !== selectedDatabase;
            if (hasMedia && state.database_name === selectedDatabase && lastMediaIds[selectedDatabase] !== state.media_id) {
                lastMediaIds[selectedDatabase] = state.media_id;
                saveView();
            }
            if (playingKey !== renderedPlayingKey) {
                renderedPlayingKey = playingKey;
                renderItems();
            }
            if (hasMedia) loadCurrentChapters();
        }

        let searchTimer = null;

        function saveView() {
            if (!viewReady) return;
            const database = selectedDatabase;
            const view = {
                playlist: playlistSelect.value, category: categorySelect.value, tags: [...selectedTags],
                search: searchInput.value.trim().slice(0, 200), page, media_id: lastMediaIds[database] ?? null
            };
            window.clearTimeout(viewTimers[database]);
            viewTimers[database] = window.setTimeout(() => {
                fetch(`/mm/api/remote/view/${encodeURIComponent(database)}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(view)
                }).catch(() => {});
            }, 400);
        }

        async function restoreView() {
            try {
                const response = await fetch(`/mm/api/remote/view/${encodeURIComponent(selectedDatabase)}`);
                const result = await response.json();
                const view = response.ok && result.success ? result.view : null;
                if (!view) return;
                pendingView = { playlist: view.playlist, category: view.category };
                searchInput.value = view.search || '';
                selectedTags = new Set(view.tags || []);
                page = view.page || 1;
                if (view.media_id) {
                    lastMediaIds[selectedDatabase] = view.media_id;
                    focusMediaId = view.media_id;
                }
            } catch (_error) {
                pendingView = null;
            }
        }

        function renderPageNumbers() {
            const numbers = new Set([1, pages]);
            for (let value = Math.max(1, page - 2); value <= Math.min(pages, page + 2); value++) numbers.add(value);
            const sorted = [...numbers].sort((first, second) => first - second);
            const children = [];
            sorted.forEach((value, index) => {
                if (index && value - sorted[index - 1] > 1) {
                    const gap = document.createElement('span');
                    gap.className = 'page-gap';
                    gap.textContent = '…';
                    children.push(gap);
                }
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'page-num';
                button.textContent = String(value);
                button.setAttribute('aria-label', `Page ${value}`);
                if (value === page) button.setAttribute('aria-current', 'page');
                button.addEventListener('click', () => {
                    if (value === page) return;
                    page = value;
                    loadLibrary();
                });
                children.push(button);
            });
            pageNumbers.replaceChildren(...children);
        }

        async function loadLibrary() {
            if (['x', 'mov'].includes(selectedDatabase) && !mediaAccessToken) return;
            const requestId = ++libraryRequest;
            const params = new URLSearchParams({ database: selectedDatabase });
            const view = pendingView;
            pendingView = null;
            const playlist = view ? view.playlist : playlistSelect.value;
            const category = view ? view.category : categorySelect.value;
            if (playlist) params.set('playlist', playlist);
            if (category) params.set('category', category);
            if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
            if (selectedTags.size) params.set('tags', [...selectedTags].join(','));
            if (focusMediaId) params.set('focus_id', String(focusMediaId));
            params.set('page', String(page));
            mediaList.innerHTML = '<div class="empty">Loading…</div>';
            try {
                const response = await fetch(`/mm/api/remote/library?${params}`);
                const result = await response.json();
                if (!response.ok || !result.success) throw new Error(result.error || 'Could not load media');
                if (requestId !== libraryRequest) return;
                playlistSelect.replaceChildren(...result.playlists.map(playlist => new Option(playlist, playlist)));
                playlistSelect.value = result.playlist;
                categorySelect.replaceChildren(new Option('All', ''), ...result.categories.map(category => new Option(category, category)));
                categorySelect.value = result.category;
                selectedTags = new Set(result.selected_tags || []);
                page = result.page;
                pages = result.pages;
                previousPage.disabled = page <= 1;
                nextPage.disabled = page >= pages;
                pageIndicator.textContent = `Page ${page} of ${pages} · ${result.total_items} items`;
                renderPageNumbers();
                renderTagFilters(result.tags || []);
                const focused = focusMediaId;
                if (focused) {
                    highlightMediaId = focused;
                    focusMediaId = null;
                }
                items = result.items;
                renderItems();
                if (focused) mediaList.querySelector('.media-item.added')?.scrollIntoView({ block: 'nearest' });
                viewReady = true;
                saveView();
                return true;
            } catch (error) {
                if (requestId !== libraryRequest) return;
                focusMediaId = null;
                mediaList.replaceChildren();
                remoteMessage.textContent = error.message;
                return false;
            }
        }

        function renderTagFilters(tags) {
            tagFilters.replaceChildren();
            const label = document.createElement('span');
            label.className = 'tag-label';
            label.textContent = 'Tags';
            tagFilters.append(label);
            if (!tags.length) {
                const empty = document.createElement('span');
                empty.className = 'tag-empty';
                empty.textContent = 'No tags';
                tagFilters.append(empty);
                return;
            }
            tags.forEach(tag => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `tag-chip${selectedTags.has(tag.name) ? ' selected' : ''}`;
                button.textContent = `${tag.name} (${tag.count})`;
                button.setAttribute('aria-pressed', String(selectedTags.has(tag.name)));
                button.addEventListener('click', () => {
                    if (selectedTags.has(tag.name)) selectedTags.delete(tag.name);
                    else selectedTags.add(tag.name);
                    page = 1;
                    loadLibrary();
                });
                tagFilters.append(button);
            });
        }

        async function loadCurrentChapters() {
            const key = `${state.database_name}:${state.media_id}`;
            if (chapterLookupKey === key || state.chapter) return;
            chapterLookupKey = key;
            const apiBase = state.database_name === 'youtube' ? '/mm/api/video' : `/mm/api/${state.database_name}`;
            try {
                const response = await fetch(`${apiBase}/${state.media_id}/chapters`, { method: 'POST' });
                const result = await response.json();
                if (!response.ok || !result.success || !state || key !== `${state.database_name}:${state.media_id}`) return;
                state.chapter = result.chapter || '';
                renderState(state);
            } catch (_error) {
                chapterLookupKey = '';
            }
        }

        function visibleItems() {
            return items;
        }

        function renderItems() {
            const visible = visibleItems();
            mediaList.replaceChildren();
            if (!visible.length) {
                const empty = document.createElement('div');
                empty.className = 'empty';
                empty.textContent = 'No media found';
                mediaList.append(empty);
                return;
            }
            visible.forEach(item => {
                const row = document.createElement('div');
                row.className = 'media-item';
                const playing = item.id === state?.media_id && selectedDatabase === state?.database_name;
                row.classList.toggle('playing', playing);
                row.classList.toggle('added', item.id === highlightMediaId);
                const main = document.createElement('button');
                main.type = 'button';
                main.className = 'media-main';
                main.setAttribute('aria-current', String(playing));
                const title = document.createElement('div');
                title.className = 'media-title';
                title.textContent = item.title || item.video_id;
                if (item.tags?.length) {
                    const tags = document.createElement('span');
                    tags.className = 'media-tags';
                    tags.textContent = item.tags.join(', ');
                    tags.setAttribute('aria-label', `Tags: ${tags.textContent}`);
                    title.append(' ', tags);
                }
                const subtitle = document.createElement('div');
                subtitle.className = 'media-subtitle';
                subtitle.textContent = [item.artist, item.category, item.duration ? formatTime(item.duration) : '']
                    .filter(Boolean).join(' · ');
                main.append(title, subtitle);
                main.addEventListener('click', () => {
                    remoteMessage.textContent = `Loading ${item.title || item.video_id}…`;
                    send('load', { database: selectedDatabase, media_id: item.id });
                });
                const fav = document.createElement('button');
                fav.type = 'button';
                fav.className = 'fav-btn';
                const renderFav = () => {
                    const liked = Boolean(item.fav);
                    fav.textContent = liked ? '♥' : '♡';
                    fav.setAttribute('aria-pressed', String(liked));
                    fav.setAttribute('aria-label', `${liked ? 'Unlike' : 'Like'} ${item.title || item.video_id}`);
                    fav.title = liked ? 'Unlike' : 'Like';
                };
                renderFav();
                fav.addEventListener('click', async () => {
                    const database = selectedDatabase;
                    fav.disabled = true;
                    try {
                        const response = await fetch(`/mm/api/remote/fav/${encodeURIComponent(database)}/${item.id}`, { method: 'POST' });
                        const result = await readJson(response);
                        if (!response.ok || !result.success) throw new Error(result.error || 'Could not update like.');
                        item.fav = result.fav;
                        renderFav();
                        if (database === selectedDatabase) loadLibrary();
                    } catch (error) {
                        remoteMessage.textContent = error.message || 'Could not update like.';
                    } finally {
                        fav.disabled = false;
                    }
                });
                row.append(main, fav);
                mediaList.append(row);
            });
        }

        async function navigateTrack(direction) {
            let visible = visibleItems();
            if (!visible.length) return;
            const currentIndex = visible.findIndex(item => item.id === state?.media_id && selectedDatabase === state?.database_name);
            if (currentIndex < 0) {
                const item = direction > 0 ? visible[0] : visible[visible.length - 1];
                send('load', { database: selectedDatabase, media_id: item.id });
                return;
            }

            const nextIndex = currentIndex + direction;
            if (nextIndex >= 0 && nextIndex < visible.length) {
                send('load', { database: selectedDatabase, media_id: visible[nextIndex].id });
                return;
            }
            if (direction < 0 && page <= 1) return;

            const pageCount = pages;
            for (let checkedPages = 0; checkedPages < pageCount; checkedPages++) {
                page = direction > 0 ? (page >= pages ? 1 : page + 1) : Math.max(1, page - 1);
                if (!await loadLibrary()) return;
                visible = visibleItems();
                if (!visible.length) continue;

                const item = direction > 0 ? visible[0] : visible[visible.length - 1];
                send('load', { database: selectedDatabase, media_id: item.id });
                return;
            }
        }

        function skipBy(seconds) {
            if (!state?.media_id) return;
            const duration = Number(state.duration) || Infinity;
            send('seek', { position: Math.max(0, Math.min(duration, Number(state.position || 0) + seconds)) });
        }

        function seekChapter(direction) {
            const chapters = parseChapters(state?.chapter || '');
            if (!chapters.length) return;
            const position = Number(state.position) || 0;
            const target = direction > 0
                ? chapters.find(seconds => seconds > position + 1)
                : chapters.filter(seconds => seconds < position - 2).at(-1);
            if (target !== undefined) send('seek', { position: target });
        }

        databaseButton.addEventListener('click', async () => {
            databaseButton.disabled = true;
            let choice;
            try {
                choice = await askDatabasePin();
            } finally {
                databaseButton.disabled = false;
            }
            if (!choice) return;
            selectedDatabase = choice.database;
            viewReady = false;
            mediaAccessToken = choice.access_token || null;
            databaseButton.querySelector('span').textContent = { youtube: 'YouTube', mov: 'Movie', vdo: 'VDO', x: 'X' }[selectedDatabase];
            highlightMediaId = null;
            focusMediaId = null;
            libraryRequest++;
            playlistSelect.replaceChildren();
            categorySelect.replaceChildren();
            items = [];
            renderItems();
            selectedTags.clear();
            page = 1;
            searchInput.value = '';
            chapterLookupKey = '';
            socket.emit('media_join');
            await restoreView();
            loadLibrary();
        });
        playlistSelect.addEventListener('change', () => { selectedTags.clear(); page = 1; loadLibrary(); });
        categorySelect.addEventListener('change', () => { selectedTags.clear(); page = 1; loadLibrary(); });

        const editMediaDialog = document.getElementById('editMediaDialog');
        const editMediaForm = document.getElementById('editMediaForm');
        const editMediaStatus = document.getElementById('editMediaStatus');
        const editMediaSubmit = document.getElementById('editMediaSubmit');
        const editMediaCancel = document.getElementById('editMediaCancel');
        const editFields = {
            title: document.getElementById('editTitle'), artist: document.getElementById('editArtist'),
            playlist: document.getElementById('editPlaylist'), category: document.getElementById('editCategory'),
            tags: document.getElementById('editTags'), duration: document.getElementById('editDuration'),
            chapter: document.getElementById('editChapter'), thumbnail_url: document.getElementById('editThumbnail'),
            url: document.getElementById('editUrl')
        };
        let editTarget = null;
        let savingEdit = false;
        editMediaButton.addEventListener('click', async () => {
            if (!state?.media_id || state.database_name !== selectedDatabase) return;
            const target = { database: state.database_name, id: state.media_id };
            editMediaButton.disabled = true;
            try {
                const response = await fetch(`/mm/api/remote/media/${encodeURIComponent(target.database)}/${target.id}`);
                const result = await readJson(response);
                if (!response.ok || !result.success) throw new Error(result.error || 'Could not load the entry.');
                const media = result.media;
                editTarget = target;
                editMediaStatus.textContent = '';
                editFields.title.value = media.title || '';
                editFields.artist.value = media.artist || '';
                editFields.playlist.value = media.playlist || '';
                editFields.category.value = media.category || '';
                editFields.tags.value = (media.tags || []).join(', ');
                editFields.duration.value = String(media.duration || 0);
                editFields.chapter.value = media.chapter || '';
                editFields.thumbnail_url.value = media.thumbnail_url || '';
                editFields.url.value = media.url || '';
                document.getElementById('editUrlLabel').hidden = !result.local;
                document.getElementById('editMediaSource').textContent = result.local
                    ? `${databaseLabels[target.database] || target.database} entry #${media.id}`
                    : `YouTube video ${media.video_id}`;
                document.getElementById('editPlaylists').replaceChildren(...Array.from(playlistSelect.options, option => new Option(option.value)));
                document.getElementById('editCategories').replaceChildren(...Array.from(categorySelect.options).filter(option => option.value).map(option => new Option(option.value)));
                editMediaDialog.showModal();
                editFields.title.focus();
            } catch (error) {
                remoteMessage.textContent = error.message || 'Could not load the entry.';
            } finally {
                renderState(state);
            }
        });
        editMediaCancel.addEventListener('click', () => editMediaDialog.close());
        editMediaDialog.addEventListener('cancel', event => { if (savingEdit) event.preventDefault(); });
        editMediaForm.addEventListener('submit', async event => {
            event.preventDefault();
            if (savingEdit || !editTarget) return;
            const duration = Number(editFields.duration.value || 0);
            if (!Number.isInteger(duration) || duration < 0) {
                editMediaStatus.textContent = 'Duration must be a whole number of seconds.';
                return;
            }
            savingEdit = true;
            editMediaSubmit.disabled = true;
            editMediaCancel.disabled = true;
            editMediaStatus.textContent = 'Saving…';
            try {
                const response = await fetch(`/mm/api/remote/media/${encodeURIComponent(editTarget.database)}/${editTarget.id}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: editFields.title.value, artist: editFields.artist.value,
                        playlist: editFields.playlist.value, category: editFields.category.value,
                        tags: editFields.tags.value.split(',').map(tag => tag.trim()).filter(Boolean),
                        duration, chapter: editFields.chapter.value,
                        thumbnail_url: editFields.thumbnail_url.value, url: editFields.url.value
                    })
                });
                const result = await readJson(response);
                if (!response.ok || !result.success) throw new Error(result.error || 'Could not save the entry.');
                editMediaDialog.close();
                remoteMessage.textContent = 'Entry saved.';
                if (editTarget.database === selectedDatabase) loadLibrary();
            } catch (error) {
                editMediaStatus.textContent = error.message || 'Could not save the entry.';
            } finally {
                savingEdit = false;
                editMediaSubmit.disabled = false;
                editMediaCancel.disabled = false;
            }
        });
        searchInput.addEventListener('input', () => {
            window.clearTimeout(searchTimer);
            ++libraryRequest;
            page = 1;
            focusMediaId = null;
            searchTimer = window.setTimeout(loadLibrary, 150);
        });
        previousPage.addEventListener('click', () => { page = Math.max(1, page - 1); loadLibrary(); });
        nextPage.addEventListener('click', () => { page = Math.min(pages, page + 1); loadLibrary(); });
        togglePlayback.addEventListener('click', () => send(state?.paused ? 'play' : 'pause'));
        addChapterButton.addEventListener('click', async () => {
            if (addingChapter || !state?.media_id || state.database_name !== selectedDatabase) return;
            addingChapter = true;
            addChapterButton.disabled = true;
            try {
                const response = await fetch('/mm/api/remote/chapter', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ database: state.database_name, media_id: state.media_id, position: Number(state.position) || 0 })
                });
                const result = await readJson(response);
                if (!response.ok || !result.success) throw new Error(result.error || 'Could not add the chapter.');
                remoteMessage.textContent = result.added
                    ? `Chapter added at ${formatTime(result.position)}.`
                    : `Skipped: a chapter already exists at ${formatTime(result.nearby)} (within 5 seconds).`;
            } catch (error) {
                remoteMessage.textContent = error.message || 'Could not add the chapter.';
            } finally {
                addingChapter = false;
                renderState(state);
            }
        });
        document.getElementById('previousTrack').addEventListener('click', () => navigateTrack(-1));
        document.getElementById('nextTrack').addEventListener('click', () => navigateTrack(1));
        document.getElementById('previousChapter').addEventListener('click', () => seekChapter(-1));
        document.getElementById('nextChapter').addEventListener('click', () => seekChapter(1));
        document.getElementById('seekBack').addEventListener('click', () => skipBy(-10));
        document.getElementById('seekBackMinute').addEventListener('click', () => skipBy(-60));
        document.getElementById('seekForward').addEventListener('click', () => skipBy(10));
        document.getElementById('seekForwardMinute').addEventListener('click', () => skipBy(60));
        seekSlider.addEventListener('input', () => {
            timeDisplay.textContent = `${formatTime(seekSlider.value)} / ${formatTime(state?.duration)}`;
        });
        seekSlider.addEventListener('change', () => send('seek', { position: Number(seekSlider.value) }));
        let volumeTimer = null;
        const sendVolume = () => {
            window.clearTimeout(volumeTimer);
            volumeTimer = null;
            send('volume', { volume: Number(volumeSlider.value) });
        };
        volumeSlider.addEventListener('input', () => {
            if (volumeTimer === null) volumeTimer = window.setTimeout(sendVolume, 100);
        });
        volumeSlider.addEventListener('change', sendVolume);
        audioOnlyToggle.addEventListener('click', () => send('audio_only', { enabled: audioOnlyToggle.getAttribute('aria-pressed') !== 'true' }));

        socket.on('connect', async () => {
            socket.emit('media_join');
            if (!viewRestored) {
                viewRestored = true;
                await restoreView();
            }
            loadLibrary();
        });
        socket.on('media_state', payload => {
            if (payload.command === 'load') {
                chapterLookupKey = '';
            }
            progressAt = Date.now();
            renderState(payload.state || payload);
            if (payload.command !== 'metadata') remoteMessage.textContent = '';
        });
        socket.on('media_progress', progress => {
            if (!state || progress.revision !== state.revision) return;
            state.position = progress.position;
            state.paused = progress.paused;
            if (progress.duration > 0) state.duration = progress.duration;
            progressAt = Date.now();
            renderState(state);
        });
        // Advance the displayed time between TV progress reports.
        window.setInterval(() => {
            if (!state?.media_id || state.paused || !progressAt || document.activeElement === seekSlider) return;
            const duration = Number(state.duration) || Infinity;
            const now = Date.now();
            state.position = Math.min(duration, (Number(state.position) || 0) + (now - progressAt) / 1000);
            progressAt = now;
            seekSlider.value = String(Math.min(state.position, Number(seekSlider.max)));
            timeDisplay.textContent = `${formatTime(state.position)}${Number(state.duration) ? ` / ${formatTime(state.duration)}` : ''}`;
        }, 1000);
        socket.on('media_error', result => { remoteMessage.textContent = result.error || 'Playback command failed'; });
    }

    function initTv() {
        const stage = document.getElementById('playerStage');
        let youtubeHost = document.getElementById('tvYoutubePlayer');
        const localPlayer = document.getElementById('tvLocalPlayer');
        const status = document.getElementById('tvStatus');
        const audioOverlay = document.getElementById('tvAudioOverlay');
        const audioTitle = document.getElementById('tvAudioTitle');
        let youtubePlayer = null;
        let youtubeReady = false;
        let youtubeApiRequested = false;
        let pendingYoutube = null;
        let pendingLocal = null;
        let activeKey = '';
        let activeSource = '';
        let currentState = null;
        let statusTimer = null;

        function setStatus(message, duration = 0) {
            window.clearTimeout(statusTimer);
            statusTimer = null;
            status.textContent = message || '';
            if (message && duration > 0) {
                statusTimer = window.setTimeout(() => {
                    status.textContent = '';
                    statusTimer = null;
                }, duration);
            }
        }

        function ensureYoutubeHost() {
            youtubeHost = document.getElementById('tvYoutubePlayer');
            if (!youtubeHost) {
                youtubeHost = document.createElement('div');
                youtubeHost.id = 'tvYoutubePlayer';
                stage.prepend(youtubeHost);
            }
            return youtubeHost;
        }

        function destroyYoutubePlayer() {
            pendingYoutube = null;
            const player = youtubePlayer;
            youtubePlayer = null;
            youtubeReady = false;
            if (player) {
                try { player.pauseVideo(); } catch (_error) {}
                try { player.stopVideo(); } catch (_error) {}
                try { player.destroy(); } catch (_error) {}
            }
            document.getElementById('tvYoutubePlayer')?.remove();
            youtubeHost = null;
        }

        function clearLocalPlayer() {
            pendingLocal = null;
            localPlayer.pause();
            localPlayer.removeAttribute('src');
            localPlayer.dataset.sourceUrl = '';
            localPlayer.load();
            localPlayer.hidden = true;
        }

        function setAudioOnly(state) {
            const enabled = Boolean(Number(state?.audio_only));
            stage.classList.toggle('audio-only', enabled);
            audioOverlay.hidden = !enabled;
            audioTitle.textContent = state?.title || '';
        }

        function ensureYoutubeApi() {
            ensureYoutubeHost();
            youtubeHost.hidden = false;
            if (window.YT?.Player) {
                createYoutubePlayer();
                return;
            }
            if (youtubeApiRequested) return;
            youtubeApiRequested = true;
            window.onYouTubeIframeAPIReady = createYoutubePlayer;
            const script = document.createElement('script');
            script.src = 'https://www.youtube.com/iframe_api';
            document.head.append(script);
        }

        function createYoutubePlayer() {
            if (youtubePlayer || !window.YT?.Player || (currentState && currentState.database_name !== 'youtube')) return;
            ensureYoutubeHost();
            youtubePlayer = new YT.Player('tvYoutubePlayer', {
                playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 0, modestbranding: 1, playsinline: 1, rel: 0 },
                events: {
                    onReady: event => {
                        if (event.target !== youtubePlayer) {
                            event.target.destroy();
                            return;
                        }
                        const iframe = event.target.getIframe();
                        iframe.setAttribute('tabindex', '-1');
                        iframe.blur();
                        youtubeReady = true;
                        if (pendingYoutube) {
                            const pending = pendingYoutube;
                            pendingYoutube = null;
                            applyYoutubeState(pending.state, pending.command, pending.changed);
                        }
                    },
                    onStateChange: event => {
                        if (event.data === YT.PlayerState.ENDED && currentState?.media_id) {
                            socket.emit('media_ended', { revision: currentState.revision });
                        }
                    },
                    onError: event => setStatus(`YouTube playback error (${event.data})`)
                }
            });
        }

        function applyYoutubeState(state, command, changed) {
            if (!youtubePlayer || !youtubeReady) {
                pendingYoutube = { state, command, changed };
                return;
            }
            youtubePlayer.setVolume(Number(state.volume ?? 100));
            if (changed) {
                const video = { videoId: state.video_id, startSeconds: Number(state.position) || 0 };
                if (state.paused) youtubePlayer.cueVideoById(video);
                else youtubePlayer.loadVideoById(video);
            } else if (command === 'play') youtubePlayer.playVideo();
            else if (command === 'pause') youtubePlayer.pauseVideo();
            else if (command === 'seek') youtubePlayer.seekTo(Number(state.position) || 0, true);
            else if (command === 'volume') youtubePlayer.setVolume(Number(state.volume ?? 100));
            else if (command === 'audio_only') return;
            else {
                if (state.paused) youtubePlayer.pauseVideo();
                else youtubePlayer.playVideo();
            }
        }

        function applyLocalState(state, command) {
            if (localPlayer.readyState < 1) {
                pendingLocal = { state, command };
                return;
            }
            // Stored position lags up to one progress report; re-seeking on a reconnect "sync" replays those seconds.
            if (command === 'load' || command === 'seek') {
                localPlayer.currentTime = Math.min(Number(state.position) || 0,
                    Number.isFinite(localPlayer.duration) ? localPlayer.duration : Infinity);
            }
            localPlayer.volume = Math.max(0, Math.min(1, Number(state.volume ?? 100) / 100));
            if (state.paused) localPlayer.pause();
            else if (localPlayer.paused) localPlayer.play().catch(error => {
                if (error.name === 'AbortError' || currentState?.revision !== state.revision
                    || currentState?.paused || !localPlayer.paused) return;
                console.warn('[TV playback]', error);
            });
        }

        function applyState(payload) {
            const state = payload.state || payload;
            const command = payload.command || 'sync';
            currentState = state;
            if (!state.media_id) {
                destroyYoutubePlayer();
                clearLocalPlayer();
                setAudioOnly(null);
                activeSource = '';
                activeKey = '';
                setStatus('Waiting for media selection');
                return;
            }

            const key = `${state.database_name}:${state.media_id}`;
            const changed = key !== activeKey;
            activeKey = key;
            if (changed || command === 'load' || command === 'sync') {
                setStatus(state.title || '', 3000);
            }
            setAudioOnly(state);

            if (state.database_name === 'youtube') {
                if (activeSource === 'local' || localPlayer.dataset.sourceUrl) clearLocalPlayer();
                localPlayer.hidden = true;
                activeSource = 'youtube';
                ensureYoutubeApi();
                applyYoutubeState(state, command, changed || command === 'load');
                return;
            }

            if (activeSource === 'youtube' || youtubePlayer || youtubeHost) destroyYoutubePlayer();
            activeSource = 'local';
            localPlayer.hidden = false;
            const sourceUrl = ['x', 'mov'].includes(state.database_name) && !changed && command !== 'load' && localPlayer.dataset.sourceUrl
                ? localPlayer.dataset.sourceUrl
                : state.stream_url || `/mm/api/${encodeURIComponent(state.database_name)}/stream/${state.media_id}`;
            if (changed || localPlayer.dataset.sourceUrl !== sourceUrl) {
                localPlayer.pause();
                localPlayer.dataset.sourceUrl = sourceUrl;
                localPlayer.src = sourceUrl;
                localPlayer.load();
                pendingLocal = { state, command: 'load' };
            } else {
                applyLocalState(state, command);
            }
        }

        localPlayer.addEventListener('loadedmetadata', () => {
            if (!pendingLocal || !currentState || pendingLocal.state.revision !== currentState.revision) return;
            const pending = pendingLocal;
            pendingLocal = null;
            applyLocalState(pending.state, pending.command);
        });
        localPlayer.addEventListener('ended', () => {
            if (currentState?.media_id) {
                socket.emit('media_ended', { revision: currentState.revision });
            }
        });
        socket.on('connect', () => {
            setStatus('Waiting for media selection');
            socket.emit('media_join');
        });
        socket.on('media_state', applyState);
        socket.on('media_error', result => setStatus(result.error || 'Playback error'));
        window.setInterval(() => {
            if (!currentState?.media_id) return;
            let position = 0;
            let paused = true;
            let duration = Number(currentState.duration) || 0;
            if (currentState.database_name === 'youtube' && youtubePlayer?.getCurrentTime) {
                position = youtubePlayer.getCurrentTime();
                paused = youtubePlayer.getPlayerState() !== YT.PlayerState.PLAYING;
                duration = youtubePlayer.getDuration() || duration;
            } else if (currentState.database_name !== 'youtube') {
                position = localPlayer.currentTime || 0;
                paused = localPlayer.paused;
                duration = localPlayer.duration || duration;
            }
            socket.emit('media_progress', { position, paused, duration, revision: currentState.revision });
        }, 2000);
    }
})();