"""
routes_phototag.py
------------------
Photo tagging app.  Follows the configure_routes_* pattern:

    from routes_phototag import configure_routes_phototag
    configure_routes_phototag(app, socketio)

FOLDER MODEL
------------
Given roots /a and /b with structure:
    /a/a1/a2/*.jpg
    /a/a11/a3/*.jpg
    /b/b1/*.jpg
    /b/b2/*.jpg
    /b/b2/b3/*.jpg

The UI picker shows depth-1 dirs: a1, a11, b1, b2
Selecting "b2" scans recursively → finds b2/*.jpg and b2/b3/*.jpg

TAG FILES
---------
One tags.json per picked folder, saved INSIDE that folder:
    /a/a1/tags.json
    /b/b2/tags.json

rel_path stored in JSON is relative to the PICKED FOLDER:
    "photo.jpg"          (directly in b2)
    "b3/photo.jpg"       (in b2/b3 subfolder)

IGNORE
------
Folders containing a .ignore file are skipped by ordinary passphrases.
The reserved Info value .ignore opens only hidden top-level folders.
"""

from flask import g, render_template, request, jsonify, send_file, abort, Response
from collections import OrderedDict
import io
import os
import json
import re
import shutil
import threading
import tempfile
import time
import uuid
import piexif

try:
    from PIL import Image, ImageOps
except ImportError:   # Pillow optional: raw previews served un-resized, JPGs served original
    Image = None

# ── Project root ──────────────────────────────────────────────────────────────
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

# ── CONFIG — add as many root paths as needed ─────────────────────────────────
PHOTO_ROOTS = [
    os.path.abspath(os.path.join(PROJECT_ROOT, "..", "Photos-temp")),
    '/Photo-temp',
    '/photos1',
    os.path.join(PROJECT_ROOT,"..", "photos"),
    # "/mnt/nas/pictures",
]

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif"}
RAW_EXTS   = {".cr2", ".cr3", ".crw", ".nef", ".nrw", ".arw", ".srf", ".sr2", ".dng",
              ".raf", ".orf", ".rw2", ".pef", ".srw", ".raw", ".rwl", ".3fr", ".iiq"}
MAX_DEPTH  = 3   # max recursion depth inside a picked folder

# Output folders created by "process" (tag code → sub-folder name)
PROCESS_DIRS = {"g": "g", "b": "b"}

# Tags: client uses full names, tags.json stores single letters
TAG_TO_CODE = {"best": "b", "good": "g", "delete": "d"}
CODE_TO_TAG = {v: k for k, v in TAG_TO_CODE.items()}

# Images under any folder with one of these names can't be tagged or processed
PROTECTED_DIRS = {"e", "edit"}

# Preview sizes (longest edge, JPEG quality)
SIZES = {"view": (2048, 80), "thumb": (240, 65)}

_tags_lock    = threading.Lock()
_preview_lock = threading.Lock()
_rotation_lock = threading.Lock()
_preview_cache: "OrderedDict[tuple, bytes]" = OrderedDict()
PREVIEW_CACHE_MAX = 200

_jobs_lock = threading.Lock()
_jobs: dict = {}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _ext(filename: str) -> str:
    return os.path.splitext(filename)[1].lower()


def _is_image(filename: str) -> bool:
    ext = _ext(filename)
    return ext in IMAGE_EXTS or ext in RAW_EXTS


def _is_raw(filename: str) -> bool:
    return _ext(filename) in RAW_EXTS


def _is_within(path: str, base: str) -> bool:
    return path == base or path.startswith(base.rstrip(os.sep) + os.sep)


def _is_protected(folder_rel: str, rel_path: str) -> bool:
    parts = [folder_rel] + rel_path.replace("\\", "/").split("/")[:-1]
    return any(p.lower() in PROTECTED_DIRS for p in parts)


def _has_ignore(dir_abs: str) -> bool:
    """True if dir_abs itself contains a .ignore file."""
    return os.path.exists(os.path.join(dir_abs, ".ignore"))


def _hidden_only_access() -> bool:
    grant = getattr(g, 'passphrase_access', None)
    return bool(grant) and grant.get('info', '').casefold() == '.ignore'


def _path_is_ignored(path: str, folder_abs: str) -> bool:
    directory = path if os.path.isdir(path) else os.path.dirname(path)
    while _is_within(directory, folder_abs):
        if _has_ignore(directory):
            return True
        if directory == folder_abs:
            break
        directory = os.path.dirname(directory)
    return False


def _photo_path_allowed(path: str, folder_abs: str) -> bool:
    return _is_within(path, folder_abs) and (_hidden_only_access() or not _path_is_ignored(path, folder_abs))


def _tag_file(folder_abs: str) -> str:
    """tags.json lives inside the picked folder."""
    return os.path.join(folder_abs, "tags.json")


def _load_tags(folder_abs: str) -> dict:
    """Returns {rel_path: code} with codes normalised to 'b' / 'g' / 'd'."""
    tf = _tag_file(folder_abs)
    if not os.path.exists(tf):
        return {}
    try:
        with open(tf, "r", encoding="utf-8") as f:
            raw = json.load(f).get("tagged", {})
    except Exception as e:
        print(f"[phototag] Cannot read {tf}: {e}")
        return {}
    tagged = {}
    for rel, tag in raw.items():
        code = TAG_TO_CODE.get(tag, tag)
        if code in CODE_TO_TAG:
            tagged[rel] = code
    return tagged


def _load_original_paths(folder_abs: str) -> dict:
    try:
        with open(_tag_file(folder_abs), 'r', encoding='utf-8') as source:
            paths = json.load(source).get('original_paths', {})
        return {key: value for key, value in paths.items() if isinstance(key, str) and isinstance(value, str)} if isinstance(paths, dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def _original_photo_path(rel_path: str, original_paths: dict) -> str:
    if rel_path in original_paths:
        return original_paths[rel_path]
    parts = rel_path.replace('\\', '/').split('/', 1)
    return parts[1] if len(parts) == 2 and parts[0] in PROCESS_DIRS.values() else rel_path


def _save_tags(folder_abs: str, tagged: dict, original_paths=None) -> bool:
    tf = _tag_file(folder_abs)
    temporary_path = None
    try:
        if original_paths is None:
            original_paths = _load_original_paths(folder_abs)
        descriptor, temporary_path = tempfile.mkstemp(prefix='.phototag-tags-', suffix='.json', dir=folder_abs)
        with os.fdopen(descriptor, "w", encoding="utf-8") as f:
            json.dump(
                {"folder": os.path.basename(folder_abs), "tagged": tagged, "original_paths": original_paths},
                f, indent=2, ensure_ascii=False,
            )
        os.replace(temporary_path, tf)
        temporary_path = None
    except Exception as e:
        print(f"[phototag] Cannot write {tf}: {e}")
        return False
    finally:
        if temporary_path and os.path.exists(temporary_path):
            os.remove(temporary_path)
    print(f"[phototag] Tags saved -> {tf}  ({len(tagged)} entries)")
    return True


def _folder_date_key(name: str, path: str) -> str:
    """'YYYYMMDD' from a leading date in the name (20240513, 2024-05-13 …), else folder mtime."""
    m = re.match(r"^(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?!\d)", name)
    if m and 1 <= int(m.group(2)) <= 12 and 1 <= int(m.group(3)) <= 31:
        return "".join(m.groups())
    try:
        return time.strftime("%Y%m%d", time.localtime(os.path.getmtime(path)))
    except OSError:
        return "00000000"


def _folder_allowed(folder_name: str) -> bool:
    grant = getattr(g, 'passphrase_access', None)
    if not grant:
        return False
    pattern = grant['info'].casefold()
    return pattern in ('*', '.ignore') or pattern in folder_name.casefold()


def _can_manage_photos() -> bool:
    return getattr(g, 'passphrase_access', {}).get('info') == '*'


def _scan_folders(photo_roots: list, hidden_only=False) -> list[dict]:
    """
    Return depth-1 subdirectories across all roots for the UI picker.
    Each entry: {label, root_name, root_abs, folder_abs, folder_rel}
    folder_rel is the single subdir name (e.g. "a1", "b2").
    """
    folders = []
    seen    = set()

    for root_abs in photo_roots:
        root_abs = os.path.realpath(root_abs)
        if not os.path.isdir(root_abs):
            print(f"[phototag] Root not found: {root_abs}")
            continue
        root_hidden = _has_ignore(root_abs)
        if root_hidden and not hidden_only:
            continue

        root_name = os.path.basename(root_abs)

        try:
            entries = sorted(os.scandir(root_abs), key=lambda e: e.name.lower())
        except PermissionError as e:
            print(f"[phototag] Cannot scan {root_abs}: {e}")
            continue

        for entry in entries:
            if not entry.is_dir(follow_symlinks=True):
                continue
            entry_abs = os.path.realpath(entry.path)
            if not _is_within(entry_abs, root_abs) or os.path.dirname(entry_abs) != root_abs:
                continue
            if entry_abs in seen:
                continue
            if (root_hidden or _has_ignore(entry_abs)) != hidden_only:
                continue
            seen.add(entry_abs)
            folders.append({
                "label":      f"{root_name} / {entry.name}",
                "root_name":  root_name,
                "root_abs":   root_abs,
                "folder_abs": entry_abs,
                "folder_rel": entry.name,
                "date_key":   _folder_date_key(entry.name, entry_abs),
            })

    # newest first; same date → alphabetical
    folders.sort(key=lambda f: f["folder_rel"].lower())
    folders.sort(key=lambda f: f["date_key"], reverse=True)
    return folders


def _resolve_folder(photo_roots: list, root_name: str, folder_rel: str):
    """
    Resolve (root_abs, folder_abs) safely from user params.
    folder_rel is a depth-1 subdir name (e.g. "a1").
    Raises ValueError on unknown root, missing folder, or path traversal.
    """
    if not folder_rel or folder_rel in ('.', '..') or '/' in folder_rel or '\\' in folder_rel:
        raise ValueError('Select a single photo folder.')
    if not _folder_allowed(folder_rel):
        abort(403)
    print(f"[phototag] _resolve_folder: root_name={root_name!r} folder_rel={folder_rel!r}")
    print(f"[phototag] known roots: {photo_roots}")

    for root_abs in photo_roots:
        root_abs = os.path.realpath(root_abs)
        basename = os.path.basename(root_abs)
        print(f"[phototag]   checking root basename={basename!r} vs root_name={root_name!r}")
        if basename != root_name:
            continue

        if not folder_rel:
            raise ValueError("folder_rel is required — select a sub-folder, not the root")

        folder_abs = os.path.realpath(os.path.join(root_abs, folder_rel))
        print(f"[phototag]   resolved folder_abs={folder_abs!r}")
        print(f"[phototag]   folder parent={os.path.dirname(folder_abs)!r} root={root_abs!r}")

        # Security: must be inside root (not necessarily direct child, handles symlinks)
        if not _is_within(folder_abs, root_abs) or os.path.dirname(folder_abs) != root_abs:
            raise ValueError(f"Path traversal blocked: {folder_rel!r}")
        if not _folder_allowed(os.path.basename(folder_abs)):
            abort(403)
        if not os.path.isdir(folder_abs):
            raise ValueError(f"Folder not found: {folder_abs}")
        if (_has_ignore(root_abs) or _has_ignore(folder_abs)) != _hidden_only_access():
            abort(403)

        return root_abs, folder_abs

    raise ValueError(f"Unknown root: {root_name!r} (known: {[os.path.basename(r) for r in photo_roots]})")


def _scan_images(folder_abs: str, max_depth: int = MAX_DEPTH, include_ignored=False) -> list[str]:
    """
    Recursively scan folder_abs for images up to max_depth.
    Returns paths RELATIVE TO folder_abs (not root), forward-slash separated.
    e.g. for /b/b2 containing b2/x.jpg and b2/b3/y.jpg returns:
         ["x.jpg", "b3/y.jpg"]
    """
    images     = []
    base_depth = folder_abs.rstrip(os.sep).count(os.sep)

    for dirpath, dirnames, filenames in os.walk(folder_abs, followlinks=True):
        # Skip ignored dirs
        real_directory = os.path.realpath(dirpath)
        if not _is_within(real_directory, folder_abs) or (not include_ignored and _path_is_ignored(real_directory, folder_abs)):
            dirnames.clear()
            continue

        # Enforce max depth
        depth = dirpath.rstrip(os.sep).count(os.sep) - base_depth
        if depth >= max_depth:
            dirnames.clear()

        dirnames.sort()
        for fn in sorted(filenames):
            if _is_image(fn) and _is_within(os.path.realpath(os.path.join(dirpath, fn)), folder_abs):
                full = os.path.join(dirpath, fn)
                if not include_ignored and _path_is_ignored(os.path.realpath(full), folder_abs):
                    continue
                rel  = os.path.relpath(full, folder_abs).replace(os.sep, "/")
                images.append(rel)

    return images


# ── Previews (raw embedded JPEG / downsized JPEG) ─────────────────────────────

def _jpeg_end(data: bytes, start: int):
    """Walk JPEG segments from SOI at `start`; return index just past EOI, or None."""
    n = len(data)
    i = start + 2
    while i + 4 <= n:
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1
            continue
        if marker == 0xD9:
            return i + 2
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:
            i += 2
            continue
        seglen = int.from_bytes(data[i + 2:i + 4], "big")
        if marker == 0xDA:   # start of scan → skip entropy-coded data
            j = i + 2 + seglen
            while True:
                j = data.find(b"\xff", j)
                if j < 0 or j + 1 >= n:
                    return None
                m = data[j + 1]
                if m == 0x00 or 0xD0 <= m <= 0xD7:
                    j += 2
                elif m == 0xFF:
                    j += 1
                else:
                    break
            i = j
            continue
        i += 2 + seglen
    return None


def _extract_raw_jpeg(path: str):
    """Return the largest JPEG embedded in a raw file (camera preview), or None."""
    with open(path, "rb") as f:
        data = f.read()
    best = None
    pos = data.find(b"\xff\xd8\xff")
    while pos >= 0:
        end = _jpeg_end(data, pos)
        if end:
            if not best or end - pos > best[1] - best[0]:
                best = (pos, end)
            pos = data.find(b"\xff\xd8\xff", end)
        else:
            pos = data.find(b"\xff\xd8\xff", pos + 3)
    return data[best[0]:best[1]] if best else None


def _downsize(src, size_key: str):
    """src: path or bytes. Returns JPEG bytes no larger than SIZES[size_key]."""
    max_edge, quality = SIZES[size_key]
    img = Image.open(io.BytesIO(src) if isinstance(src, bytes) else src)
    img.draft("RGB", (max_edge, max_edge))   # fast DCT-scaled decode for JPEGs
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        img = img.convert("RGB")
    img.thumbnail((max_edge, max_edge))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=quality, optimize=True)
    return out.getvalue()


def _preview_bytes(full: str, size_key: str):
    """Small JPEG for `full`, or None meaning 'send the original file'."""
    raw = _is_raw(full)
    if not raw and (Image is None or _ext(full) == ".gif"):
        return None

    st  = os.stat(full)
    key = (full, st.st_mtime_ns, st.st_size, size_key)
    with _preview_lock:
        if key in _preview_cache:
            _preview_cache.move_to_end(key)
            return _preview_cache[key]

    if raw:
        data = _extract_raw_jpeg(full)
        if data is None:
            raise ValueError("No embedded preview found in raw file")
        if Image is not None:
            data = _downsize(data, size_key)
    else:
        data = _downsize(full, size_key)

    with _preview_lock:
        _preview_cache[key] = data
        while len(_preview_cache) > PREVIEW_CACHE_MAX:
            _preview_cache.popitem(last=False)
    return data


# ── Process job (delete / move to g / move to b) ──────────────────────────────

def _unique_dest(dest_dir: str, name: str) -> str:
    base, ext = os.path.splitext(name)
    dest, n = os.path.join(dest_dir, name), 1
    while os.path.exists(dest):
        dest = os.path.join(dest_dir, f"{base}_{n}{ext}")
        n += 1
    return dest


def _run_process(job: dict, folder_abs: str):
    with _tags_lock:
        tagged = _load_tags(folder_abs)
        original_paths = _load_original_paths(folder_abs)
    # deletes first, then moves
    order = {"d": 0, "b": 1, "g": 2}
    items = sorted(tagged.items(), key=lambda kv: order.get(kv[1], 9))

    s = job["summary"]
    job["total"] = len(items)
    processed = {}   # rel → code handled (old entry removed from json at the end)
    moved     = {}   # new rel → code (added to json at the end)
    moved_origins = {}

    folder_rel = os.path.basename(folder_abs)
    for rel, code in items:
        job["current"] = rel
        if _is_protected(folder_rel, rel):
            s["protected"] += 1
            job["done"] += 1
            continue
        src = os.path.realpath(os.path.join(folder_abs, rel))
        try:
            if not _is_within(src, folder_abs) or src == folder_abs:
                raise ValueError("path outside folder")
            if _path_is_ignored(src, folder_abs):
                s['protected'] += 1
                job['done'] += 1
                continue
            if code == "d":
                try:
                    os.remove(src)
                    s["deleted"] += 1
                except FileNotFoundError:
                    s["missing"] += 1
                processed[rel] = code
            elif code in PROCESS_DIRS:
                dest_dir = os.path.realpath(os.path.join(folder_abs, PROCESS_DIRS[code]))
                if not _is_within(dest_dir, folder_abs):
                    raise ValueError('destination outside folder')
                if not os.path.isfile(src):
                    s["missing"] += 1
                    processed[rel] = code
                elif os.path.dirname(src) == dest_dir:
                    s["unchanged"] += 1
                else:
                    os.makedirs(dest_dir, exist_ok=True)
                    dest = _unique_dest(dest_dir, os.path.basename(src))
                    shutil.move(src, dest)
                    s["moved_best" if code == "b" else "moved_good"] += 1
                    processed[rel] = code
                    destination_rel = os.path.relpath(dest, folder_abs).replace(os.sep, "/")
                    moved[destination_rel] = code
                    moved_origins[destination_rel] = _original_photo_path(rel, original_paths)
        except Exception as e:
            s["errors"].append(f"{rel}: {e}")
        job["done"] += 1

    # single json write at the end; keep entries re-tagged meanwhile or that failed
    with _tags_lock:
        current = _load_tags(folder_abs)
        current_origins = _load_original_paths(folder_abs)
        for rel, code in processed.items():
            if current.get(rel) == code:
                current.pop(rel)
                current_origins.pop(rel, None)
        current.update(moved)
        current_origins.update(moved_origins)
        if not _save_tags(folder_abs, current, current_origins):
            s["errors"].append("Failed to write tags.json")

    job["current"] = ""
    job["state"]   = "done"
    job["ended"]   = time.time()


# ── Route registration ────────────────────────────────────────────────────────

def configure_routes_phototag(app, socketio=None):
    photo_roots = [os.path.realpath(p) for p in PHOTO_ROOTS]

    @app.before_request
    def require_phototag_scope():
        if request.path.rstrip('/') == '/phototag' or request.path.startswith('/phototag/'):
            if not getattr(g, 'passphrase_access', None):
                abort(403)
            if not _can_manage_photos():
                process_request = request.path in ('/phototag/api/process', '/phototag/api/process/status')
                delete_request = request.path == '/phototag/api/tag' and (request.get_json(silent=True) or {}).get('tag') == 'delete'
                if process_request or delete_request:
                    return jsonify(status='error', message='Processing and deletion require wildcard access.'), 403

    def accessible_folders():
        return [folder for folder in _scan_folders(photo_roots, hidden_only=_hidden_only_access()) if _folder_allowed(folder['folder_rel'])
                and _folder_allowed(os.path.basename(folder['folder_abs']))]

    # ── Debug page ────────────────────────────────────────────────
    @app.route("/phototag/debug")
    def phototag_debug():
        if g.passphrase_access['info'] != '*':
            abort(403)
        folders = accessible_folders()
        lines = [
            "=== PHOTOTAG DEBUG ===",
            f"PROJECT_ROOT : {PROJECT_ROOT}",
            "",
        ]
        for root_abs in photo_roots:
            exists = os.path.isdir(root_abs)
            lines.append(f"ROOT [{('OK' if exists else 'MISSING')}] {root_abs}")
            if exists:
                try:
                    subs = [folder['folder_rel'] for folder in folders if folder['root_abs'] == root_abs]
                    lines.append(f"  subdirs : {sorted(subs)}")
                except Exception as e:
                    lines.append(f"  ERROR   : {e}")

        lines += ["", f"UI Picker folders ({len(folders)}):"]
        for f in folders:
            imgs = _scan_images(f["folder_abs"])
            tf   = _tag_file(f["folder_abs"])
            lines.append(f"  [{len(imgs):4d} imgs] {f['label']}")
            lines.append(f"           folder_abs : {f['folder_abs']}")
            lines.append(f"           tags.json  : {tf}")
            lines.append(f"           tag exists : {os.path.exists(tf)}")
            if imgs:
                lines.append(f"           first img  : {imgs[0]}")

        return (
            "<pre style='font-family:monospace;padding:2rem;"
            "background:#1e1e1e;color:#d4d4d4;line-height:1.6'>"
            + "\n".join(lines) + "</pre>"
        )

    # ── Test: visit /phototag/test to verify first image serves ──
    @app.route("/phototag/test")
    def phototag_test():
        folders = accessible_folders()
        lines   = ["<h2>PhotoTag — Image Serve Test</h2>"]
        for f in folders:
            imgs = _scan_images(f["folder_abs"], include_ignored=_hidden_only_access())
            lines.append(f"<h3>{f['label']} ({len(imgs)} images)</h3>")
            lines.append(f"<code>folder_abs: {f['folder_abs']}</code><br>")
            for img in imgs[:3]:
                url = (f"/phototag/api/image"
                       f"?root={f['root_name']}"
                       f"&folder={f['folder_rel']}"
                       f"&path={img}")
                full = os.path.join(f["folder_abs"], img)
                exists = os.path.isfile(full)
                lines.append(
                    f"<a href='{url}' target='_blank'>{img}</a> "
                    f"— full: <code>{full}</code> "
                    f"— exists: <b>{'✓' if exists else '✗ MISSING'}</b><br>"
                )
        return "<html><body style='font-family:monospace;padding:1rem'>" + \
               "\n".join(lines) + "</body></html>"

    # ── Main page ─────────────────────────────────────────────────
    @app.route("/phototag", strict_slashes=False)
    def phototag():
        folders = accessible_folders()
        return render_template("phototag.html", folders=folders, access_expires=g.passphrase_access_expires, can_manage=_can_manage_photos())

    # ── API: image list ───────────────────────────────────────────
    @app.route("/phototag/api/images")
    def phototag_api_images():
        root_name  = request.args.get("root",   "").strip()
        folder_rel = request.args.get("folder", "").strip()

        if not root_name or not folder_rel:
            return jsonify({"status": "error",
                            "message": "root and folder params required"}), 400
        try:
            root_abs, folder_abs = _resolve_folder(photo_roots, root_name, folder_rel)
        except ValueError as e:
            return jsonify({"status": "error", "message": str(e)}), 400

        images = _scan_images(folder_abs, include_ignored=_hidden_only_access())
        visible_paths = set(images)
        tags   = {rel: CODE_TO_TAG[c] for rel, c in _load_tags(folder_abs).items() if rel in visible_paths}

        print(f"[phototag] /api/images  folder={folder_abs}  "
              f"images={len(images)}  tags={len(tags)}")

        return jsonify({
            "status":  "success",
            "images":  images,    # rel to folder_abs
            "tags":    tags,
            "root":    root_name,
            "folder":  folder_rel,
        })

    # ── API: serve image file ─────────────────────────────────────
    @app.route("/phototag/api/image")
    def phototag_api_image():
        root_name  = request.args.get("root",   "").strip()
        folder_rel = request.args.get("folder", "").strip()
        rel_path   = request.args.get("path",   "").strip()
        size_key   = request.args.get("size",   "view").strip()
        if size_key not in SIZES:
            size_key = "view"

        print(f"[phototag] /api/image called")
        print(f"[phototag]   root={root_name!r}")
        print(f"[phototag]   folder={folder_rel!r}")
        print(f"[phototag]   path={rel_path!r}")

        if not root_name or not folder_rel or not rel_path:
            print(f"[phototag]   → 400 missing params")
            abort(400)
        if not _is_image(rel_path):
            abort(404)

        try:
            root_abs, folder_abs = _resolve_folder(photo_roots, root_name, folder_rel)
        except ValueError as e:
            print(f"[phototag]   → 404 resolve error: {e}")
            abort(404)

        full = os.path.realpath(os.path.join(folder_abs, rel_path))
        print(f"[phototag]   folder_abs={folder_abs!r}")
        print(f"[phototag]   full path ={full!r}")
        print(f"[phototag]   exists    ={os.path.exists(full)}")
        print(f"[phototag]   is_file   ={os.path.isfile(full)}")

        # Security: must stay inside folder_abs
        if not _photo_path_allowed(full, folder_abs):
            print(f"[phototag]   → 403 traversal blocked")
            abort(403)

        if not os.path.isfile(full):
            # List what IS in the folder to help debug
            try:
                contents = os.listdir(folder_abs)[:20]
                print(f"[phototag]   folder contents (first 20): {contents}")
            except Exception as e:
                print(f"[phototag]   cannot list folder: {e}")
            print(f"[phototag]   → 404 file not found: {full}")
            abort(404)

        if request.args.get("orig") == "1":
            return send_file(full, as_attachment=True,
                             download_name=os.path.basename(full))

        try:
            data = _preview_bytes(full, size_key)
        except Exception as e:
            print(f"[phototag]   → 415 preview failed: {e}")
            abort(415)

        if data is None:
            print(f"[phototag]   → 200 serving original file")
            resp = send_file(full)
        else:
            print(f"[phototag]   → 200 serving preview ({len(data) // 1024} KB)")
            resp = Response(data, mimetype="image/jpeg")
        resp.headers["Cache-Control"] = "private, max-age=3600"
        return resp

    # ── API: lossless JPEG rotation ───────────────────────────────
    @app.route("/phototag/api/rotate", methods=["POST"])
    def phototag_api_rotate():
        data       = request.json or {}
        root_name  = (data.get("root") or "").strip()
        folder_rel = (data.get("folder") or "").strip()
        rel_path   = (data.get("path") or "").strip()

        if not root_name or not folder_rel or not rel_path:
            return jsonify({"status": "error",
                            "message": "root, folder and path required"}), 400
        if _ext(rel_path) not in (".jpg", ".jpeg"):
            return jsonify({"status": "error",
                            "message": "Lossless rotation is supported for JPEG files only"}), 415

        try:
            _, folder_abs = _resolve_folder(photo_roots, root_name, folder_rel)
        except ValueError as e:
            return jsonify({"status": "error", "message": str(e)}), 400

        full = os.path.realpath(os.path.join(folder_abs, rel_path))
        if not _photo_path_allowed(full, folder_abs):
            return jsonify({"status": "error", "message": "Path outside selected folder"}), 403
        if not os.path.isfile(full):
            return jsonify({"status": "error", "message": "Image not found"}), 404

        temp_path = None
        try:
            with _rotation_lock:
                exif = piexif.load(full)
                current = exif["0th"].get(piexif.ImageIFD.Orientation, 1)
                counterclockwise = {1: 8, 8: 3, 3: 6, 6: 1,
                                    2: 5, 5: 2, 4: 7, 7: 4}
                exif["0th"][piexif.ImageIFD.Orientation] = counterclockwise.get(current, 8)
                descriptor, temp_path = tempfile.mkstemp(
                    prefix=".phototag-rotate-", suffix=_ext(full),
                    dir=os.path.dirname(full),
                )
                os.close(descriptor)
                piexif.insert(piexif.dump(exif), full, temp_path)
                os.chmod(temp_path, os.stat(full).st_mode)
                os.replace(temp_path, full)
                temp_path = None

                with _preview_lock:
                    for key in list(_preview_cache):
                        if key[0] == full:
                            del _preview_cache[key]

            return jsonify({"status": "success", "version": uuid.uuid4().hex})
        except Exception as e:
            print(f"[phototag] Cannot rotate {full}: {e}")
            return jsonify({"status": "error",
                            "message": "Could not update JPEG orientation metadata"}), 500
        finally:
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)

    # ── API: save / remove tag ────────────────────────────────────
    @app.route("/phototag/api/tag", methods=["POST"])
    def phototag_api_tag():
        data       = request.json or {}
        root_name  = data.get("root",   "").strip()
        folder_rel = data.get("folder", "").strip()
        rel_path   = data.get("path",   "").strip()
        tag        = data.get("tag",    "").strip()

        if not root_name or not folder_rel or not rel_path:
            return jsonify({"status": "error",
                            "message": "root, folder and path required"}), 400
        if tag and tag not in ("best", "good", "delete"):
            return jsonify({"status": "error",
                            "message": f"invalid tag: {tag!r}"}), 400
        if _is_protected(folder_rel, rel_path):
            return jsonify({"status": "error",
                            "message": "Images in e/edit folders can't be tagged"}), 403

        try:
            root_abs, folder_abs = _resolve_folder(photo_roots, root_name, folder_rel)
        except ValueError as e:
            return jsonify({"status": "error", "message": str(e)}), 400

        full = os.path.realpath(os.path.join(folder_abs, rel_path))
        if not _photo_path_allowed(full, folder_abs):
            abort(403)
        restored_from = None
        with _jobs_lock:
            if any(job['folder_abs'] == folder_abs and job['state'] == 'running' for job in _jobs.values()):
                return jsonify(status='error', message='Wait for this folder to finish processing.'), 409
            with _tags_lock:
                tagged = _load_tags(folder_abs)
                original_paths = _load_original_paths(folder_abs)
                if tag:
                    tagged[rel_path] = TAG_TO_CODE[tag]
                else:
                    original_rel = _original_photo_path(rel_path, original_paths) if tagged.get(rel_path) in ('b', 'g') else rel_path
                    if original_rel != rel_path:
                        destination = os.path.realpath(os.path.join(folder_abs, original_rel))
                        if not _photo_path_allowed(destination, folder_abs) or _is_protected(folder_rel, original_rel):
                            abort(403)
                        if os.path.exists(destination):
                            return jsonify(status='error', message='The original path already contains a file; nothing was overwritten.'), 409
                        if not os.path.isfile(full):
                            return jsonify(status='error', message='The marked photo no longer exists.'), 404
                        os.makedirs(os.path.dirname(destination), exist_ok=True)
                        shutil.move(full, destination)
                        restored_from = rel_path
                        rel_path = original_rel
                    tagged.pop(restored_from or rel_path, None)
                    original_paths.pop(restored_from or rel_path, None)
                ok = _save_tags(folder_abs, tagged, original_paths)
                if not ok and restored_from:
                    shutil.move(destination, full)

        if ok:
            print(f"[phototag] Tagged {rel_path!r} → {tag!r} in {folder_abs}")
            return jsonify({"status": "success", "path": rel_path, "previous_path": restored_from, "tag": tag})
        return jsonify({"status": "error", "message": "Failed to write tags.json"}), 500

    # ── API: process tags (delete / move) in background ───────────
    @app.route("/phototag/api/process", methods=["POST"])
    def phototag_api_process():
        data       = request.json or {}
        root_name  = data.get("root",   "").strip()
        folder_rel = data.get("folder", "").strip()
        if not root_name or not folder_rel:
            return jsonify({"status": "error",
                            "message": "root and folder required"}), 400
        try:
            _, folder_abs = _resolve_folder(photo_roots, root_name, folder_rel)
        except ValueError as e:
            return jsonify({"status": "error", "message": str(e)}), 400

        with _jobs_lock:
            for jid, j in list(_jobs.items()):
                if j["state"] == "done" and time.time() - j["ended"] > 3600:
                    del _jobs[jid]
            if any(j["folder_abs"] == folder_abs and j["state"] == "running"
                   for j in _jobs.values()):
                return jsonify({"status": "error",
                                "message": "Already processing this folder"}), 409
            job_id = uuid.uuid4().hex
            job = {
                "folder_abs": folder_abs, "state": "running",
                "total": 0, "done": 0, "current": "", "ended": 0,
                "summary": {"deleted": 0, "moved_best": 0, "moved_good": 0,
                            "unchanged": 0, "missing": 0, "protected": 0, "errors": []},
            }
            _jobs[job_id] = job

        threading.Thread(target=_run_process, args=(job, folder_abs), daemon=True).start()
        return jsonify({"status": "success", "job": job_id})

    @app.route("/phototag/api/process/status")
    def phototag_api_process_status():
        job = _jobs.get(request.args.get("job", ""))
        if not job:
            return jsonify({"status": "error", "message": "Unknown job"}), 404
        if not _folder_allowed(os.path.basename(job['folder_abs'])):
            abort(403)
        return jsonify({
            "status":  "success",
            "state":   job["state"],
            "total":   job["total"],
            "done":    job["done"],
            "current": job["current"],
            "summary": job["summary"],
        })