// /mm/mp3/populate — folder scan, inline/batch edit, CSV import/export, save to mp3 DB

let allRecords = [];
let filteredRecords = [];
const selectedIndexes = new Set();
let currentPage = 1;
const pageSize = 100;

const $ = (id) => document.getElementById(id);
const EDIT_FIELDS = ['title', 'artist', 'album', 'category', 'playlist', 'tag_list'];
const FILTERS = { title: 'fltTitle', artist: 'fltArtist', album: 'fltAlbum', category: 'fltCategory', playlist: 'fltPlaylist', tag_list: 'fltTags', path: 'fltPath' };
const BATCH = { title: 'batchTitle', artist: 'batchArtist', album: 'batchAlbum', category: 'batchCategory', playlist: 'batchPlaylist', tag_list: 'batchTags' };

// 1. Directory Navigation
let parentPath = null;

async function loadDir(path = '') {
    const res = await fetch(`/mm/api/fs/browse?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (data.error) return alert(data.error);

    $('currentPath').value = data.current;
    parentPath = data.parent;
    $('folderList').innerHTML = data.folders.map(f =>
        `<button type="button" class="tag-chip folder-chip" data-path="${escapeHtml(f.path)}">&#128193; ${escapeHtml(f.name)}</button>`
    ).join('');
}

// 2. Scan Folder
async function scanSelectedFolder() {
    const path = $('currentPath').value.trim();
    if (!path) return alert('Please select or enter a folder path.');

    const btn = $('btnScan');
    btn.textContent = '⏳ Scanning...';
    btn.disabled = true;

    try {
        const res = await fetch('/mm/api/fs/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Scan failed');

        allRecords = data.records;
        selectedIndexes.clear();
        applyFilters();
        $('btnSaveDb').disabled = allRecords.length === 0;
    } catch (err) {
        alert(err.message);
    } finally {
        btn.textContent = '🔍 Scan Folder';
        btn.disabled = false;
    }
}

// 3. Filters
function applyFilters() {
    const f = {};
    Object.entries(FILTERS).forEach(([field, id]) => { f[field] = $(id).value.toLowerCase(); });

    filteredRecords = allRecords.filter(r =>
        Object.keys(f).every(field => !f[field] || (r[field] || '').toLowerCase().includes(f[field]))
    );

    currentPage = 1;
    renderTable();
}

// 4. Render Table (100 rows per page)
function renderTable() {
    const total = filteredRecords.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    $('statTotal').textContent = allRecords.length;
    $('statFiltered').textContent = total;
    $('currentPage').textContent = currentPage;
    $('totalPages').textContent = totalPages;
    $('btnPrevPage').classList.toggle('disabled', currentPage <= 1);
    $('btnNextPage').classList.toggle('disabled', currentPage >= totalPages);

    const start = (currentPage - 1) * pageSize;
    const pageRecords = filteredRecords.slice(start, start + pageSize);

    $('tableBody').innerHTML = pageRecords.map(r => {
        const idx = allRecords.indexOf(r);
        const checked = selectedIndexes.has(idx) ? 'checked' : '';
        const cells = EDIT_FIELDS.map(field =>
            `<td><input class="cell-input" data-idx="${idx}" data-field="${field}" value="${escapeHtml(r[field] || '')}"></td>`
        ).join('');
        return `
            <tr>
                <td class="col-check"><input type="checkbox" class="row-check" data-idx="${idx}" ${checked}></td>
                ${cells}
                <td><div class="path-cell" title="${escapeHtml(r.path)}">${escapeHtml(r.path)}</div></td>
            </tr>`;
    }).join('');

    $('selectedCount').textContent = selectedIndexes.size;
}

function changePage(delta) {
    const totalPages = Math.ceil(filteredRecords.length / pageSize) || 1;
    const newPage = currentPage + delta;
    if (newPage >= 1 && newPage <= totalPages) {
        currentPage = newPage;
        renderTable();
    }
}

// 5. Selection & Aligned Batch Edit
function toggleSelect(index, isChecked) {
    if (isChecked) selectedIndexes.add(index);
    else selectedIndexes.delete(index);
    $('selectedCount').textContent = selectedIndexes.size;
}

function toggleSelectAll(isChecked) {
    const start = (currentPage - 1) * pageSize;
    filteredRecords.slice(start, start + pageSize).forEach(r => {
        const idx = allRecords.indexOf(r);
        if (isChecked) selectedIndexes.add(idx);
        else selectedIndexes.delete(idx);
    });
    renderTable();
}

function applyBatchEdit() {
    if (selectedIndexes.size === 0) {
        return alert('Please select at least one row using the checkboxes first.');
    }

    const values = {};
    Object.entries(BATCH).forEach(([field, id]) => { values[field] = $(id).value.trim(); });
    if (!Object.values(values).some(Boolean)) {
        return alert('Please enter at least one value in the batch edit row (yellow inputs) to apply.');
    }

    selectedIndexes.forEach(idx => {
        Object.entries(values).forEach(([field, v]) => { if (v) allRecords[idx][field] = v; });
    });

    renderTable();
    alert(`Successfully updated ${selectedIndexes.size} selected row(s)!`);
}

// 6. CSV Download & Upload
function downloadCsv() {
    if (allRecords.length === 0) return alert('No records available to download.');
    const headers = ['path', 'title', 'artist', 'album', 'category', 'playlist', 'tag_list'];
    let csvContent = '\uFEFF' + headers.join(',') + '\n';

    allRecords.forEach(r => {
        const row = headers.map(h => `"${(r[h] || '').replace(/"/g, '""')}"`);
        csvContent += row.join(',') + '\n';
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mp3_export_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

function handleCsvUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        const lines = e.target.result.split(/\r?\n/).filter(l => l.trim());
        if (lines.length <= 1) return alert('CSV file has no data rows.');

        const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        const records = [];

        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || lines[i].split(',');
            const cleanValues = values.map(v => v.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
            const obj = {};
            headers.forEach((h, idx) => obj[h] = cleanValues[idx] || '');
            if (obj.path) records.push(obj);
        }

        allRecords = records;
        selectedIndexes.clear();
        applyFilters();
        $('btnSaveDb').disabled = allRecords.length === 0;
        alert(`Loaded ${allRecords.length} record(s) from CSV!`);
    };
    reader.readAsText(file);
}

// 7. Save to Database
async function saveToDb() {
    const missingPlaylist = allRecords.filter(r => !r.playlist || !r.playlist.trim());
    if (missingPlaylist.length > 0) {
        return alert(`Cannot save: ${missingPlaylist.length} track(s) have an empty playlist. Please fill or batch-assign a playlist.`);
    }

    const btn = $('btnSaveDb');
    btn.textContent = '💾 Saving...';
    btn.disabled = true;

    try {
        const res = await fetch('/mm/api/mp3/save_batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: allRecords })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            alert(`Success! Saved/Updated ${data.saved} track(s) in SQLite database.`);
        } else {
            alert(`Save error: ${data.error || 'Failed'}`);
        }
    } catch (err) {
        alert(`Network error: ${err.message}`);
    } finally {
        btn.textContent = '💾 Save to Database';
        btn.disabled = false;
    }
}

// ── Wiring ───────────────────────────────────────────────────────────────────
$('btnParent').addEventListener('click', () => parentPath && loadDir(parentPath));
$('btnScan').addEventListener('click', scanSelectedFolder);
$('folderList').addEventListener('click', (e) => {
    const chip = e.target.closest('.folder-chip');
    if (chip) loadDir(chip.dataset.path);
});

$('btnUploadCsv').addEventListener('click', () => $('csvFileInput').click());
$('csvFileInput').addEventListener('change', handleCsvUpload);
$('btnDownloadCsv').addEventListener('click', downloadCsv);
$('btnSaveDb').addEventListener('click', saveToDb);

$('btnApplyBatch').addEventListener('click', applyBatchEdit);
$('btnApplyBatchRow').addEventListener('click', applyBatchEdit);
$('btnPrevPage').addEventListener('click', () => changePage(-1));
$('btnNextPage').addEventListener('click', () => changePage(1));
$('selectAll').addEventListener('click', (e) => toggleSelectAll(e.target.checked));
Object.values(FILTERS).forEach(id => $(id).addEventListener('input', applyFilters));

$('tableBody').addEventListener('change', (e) => {
    const el = e.target;
    const idx = parseInt(el.dataset.idx, 10);
    if (Number.isNaN(idx)) return;
    if (el.classList.contains('row-check')) toggleSelect(idx, el.checked);
    else if (el.dataset.field) allRecords[idx][el.dataset.field] = el.value;
});

loadDir();
