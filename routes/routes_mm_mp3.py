import os
import mimetypes
import sqlite3
from pathlib import Path
from flask import Blueprint, render_template, request, jsonify, send_file, url_for

bp_mm_mp3 = Blueprint("mm_mp3", __name__)
DB_PATH = Path(__file__).resolve().parent.parent / "mp3.db"
SUPPORTED_AUDIO_EXTS = {".mp3", ".m4a", ".flac", ".wav", ".ogg", ".aac", ".wma"}


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        title TEXT,
        artist TEXT,
        album TEXT,
        category TEXT DEFAULT NULL,
        playlist TEXT NOT NULL,
        tag_list TEXT DEFAULT '',
        duration INTEGER DEFAULT 0,
        size_bytes INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)
    cursor.execute("PRAGMA table_info(tracks);")
    cols = [r["name"] for r in cursor.fetchall()]
    if "category" not in cols:
        cursor.execute("ALTER TABLE tracks ADD COLUMN category TEXT DEFAULT NULL;")
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_path ON tracks(path);")
    conn.commit()
    conn.close()


init_db()


# -----------------------------------------------------------------------------
# 1. Main MP3 Player
# -----------------------------------------------------------------------------
@bp_mm_mp3.route("/mm/mp3")
def mp3_player():
    conn = get_db()
    cursor = conn.cursor()

    selected_playlist = request.args.get("playlist")
    selected_category = request.args.get("category", "").strip() or None

    cursor.execute("SELECT DISTINCT playlist FROM tracks WHERE playlist IS NOT NULL AND playlist != '' ORDER BY playlist;")
    all_playlists = [row["playlist"] for row in cursor.fetchall()]
    if not selected_playlist and all_playlists:
        selected_playlist = all_playlists[0]

    cursor.execute("SELECT DISTINCT category FROM tracks WHERE playlist = ? AND category IS NOT NULL AND category != '' ORDER BY category;", (selected_playlist,))
    all_categories = [row["category"] for row in cursor.fetchall()]

    if selected_category:
        query = "SELECT * FROM tracks WHERE playlist = ? AND category = ? ORDER BY title;"
        params = (selected_playlist, selected_category)
    else:
        query = "SELECT * FROM tracks WHERE playlist = ? ORDER BY title;"
        params = (selected_playlist,)

    cursor.execute(query, params)
    tracks = [dict(row) for row in cursor.fetchall()]
    conn.close()

    return render_template(
        "mm/mp3.html",
        tracks=tracks,
        all_playlists=all_playlists,
        selected_playlist=selected_playlist,
        all_categories=all_categories,
        selected_category=selected_category,
    )


# -----------------------------------------------------------------------------
# 2. Audio Streaming
# -----------------------------------------------------------------------------
@bp_mm_mp3.route("/mm/api/mp3/stream/<int:track_id>")
def stream_audio(track_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT path FROM tracks WHERE id = ?;", (track_id,))
    row = cursor.fetchone()
    conn.close()

    if not row or not os.path.exists(row["path"]):
        return jsonify({"error": "File not found"}), 404

    mimetype = mimetypes.guess_type(row["path"])[0] or "audio/mpeg"
    return send_file(row["path"], mimetype=mimetype, conditional=True)


# -----------------------------------------------------------------------------
# 2b. Read-only library API for lightweight clients (e.g. Android app)
#     GET /mm/api/mp3/library?playlist=&category=&tag=
# -----------------------------------------------------------------------------
def _split_tags(tag_list):
    return [t.strip() for t in (tag_list or "").split(",") if t.strip()]


@bp_mm_mp3.route("/mm/api/mp3/library")
def api_library():
    playlist = request.args.get("playlist", "").strip()
    category = request.args.get("category", "").strip()
    tag = request.args.get("tag", "").strip()

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT DISTINCT playlist FROM tracks WHERE playlist IS NOT NULL AND playlist != '' ORDER BY playlist;")
    playlists = [r["playlist"] for r in cursor.fetchall()]
    if not playlist and playlists:
        playlist = playlists[0]

    cursor.execute("SELECT DISTINCT category FROM tracks WHERE playlist = ? AND category IS NOT NULL AND category != '' ORDER BY category;", (playlist,))
    categories = [r["category"] for r in cursor.fetchall()]

    sql = "SELECT id, title, artist, album, category, playlist, tag_list, duration FROM tracks WHERE playlist = ?"
    params = [playlist]
    if category:
        sql += " AND category = ?"
        params.append(category)
    cursor.execute(sql + " ORDER BY title;", params)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()

    # tags offered are those of the playlist/category selection, before the tag filter
    tags = sorted({t for r in rows for t in _split_tags(r["tag_list"])}, key=str.lower)
    if tag:
        rows = [r for r in rows if tag in _split_tags(r["tag_list"])]

    tracks = [{
        "id": r["id"],
        "title": r["title"] or "Untitled",
        "artist": r["artist"] or "Unknown Artist",
        "album": r["album"] or "",
        "category": r["category"] or "",
        "playlist": r["playlist"],
        "tags": _split_tags(r["tag_list"]),
        "duration": r["duration"] or 0,
        "stream_url": url_for("mm_mp3.stream_audio", track_id=r["id"]),
    } for r in rows]

    return jsonify({
        "status": "success",
        "playlist": playlist,
        "category": category,
        "tag": tag,
        "playlists": playlists,
        "categories": categories,
        "tags": tags,
        "count": len(tracks),
        "tracks": tracks,
    })


# -----------------------------------------------------------------------------
# 3. Real-Time Single Track Update
# -----------------------------------------------------------------------------
@bp_mm_mp3.route("/mm/api/mp3/track/<int:track_id>/update", methods=["POST"])
def update_track_metadata(track_id):
    data = request.get_json() or {}
    new_playlist = data.get("playlist", "").strip()
    new_category = data.get("category", "").strip() or None
    new_tags = data.get("tag_list", "").strip()

    if not new_playlist:
        return jsonify({"success": False, "error": "Playlist cannot be empty"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    UPDATE tracks 
    SET playlist = ?, category = ?, tag_list = ?
    WHERE id = ?;
    """, (new_playlist, new_category, new_tags, track_id))
    conn.commit()
    conn.close()

    return jsonify({"success": True})


# -----------------------------------------------------------------------------
# 4. Folder Browser
# -----------------------------------------------------------------------------
@bp_mm_mp3.route("/mm/api/fs/browse")
def browse_fs():
    req_path = request.args.get("path", "").strip() or os.path.expanduser("~")
    target_path = Path(req_path).resolve()

    if not target_path.is_dir():
        return jsonify({"error": "Invalid directory"}), 400

    folders = []
    try:
        for entry in sorted(os.scandir(target_path), key=lambda e: e.name.lower()):
            if entry.is_dir() and not entry.name.startswith("."):
                folders.append({
                    "name": entry.name,
                    "path": str(Path(entry.path).resolve()).replace("\\", "/")
                })
    except PermissionError:
        return jsonify({"error": "Permission denied"}), 403

    parent_dir = str(target_path.parent).replace("\\", "/") if target_path.parent != target_path else None

    return jsonify({
        "current": str(target_path).replace("\\", "/"),
        "parent": parent_dir,
        "folders": folders
    })


# -----------------------------------------------------------------------------
# 5. Robust Audio Folder Scanner (Defaults Title to Filename without extension)
# -----------------------------------------------------------------------------
@bp_mm_mp3.route("/mm/api/fs/scan", methods=["POST"])
def scan_folder():
    data = request.get_json() or {}
    raw_path = data.get("path", "").strip()
    if not raw_path:
        return jsonify({"error": "No path provided"}), 400

    folder_path = Path(raw_path).resolve()
    if not folder_path.is_dir():
        return jsonify({"error": f"Directory not found: {folder_path}"}), 400

    records = []
    for root, _, files in os.walk(folder_path):
        for f in sorted(files):
            file_path = Path(root) / f
            if file_path.suffix.lower() in SUPPORTED_AUDIO_EXTS:
                # Default playlist is the immediate parent directory of the file
                parent_folder_name = file_path.parent.name

                records.append({
                    "path": str(file_path.resolve()).replace("\\", "/"),
                    "title": file_path.stem,          # Filename without extension
                    "artist": "",
                    "album": parent_folder_name,
                    "category": "",
                    "playlist": parent_folder_name,   # Default playlist = parent folder!
                    "tag_list": "",
                })

    return jsonify({"success": True, "records": records, "total": len(records)})


# -----------------------------------------------------------------------------
# 6. Save Batch to Database API (UPSERT by unique path)
# -----------------------------------------------------------------------------
@bp_mm_mp3.route("/mm/api/mp3/save_batch", methods=["POST"])
def save_batch():
    data = request.get_json() or {}
    records = data.get("records", [])

    if not records:
        return jsonify({"error": "No records provided"}), 400

    conn = get_db()
    cursor = conn.cursor()
    saved_count = 0
    errors = []

    for idx, r in enumerate(records, start=1):
        path = str(r.get("path", "")).strip()
        playlist = str(r.get("playlist", "")).strip()

        if not path:
            continue
        if not playlist:
            errors.append(f"Row {idx} ({r.get('title')}): Playlist cannot be empty.")
            continue

        cursor.execute("""
        INSERT INTO tracks (path, title, artist, album, category, playlist, tag_list)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            title = excluded.title,
            artist = excluded.artist,
            album = excluded.album,
            category = excluded.category,
            playlist = excluded.playlist,
            tag_list = excluded.tag_list;
        """, (
            path,
            str(r.get("title", "")).strip(),
            str(r.get("artist", "")).strip(),
            str(r.get("album", "")).strip(),
            str(r.get("category", "")).strip() or None,
            playlist,
            str(r.get("tag_list", "")).strip(),
        ))
        saved_count += 1

    conn.commit()
    conn.close()

    return jsonify({
        "success": True,
        "saved": saved_count,
        "warnings": errors[:10]
    })


# -----------------------------------------------------------------------------
# 7. Management UI
# -----------------------------------------------------------------------------
@bp_mm_mp3.route("/mm/mp3/populate")
def populate_ui():
    return render_template("mm/mp3_populate.html")


# -----------------------------------------------------------------------------
# 8. Export for app.py
# -----------------------------------------------------------------------------
def configure_routes_mm_mp3(app):
    app.register_blueprint(bp_mm_mp3)
