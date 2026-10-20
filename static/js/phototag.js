/**
 * phototag.js  —  Photo Tagger client
 *
 * Features:
 *  - Searchable folder combobox (any-substring, keyboard navigable)
 *  - Fast image pre-loading (±2 neighbours always cached)
 *  - next / prev navigation + side arrows + swipe on mobile
 *  - Tags: best / good / delete — mutually exclusive, toggle off by re-clicking
 *  - Tags persisted to server immediately (optimistic UI, auto-revert on fail)
 *  - Rotate: CSS transform only, resets on next image
 *  - Filmstrip sidebar on desktop (lazy-loaded thumbnails)
 *  - Keyboard: ←/→ navigate, B/G/D tag, R rotate, Esc untag
 *    (suppressed while folder search input is focused)
 */

"use strict";

// ── All folder data injected by Flask ─────────────────────────────────────────
const ALL_FOLDERS = window.PHOTOTAG_FOLDERS || [];

// ── App state ─────────────────────────────────────────────────────────────────
const state = {
  root:       "",
  folder:     "",
  folderLabel:"",
  allImages:  [],   // everything returned by server (incl. raw)
  images:     [],   // currently visible (raw filtered unless "Show raw")
  tags:       {},
  index:      0,
};

const RAW_EXTS = new Set(["cr2","cr3","crw","nef","nrw","arw","srf","sr2","dng",
  "raf","orf","rw2","pef","srw","raw","rwl","3fr","iiq"]);
const isRaw = p => RAW_EXTS.has(p.split(".").pop().toLowerCase());

// Must match PROTECTED_DIRS in routes_phototag.py
const PROTECTED_DIRS = new Set(["e", "edit"]);
const isProtected = p => [state.folder, ...p.split("/").slice(0, -1)]
  .some(s => PROTECTED_DIRS.has(s.toLowerCase()));

const imgCache = {};   // relPath → true (loaded)
const imageVersions = {}; // relPath → cache-busting token after edits

// ── DOM refs ──────────────────────────────────────────────────────────────────
const folderInput     = document.getElementById("folder-input");
const folderDropdown  = document.getElementById("folder-dropdown");
const folderClearBtn  = document.getElementById("folder-clear-btn");
const folderSelectedTag = document.getElementById("folder-selected-tag");

const mainImg         = document.getElementById("main-img");
const spinner         = document.getElementById("spinner");
const viewerMsg       = document.getElementById("viewer-msg");
const viewer          = document.getElementById("viewer");
const tagBadge        = document.getElementById("tag-badge");
const filenameStrip   = document.getElementById("filename-strip");
const counter         = document.getElementById("counter");
const fileDropdown    = document.getElementById("file-dropdown");
const filmstrip       = document.getElementById("filmstrip");

const btnPrevBar  = document.getElementById("btn-prev-bar");
const btnNextBar  = document.getElementById("btn-next-bar");
const btnPrevNav  = document.getElementById("btn-prev-nav");
const btnNextNav  = document.getElementById("btn-next-nav");
const btnRotate   = document.getElementById("btn-rotate");
const btnBest     = document.getElementById("btn-best");
const btnGood     = document.getElementById("btn-good");
const btnDelete   = document.getElementById("btn-delete");
const chkRaw      = document.getElementById("chk-raw");
const btnProcess  = document.getElementById("btn-process");

const processModal   = document.getElementById("process-modal");
const processTitle   = document.getElementById("process-title");
const processFill    = document.getElementById("process-fill");
const processStatus  = document.getElementById("process-status");
const processSummary = document.getElementById("process-summary");
const processClose   = document.getElementById("process-close");

const btnMark        = document.getElementById("btn-mark");
const markBadge      = document.getElementById("mark-badge");
const btnDownload    = document.getElementById("btn-download");
const downloadCount  = document.getElementById("download-count");
const downloadModal  = document.getElementById("download-modal");
const downloadTitle  = document.getElementById("download-title");
const downloadFill   = document.getElementById("download-fill");
const downloadStatus = document.getElementById("download-status");
const downloadList   = document.getElementById("download-list");
const downloadShare  = document.getElementById("download-share");
const downloadAll    = document.getElementById("download-all");
const downloadClear  = document.getElementById("download-clear");
const downloadClose  = document.getElementById("download-close");

// ═══════════════════════════════════════════════════════════════════════════════
// FOLDER SEARCH COMBOBOX
// ═══════════════════════════════════════════════════════════════════════════════

let dropFocusIndex = -1;   // keyboard-highlighted row in dropdown

/** Escape special regex chars in user input */
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Highlight matching substring in text, returns HTML string */
function highlight(text, query) {
  if (!query) return escHtml(text);
  const re = new RegExp(`(${escRe(query)})`, "gi");
  return escHtml(text).replace(re, "<mark>$1</mark>");
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Filter ALL_FOLDERS by folder name only (any-substring, case-insensitive) */
function filterFolders(query) {
  if (!query.trim()) return ALL_FOLDERS;
  const q = query.trim().toLowerCase();
  return ALL_FOLDERS.filter(f => f.folder_rel.toLowerCase().includes(q));
}

const MAX_DROPDOWN_ROWS = 150;   // keep DOM small with hundreds of folders

function renderDropdown(query) {
  const matches = filterFolders(query);
  const results = matches.slice(0, MAX_DROPDOWN_ROWS);
  query = query.trim();
  dropFocusIndex = -1;

  if (!results.length) {
    folderDropdown.innerHTML =
      `<div class="folder-no-results">No folders match "${escHtml(query)}"</div>`;
    openDropdown();
    return;
  }

  folderDropdown.innerHTML = results.map((f, i) => {
    const isSelected = f.root_name === state.root && f.folder_rel === state.folder;
    const nameHtml   = highlight(f.folder_rel || f.root_name, query);
    const rootHtml   = escHtml(f.root_name);
    return `
      <div class="folder-option${isSelected ? " selected" : ""}"
           role="option"
           aria-selected="${isSelected}"
           data-idx="${i}"
           data-root="${escHtml(f.root_name)}"
           data-folder="${escHtml(f.folder_rel)}"
           data-label="${escHtml(f.label)}">
        <span class="folder-option-icon">📁</span>
        <span class="folder-option-text">
          <div class="folder-option-root">${rootHtml}</div>
          <div class="folder-option-name">${nameHtml}</div>
        </span>
      </div>`;
  }).join("") + (matches.length > results.length
    ? `<div class="folder-no-results">Showing ${results.length} of ${matches.length} — type to narrow</div>`
    : "");

  // click handler
  folderDropdown.querySelectorAll(".folder-option").forEach(el => {
    el.addEventListener("mousedown", e => {
      e.preventDefault();   // don't blur the input
      selectFolder(el.dataset.root, el.dataset.folder, el.dataset.label);
    });
  });

  openDropdown();
}

function openDropdown() {
  folderDropdown.classList.add("open");
  folderInput.setAttribute("aria-expanded", "true");
}

function closeDropdown() {
  folderDropdown.classList.remove("open");
  folderInput.setAttribute("aria-expanded", "false");
  dropFocusIndex = -1;
}

function moveFocus(dir) {
  const opts = folderDropdown.querySelectorAll(".folder-option");
  if (!opts.length) return;
  opts[dropFocusIndex]?.classList.remove("focused");
  dropFocusIndex = Math.max(0, Math.min(opts.length - 1, dropFocusIndex + dir));
  const target = opts[dropFocusIndex];
  target.classList.add("focused");
  target.scrollIntoView({ block: "nearest" });
}

// Input events
folderInput.addEventListener("focus", () => {
  renderDropdown(folderInput.value);
});

// Clicking the input clears it and shows full dropdown
folderInput.addEventListener("click", () => {
  folderInput.value = "";
  folderClearBtn.classList.remove("visible");
  renderDropdown("");
});

folderInput.addEventListener("input", () => {
  folderClearBtn.classList.toggle("visible", folderInput.value.length > 0);
  renderDropdown(folderInput.value);
});

folderInput.addEventListener("keydown", e => {
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      if (!folderDropdown.classList.contains("open")) renderDropdown(folderInput.value);
      moveFocus(+1);
      break;
    case "ArrowUp":
      e.preventDefault();
      moveFocus(-1);
      break;
    case "Enter": {
      e.preventDefault();
      const focused = folderDropdown.querySelector(".folder-option.focused");
      if (focused) {
        selectFolder(focused.dataset.root, focused.dataset.folder, focused.dataset.label);
      }
      break;
    }
    case "Escape":
      closeDropdown();
      folderInput.blur();
      break;
  }
});

folderInput.addEventListener("blur", () => {
  // Small delay so mousedown on option fires first
  setTimeout(closeDropdown, 150);
});

// Clear button
folderClearBtn.addEventListener("click", () => {
  folderInput.value = "";
  folderClearBtn.classList.remove("visible");
  folderInput.focus();
  renderDropdown("");
});

// Close on outside click
document.addEventListener("click", e => {
  if (!document.getElementById("folder-picker").contains(e.target)) {
    closeDropdown();
  }
});

/** Called when user picks a folder */
function selectFolder(root, folder, label) {
  state.root   = root;
  state.folder = folder;

  console.log("[phototag] selectFolder called");
  console.log("  root       :", root);
  console.log("  folder_rel :", folder === "" ? "(empty — root itself)" : folder);
  console.log("  label      :", label);

  // Update input to show selected name
  const displayName = folder || root;
  folderInput.value = displayName;
  folderClearBtn.classList.toggle("visible", displayName.length > 0);
  closeDropdown();
  folderInput.blur();   // release focus so arrow / tag shortcuts work immediately

  // Show selected indicator
  folderSelectedTag.textContent = label;
  folderSelectedTag.classList.add("visible");

  chkRaw.checked = false;
  loadFolder(root, folder);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOLDER LOADING
// ═══════════════════════════════════════════════════════════════════════════════

async function loadFolder(root, folder) {
  state.allImages = [];
  state.images   = [];
  state.tags     = {};
  state.index    = 0;
  Object.keys(imgCache).forEach(k => delete imgCache[k]);
  btnProcess.disabled = true;

  showMessage("loading");
  setNavState();
  clearTagUI();
  updateMarkUI();
  filmstrip.innerHTML = "";
  setCounterText("—");

  try {
    const params  = new URLSearchParams({ root, folder });
    const apiUrl  = `/phototag/api/images?${params}`;
    console.log("[phototag] loadFolder → GET", apiUrl);

    const res  = await fetch(apiUrl);
    console.log("[phototag] response status :", res.status, res.statusText);

    const json = await res.json();
    console.log("[phototag] response body   :", json);

    if (json.status !== "success") throw new Error(json.message || "Server error");

    state.allImages = json.images;
    state.tags      = json.tags || {};
    btnProcess.disabled = false;

    console.log("[phototag] images received :", state.allImages.length);
    console.log("[phototag] first 5 paths   :", state.allImages.slice(0, 5));
    console.log("[phototag] tags            :", state.tags);

    refreshImageList(null);
  } catch (err) {
    console.error("[phototag] loadFolder error:", err);
    showMessage("error", err.message);
  }
}

/** Apply the raw filter; keep `keepPath` selected if still visible. */
function refreshImageList(keepPath) {
  state.images = chkRaw.checked
    ? state.allImages.slice()
    : state.allImages.filter(p => !isRaw(p));

  if (!state.images.length) {
    filmstrip.innerHTML = "";
    clearTagUI();
    setNavState();
    const rawCount = state.allImages.filter(isRaw).length;
    showMessage("empty", rawCount && !chkRaw.checked
      ? `${rawCount} raw file(s) hidden — tick "Show raw" to view them.` : "");
    setCounterText("0 images");
    return;
  }

  const idx = keepPath ? Math.max(0, state.images.indexOf(keepPath)) : 0;
  buildFilmstrip();
  buildCounterOptions();
  hideMessage();
  showImage(idx);
}

function setCounterText(text) {
  counter.textContent = text;
  counter.disabled = true;
  closeFileDropdown();
  fileDropdown.innerHTML = "";
}

function buildCounterOptions() {
  fileDropdown.innerHTML = state.images.map((p, i) => `
    <div class="file-option" role="option" data-index="${i}">
      <span class="file-option-num">${i + 1}</span>
      <span class="file-option-name">${escHtml(p)}</span>
    </div>`).join("");
  counter.disabled = false;
}

function openFileDropdown() {
  fileDropdown.querySelector(".file-option.selected")?.classList.remove("selected");
  const cur = fileDropdown.children[state.index];
  cur?.classList.add("selected");
  fileDropdown.classList.add("open");
  counter.setAttribute("aria-expanded", "true");
  cur?.scrollIntoView({ block: "center" });
}

function closeFileDropdown() {
  fileDropdown.classList.remove("open");
  counter.setAttribute("aria-expanded", "false");
}

counter.addEventListener("click", () => {
  fileDropdown.classList.contains("open") ? closeFileDropdown() : openFileDropdown();
  counter.blur();
});

fileDropdown.addEventListener("click", e => {
  const opt = e.target.closest(".file-option");
  if (!opt) return;
  closeFileDropdown();
  showImage(Number(opt.dataset.index));
});

document.addEventListener("click", e => {
  if (!document.getElementById("counter-wrap").contains(e.target)) closeFileDropdown();
});

chkRaw.addEventListener("change", () => {
  chkRaw.blur();   // give keyboard shortcuts back
  refreshImageList(state.images[state.index] || null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE DISPLAY & PRELOADING
// ═══════════════════════════════════════════════════════════════════════════════

function imgSrc(relPath, size = "view") {
  const params = new URLSearchParams({
    root: state.root, folder: state.folder, path: relPath, size,
  });
  if (imageVersions[relPath]) params.set("v", imageVersions[relPath]);
  return `/phototag/api/image?${params}`;
}

function preload(relPath) {
  if (imgCache[relPath]) return Promise.resolve(true);
  return new Promise(resolve => {
    const url    = imgSrc(relPath);
    const img    = new Image();
    img.onload   = () => {
      console.log("[phototag] image loaded ✓", url);
      imgCache[relPath] = true;
      resolve(true);
    };
    img.onerror  = (e) => {
      console.error("[phototag] image FAILED ✗", url, e);
      resolve(false);
    };
    img.src = url;
  });
}

async function showImage(index) {
  if (!state.images.length) return;
  index = Math.max(0, Math.min(index, state.images.length - 1));
  state.index    = index;
  const relPath  = state.images[index];

  console.log(`[phototag] showImage(${index}) relPath="${relPath}"`);
  console.log("[phototag] image URL →", imgSrc(relPath));

  counter.textContent       = `${index + 1} / ${state.images.length}`;
  // Show full rel path (e.g. "subfolder/photo.jpg"), not just filename
  filenameStrip.textContent = relPath;
  setNavState();
  applyTagUI(state.tags[relPath] || "");
  setTagButtonsEnabled(!isProtected(relPath));
  updateMarkUI();
  updateFilmstripActive(index);

  // Spinner only if not yet cached
  if (!imgCache[relPath]) {
    spinner.classList.add("active");
    mainImg.classList.remove("visible");
  }

  await preload(relPath);
  spinner.classList.remove("active");

  // Guard: user may have navigated away while loading
  if (state.images[state.index] !== relPath) return;

  mainImg.style.transform = "";
  mainImg.src = imgSrc(relPath);
  mainImg.classList.add("visible");

  // Background preloads: ±1, +2
  [-1, +1, +2].forEach(d => {
    const p = state.images[index + d];
    if (p) preload(p);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════

function navigate(delta) { showImage(state.index + delta); }

function setNavState() {
  const atStart = state.index <= 0 || !state.images.length;
  const atEnd   = state.index >= state.images.length - 1 || !state.images.length;
  [btnPrevBar, btnPrevNav].forEach(b => b.classList.toggle("disabled", atStart));
  [btnNextBar, btnNextNav].forEach(b => b.classList.toggle("disabled", atEnd));
}

btnPrevBar.addEventListener("click", () => navigate(-1));
btnNextBar.addEventListener("click", () => navigate(+1));
btnPrevNav.addEventListener("click", () => navigate(-1));
btnNextNav.addEventListener("click", () => navigate(+1));

// ═══════════════════════════════════════════════════════════════════════════════
// ROTATION
// ═══════════════════════════════════════════════════════════════════════════════

btnRotate.addEventListener("click", rotateImage);

async function rotateImage() {
  if (!state.images.length || btnRotate.disabled) return;
  const imageIndex = state.index;
  const relPath = state.images[imageIndex];
  btnRotate.disabled = true;

  try {
    const res = await fetch("/phototag/api/rotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: state.root, folder: state.folder, path: relPath }),
    });
    const json = await res.json();
    if (!res.ok || json.status !== "success") {
      throw new Error(json.message || "Could not rotate image.");
    }

    imageVersions[relPath] = json.version;
    delete imgCache[relPath];
    const thumb = filmstrip.querySelector(`.filmstrip-thumb[data-index="${imageIndex}"]`);
    if (thumb?.tagName === "IMG") thumb.src = imgSrc(relPath, "thumb");
    if (state.images[state.index] === relPath) mainImg.src = imgSrc(relPath);
  } catch (err) {
    console.error("[phototag] rotate failed:", err);
    window.alert(err.message || "Could not rotate image.");
  } finally {
    btnRotate.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAGGING
// ═══════════════════════════════════════════════════════════════════════════════

btnBest.addEventListener("click",   () => applyTag("best"));
btnGood.addEventListener("click",   () => applyTag("good"));
btnDelete.addEventListener("click", () => applyTag("delete"));

async function applyTag(tag) {
  if (!state.images.length) return;
  const relPath    = state.images[state.index];
  if (isProtected(relPath)) return;
  const currentTag = state.tags[relPath] || "";
  const newTag     = currentTag === tag ? "" : tag;  // toggle off if same

  // Optimistic update
  state.tags[relPath] = newTag;
  applyTagUI(newTag);
  updateFilmstripThumbTag(state.index, newTag);

  try {
    const res  = await fetch("/phototag/api/tag", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ root: state.root, folder: state.folder, path: relPath, tag: newTag }),
    });
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.message);
  } catch (err) {
    console.error("[phototag] Tag save failed:", err);
    // Revert
    state.tags[relPath] = currentTag;
    applyTagUI(currentTag);
    updateFilmstripThumbTag(state.index, currentTag);
  }
}

function applyTagUI(tag) {
  viewer.classList.remove("tag-best", "tag-good", "tag-delete");
  tagBadge.classList.remove("visible");
  btnBest.classList.toggle("active",   tag === "best");
  btnGood.classList.toggle("active",   tag === "good");
  btnDelete.classList.toggle("active", tag === "delete");

  if (tag) {
    viewer.classList.add(`tag-${tag}`);
    tagBadge.textContent =
      tag === "best"   ? "★ best"   :
      tag === "good"   ? "✓ good"   : "🗑 delete";
    tagBadge.classList.add("visible");
  }
}

function clearTagUI() { applyTagUI(""); }

function setTagButtonsEnabled(enabled) {
  [btnBest, btnGood, btnDelete].forEach(b => {
    b.disabled = !enabled;
    b.title = enabled ? "" : "Protected (e/edit folder)";
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILMSTRIP
// ═══════════════════════════════════════════════════════════════════════════════

function buildFilmstrip() {
  filmstrip.innerHTML = "";
  state.images.forEach((relPath, i) => {
    let el;
    if (isRaw(relPath)) {
      el = document.createElement("div");
      el.className   = "filmstrip-thumb filmstrip-raw";
      el.textContent = relPath.split("/").pop();
      el.title       = relPath;
    } else {
      el = document.createElement("img");
      el.className = "filmstrip-thumb";
      el.loading   = "lazy";
      el.src       = imgSrc(relPath, "thumb");
      el.alt       = relPath.split("/").pop();
    }
    el.dataset.index = i;
    const tag = state.tags[relPath];
    if (tag) el.classList.add(`tag-${tag}`);
    if (marked.has(markKey(relPath))) el.classList.add("marked");
    if (i === 0) el.classList.add("active");
    el.addEventListener("click", () => showImage(i));
    filmstrip.appendChild(el);
  });
}

function updateFilmstripActive(index) {
  filmstrip.querySelectorAll(".filmstrip-thumb").forEach((t, i) => {
    t.classList.toggle("active", i === index);
  });
  const active = filmstrip.querySelectorAll(".filmstrip-thumb")[index];
  if (active) active.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function updateFilmstripThumbTag(index, tag) {
  const thumb = filmstrip.querySelectorAll(".filmstrip-thumb")[index];
  if (!thumb) return;
  thumb.classList.remove("tag-best", "tag-good", "tag-delete");
  if (tag) thumb.classList.add(`tag-${tag}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════════════════════════════════════════════

function showMessage(type, detail = "") {
  mainImg.classList.remove("visible");
  mainImg.src = "";
  spinner.classList.remove("active");
  viewerMsg.classList.add("visible");
  const msgs = {
    loading: ["Loading images…",     "Scanning folder, please wait."],
    empty:   ["No images found",     detail || "This folder contains no supported image files."],
    error:   ["Could not load",      detail || "An error occurred."],
    idle:    ["Search for a folder", "Type in the search box above to find and select a photo folder."],
  };
  const [title, body] = msgs[type] || msgs.idle;
  viewerMsg.innerHTML = `<strong>${title}</strong>${body}`;
}

function hideMessage() { viewerMsg.classList.remove("visible"); }

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS (delete d / move b → b/, g → g/)
// ═══════════════════════════════════════════════════════════════════════════════

btnProcess.addEventListener("click", startProcess);
processClose.addEventListener("click", () => {
  processModal.classList.remove("open");
  loadFolder(state.root, state.folder);
});

async function startProcess() {
  btnProcess.blur();
  if (!state.root || !state.folder) return;

  processTitle.textContent   = "Processing…";
  processFill.style.width    = "0%";
  processStatus.textContent  = "Starting…";
  processSummary.innerHTML   = "";
  processClose.hidden        = true;
  processModal.classList.add("open");

  try {
    const res  = await fetch("/phototag/api/process", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ root: state.root, folder: state.folder }),
    });
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.message);
    pollProcess(json.job);
  } catch (err) {
    finishProcess(null, err.message);
  }
}

async function pollProcess(jobId) {
  try {
    const res  = await fetch(`/phototag/api/process/status?job=${encodeURIComponent(jobId)}`);
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.message);

    const pct = json.total ? Math.round(json.done / json.total * 100) : 100;
    processFill.style.width   = `${pct}%`;
    processStatus.textContent = `${json.done} / ${json.total}  ${json.current || ""}`;

    if (json.state === "done") finishProcess(json.summary);
    else setTimeout(() => pollProcess(jobId), 400);
  } catch (err) {
    finishProcess(null, err.message);
  }
}

function finishProcess(summary, error) {
  processClose.hidden = false;
  processFill.style.width = "100%";
  if (!summary) {
    processTitle.textContent  = "Process failed";
    processStatus.textContent = "";
    processSummary.innerHTML  = `<div class="err">${escHtml(error || "Unknown error")}</div>`;
    return;
  }
  processTitle.textContent  = "Process complete";
  processStatus.textContent = "";
  const errs = summary.errors || [];
  processSummary.innerHTML = `
    <ul>
      <li>🗑 Deleted: <b>${summary.deleted}</b></li>
      <li>★ Moved to b/: <b>${summary.moved_best}</b></li>
      <li>✓ Moved to g/: <b>${summary.moved_good}</b></li>
      <li>Already in place: <b>${summary.unchanged}</b></li>
      <li>Protected (e/edit), skipped: <b>${summary.protected || 0}</b></li>
      <li>Not found (removed from json): <b>${summary.missing}</b></li>
      <li>Errors: <b>${errs.length}</b></li>
    </ul>
    ${errs.length ? `<div class="err">${errs.map(escHtml).join("<br>")}</div>` : ""}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOWNLOAD MARKS (memory only — cleared on reload)
// ═══════════════════════════════════════════════════════════════════════════════

const marked = new Map();   // key → {root, folder, path}; survives folder switches
const markKey = p => `${state.root}\n${state.folder}\n${p}`;

function toggleMark() {
  if (!state.images.length) return;
  const p = state.images[state.index];
  const k = markKey(p);
  if (marked.has(k)) marked.delete(k);
  else marked.set(k, { root: state.root, folder: state.folder, path: p });
  updateMarkUI();
}

function updateMarkUI() {
  const p  = state.images[state.index];
  const on = !!p && marked.has(markKey(p));
  btnMark.classList.toggle("active", on);
  markBadge.classList.toggle("visible", on);
  filmstrip.querySelector(`.filmstrip-thumb[data-index="${state.index}"]`)
    ?.classList.toggle("marked", on);
  downloadCount.textContent = marked.size;
  btnDownload.disabled = marked.size === 0;
}

btnMark.addEventListener("click", () => { toggleMark(); btnMark.blur(); });

// ═══════════════════════════════════════════════════════════════════════════════
// DOWNLOAD (iOS: share sheet · Android: direct downloads · desktop: folder picker)
// ═══════════════════════════════════════════════════════════════════════════════

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const IS_ANDROID  = /Android/i.test(navigator.userAgent);
const SHARE_BATCH = 30;   // larger share sheets can fail on iOS

let dlToken = 0;
let dlFiles = [];

function origUrl(it) {
  const params = new URLSearchParams({ root: it.root, folder: it.folder, path: it.path, orig: "1" });
  return `/phototag/api/image?${params}`;
}

function releaseDownloads() {
  dlToken++;
  dlFiles = [];
}

function openDownloadModal(items, title) {
  downloadTitle.textContent  = title;
  downloadFill.style.width   = "0%";
  downloadStatus.textContent = "";
  downloadShare.innerHTML    = "";
  downloadAll.hidden = downloadClear.hidden = true;
  downloadList.innerHTML = items.map(it => `
    <div class="download-item">
      <span class="download-item-name">${escHtml(it.path)}</span>
      <span class="download-item-state">…</span>
    </div>`).join("");
  downloadModal.classList.add("open");
}

async function uniqueName(dir, name) {
  const dot  = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext  = dot > 0 ? name.slice(dot) : "";
  for (let n = 0; ; n++) {
    const cand = n ? `${base}_${n}${ext}` : name;
    try {
      await dir.getFileHandle(cand);
    } catch (err) {
      if (err.name === "NotFoundError") return cand;
      throw err;
    }
  }
}

// Desktop Chrome/Edge: pick one folder, then stream every original straight into it
async function saveToDirectory(dir, items) {
  releaseDownloads();
  const token = dlToken;
  openDownloadModal(items, `Saving ${items.length} photo(s) to "${dir.name}"…`);

  let saved = 0;
  for (const [i, it] of items.entries()) {
    if (token !== dlToken) return;
    const st = downloadList.children[i].querySelector(".download-item-state");
    downloadStatus.textContent = `${i + 1} / ${items.length}  ${it.path}`;
    try {
      const res = await fetch(origUrl(it));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fh = await dir.getFileHandle(await uniqueName(dir, it.path.split("/").pop()), { create: true });
      await res.body.pipeTo(await fh.createWritable());
      st.textContent = "saved";
      saved++;
    } catch (err) {
      console.error("[phototag] save failed:", it.path, err);
      st.textContent = "failed";
      st.classList.add("err");
    }
    downloadFill.style.width = `${Math.round((i + 1) / items.length * 100)}%`;
  }

  downloadTitle.textContent  = `${saved} of ${items.length} saved to "${dir.name}"`;
  downloadStatus.textContent = "";
  downloadClear.hidden = false;
}

// iOS: share sheet only. Fetch originals into memory first; share() then needs one more tap.
async function prepareForShare(items) {
  releaseDownloads();
  const token = dlToken;
  openDownloadModal(items, `Preparing ${items.length} photo(s)…`);

  for (const [i, it] of items.entries()) {
    const st = downloadList.children[i].querySelector(".download-item-state");
    downloadStatus.textContent = `${i + 1} / ${items.length}  ${it.path}`;
    try {
      const res = await fetch(origUrl(it));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (token !== dlToken) return;
      const file = new File([blob], it.path.split("/").pop(),
                            { type: blob.type || "application/octet-stream" });
      dlFiles.push(file);
      st.textContent = "ready";
    } catch (err) {
      if (token !== dlToken) return;
      console.error("[phototag] fetch failed:", it.path, err);
      st.textContent = "failed";
      st.classList.add("err");
    }
    downloadFill.style.width = `${Math.round((i + 1) / items.length * 100)}%`;
  }

  downloadTitle.textContent  = `${dlFiles.length} of ${items.length} ready`;
  downloadStatus.textContent = dlFiles.length ? "Tap Save to Photos, then \"Save Images\"." : "";
  renderShareButtons();
  downloadClear.hidden = false;
}

function renderShareButtons() {
  downloadShare.innerHTML = "";
  if (!navigator.canShare) {
    downloadStatus.textContent = "This browser can't save to Photos.";
    return;
  }
  for (let s = 0; s < dlFiles.length; s += SHARE_BATCH) {
    const files = dlFiles.slice(s, s + SHARE_BATCH);
    if (!navigator.canShare({ files })) continue;
    const label = dlFiles.length > SHARE_BATCH
      ? `Save to Photos ${s + 1}–${s + files.length}` : "Save to Photos";
    const b = document.createElement("button");
    b.className   = "btn-process";
    b.textContent = label;
    b.addEventListener("click", async () => {
      try {
        await navigator.share({ files });
        b.textContent = `✓ ${label}`;
      } catch (err) {
        if (err.name !== "AbortError") downloadStatus.textContent = `Share failed: ${err.message}`;
      }
    });
    downloadShare.appendChild(b);
  }
}

// Android / desktop fallback: server sends each original as an attachment, streamed to disk
async function directDownload(items) {
  releaseDownloads();
  openDownloadModal(items, `Downloading ${items.length} photo(s)…`);
  items.forEach((it, i) => {
    const a = document.createElement("a");
    a.href = origUrl(it);
    a.download = it.path.split("/").pop();
    a.textContent = "Save";
    downloadList.children[i].querySelector(".download-item-state").replaceWith(a);
  });
  await downloadAllFiles();
  downloadTitle.textContent = `${items.length} download(s) started`;
  downloadAll.hidden   = false;
  downloadClear.hidden = false;
}

async function startDownload() {
  btnDownload.blur();
  const items = [...marked.values()];
  if (!items.length) return;

  if (IS_IOS) return prepareForShare(items);

  const isTouch = matchMedia("(pointer: coarse)").matches;
  if (!isTouch && window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ id: "phototag-dl", mode: "readwrite", startIn: "downloads" });
      return saveToDirectory(dir, items);
    } catch (err) {
      if (err.name === "AbortError") return;
      console.warn("[phototag] folder picker unavailable, using browser downloads:", err);
    }
  }
  return directDownload(items);
}

async function downloadAllFiles() {
  const token = dlToken;
  const links = [...downloadList.querySelectorAll("a[download]")];
  for (const [i, a] of links.entries()) {
    if (token !== dlToken) return;
    downloadStatus.textContent = `Downloading ${i + 1} / ${links.length}`;
    downloadFill.style.width = `${Math.round((i + 1) / links.length * 100)}%`;
    a.click();
    await new Promise(r => setTimeout(r, 500));
  }
  downloadStatus.textContent = IS_ANDROID
    ? "Saved to Downloads — they appear in Gallery / Photos. If only one arrived, allow \"multiple downloads\"."
    : "If only one arrived, allow \"multiple downloads\" for this site.";
}

downloadAll.addEventListener("click", downloadAllFiles);

downloadClear.addEventListener("click", () => {
  marked.clear();
  filmstrip.querySelectorAll(".filmstrip-thumb.marked").forEach(t => t.classList.remove("marked"));
  updateMarkUI();
  closeDownloadModal();
});

function closeDownloadModal() {
  releaseDownloads();
  downloadModal.classList.remove("open");
  downloadList.innerHTML = "";
}

downloadClose.addEventListener("click", closeDownloadModal);
btnDownload.addEventListener("click", startDownload);

// ═══════════════════════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════════════════════════════

document.addEventListener("keydown", e => {
  if (processModal.classList.contains("open")) return;
  if (downloadModal.classList.contains("open")) {
    if (e.key === "Escape") closeDownloadModal();
    return;
  }
  if (fileDropdown.classList.contains("open")) {
    if (e.key === "Escape") closeFileDropdown();
    return;
  }
  // Suppress shortcuts while folder search is focused
  if (document.activeElement === folderInput) return;
  // Suppress if any other text input is focused
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;

  switch (e.key) {
    case "ArrowLeft":            e.preventDefault(); navigate(-1);      break;
    case "ArrowRight":           e.preventDefault(); navigate(+1);      break;
    case "b": case "B":          applyTag("best");                      break;
    case "g": case "G":          applyTag("good");                      break;
    case "d": case "D":          applyTag("delete");                    break;
    case "r": case "R":          rotateImage();                         break;
    case "m": case "M":          toggleMark();                          break;
    case "Escape": {
      const cur = state.images[state.index];
      if (cur && state.tags[cur]) applyTag(state.tags[cur]);  // toggle off
      break;
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SWIPE (mobile)
// ═══════════════════════════════════════════════════════════════════════════════

(function initSwipe() {
  let sx = 0, sy = 0;
  viewer.addEventListener("touchstart", e => {
    sx = e.changedTouches[0].clientX;
    sy = e.changedTouches[0].clientY;
  }, { passive: true });
  viewer.addEventListener("touchend", e => {
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) < 40 || Math.abs(dy) > Math.abs(dx) * 0.75) return;
    navigate(dx < 0 ? +1 : -1);
  }, { passive: true });
})();

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════

setNavState();