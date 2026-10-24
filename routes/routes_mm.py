import os
import json
import re
import sqlite3
import urllib.request
import urllib.parse
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from flask import Blueprint, url_for, render_template, request,redirect, jsonify, current_app

os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'
routes_mm = Blueprint('routes_mm', __name__)

def get_db_path():
    db_dir = os.path.join(current_app.root_path, 'data', 'mm')
    os.makedirs(db_dir, exist_ok=True)
    return os.path.join(db_dir, 'youtube.db')

def get_db_connection():
    conn = sqlite3.connect(get_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn

def extract_video_id(url: str):
    if not url:
        return None
    pattern = r'(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})'
    match = re.search(pattern, url)
    return match.group(1) if match else (url if len(url) == 11 else None)

# ── Chapters ────────────────────────────────────────────────────────────────────────

# "0:03:02 - Taras" or "[0:03:02](https://...) - Taras"
_TIMESTAMP_LINE = re.compile(
    r'^\s*\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?(?:\([^)]*\))?\s*[-–—:|]?\s*(.*?)\s*$'
)

def _to_seconds(ts: str) -> int:
    secs = 0
    for part in ts.split(':'):
        secs = secs * 60 + int(part)
    return secs

def _fetch_watch_page(video_id: str) -> dict:
    """Raises on network/parse failure so the caller can retry later."""
    req = urllib.request.Request(
        f"https://www.youtube.com/watch?v={urllib.parse.quote(video_id)}",
        headers={'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9',
                 'Cookie': 'CONSENT=YES+1'},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        html = resp.read().decode('utf-8', 'ignore')
    m = re.search(r'ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|</script)', html)
    if not m:
        raise ValueError('ytInitialPlayerResponse not found')
    d = re.search(r'ytInitialData\s*=\s*(\{.+?\})\s*;\s*</script', html)
    return {
        'player_response': json.loads(m.group(1)),
        'initial_data': json.loads(d.group(1)) if d else {},
    }

def _find_key(obj, key):
    """Yield every value stored under `key` anywhere in a nested JSON structure."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                yield v
            yield from _find_key(v, key)
    elif isinstance(obj, list):
        for v in obj:
            yield from _find_key(v, key)

def _chapters_from_youtube_markers(page: dict) -> list:
    """Chapters exactly as YouTube shows them on the progress bar."""
    seen = {}
    for ch in _find_key(page['initial_data'], 'chapterRenderer'):
        start = ch.get('timeRangeStartMillis')
        if start is None:
            continue
        title = ch.get('title', {})
        text = title.get('simpleText') or ''.join(r.get('text', '') for r in title.get('runs', []))
        seen.setdefault(int(start) // 1000, text.strip())
    return [{'seconds': s, 'title': t or f'Chapter {i + 1}'}
            for i, (s, t) in enumerate(sorted(seen.items()))]

def _chapters_from_description(page: dict) -> list:
    desc = (page['player_response'].get('videoDetails') or {}).get('shortDescription') or ''
    chapters = []
    for line in desc.splitlines():
        m = _TIMESTAMP_LINE.match(line)
        if not m:
            continue
        secs = _to_seconds(m.group(1))
        if chapters and secs <= chapters[-1]['seconds']:
            continue
        chapters.append({'seconds': secs, 'title': m.group(2) or f'Chapter {len(chapters) + 1}'})
    # same rule YouTube uses: starts at 0:00 and has more than one entry
    if len(chapters) < 2 or chapters[0]['seconds'] != 0:
        return []
    return chapters

# Tried in order; first non-empty result wins. Add new techniques here.
CHAPTER_PARSERS = [
    _chapters_from_youtube_markers,
    _chapters_from_description,
]

def find_chapters(video_id: str) -> list:
    page = _fetch_watch_page(video_id)
    for parser in CHAPTER_PARSERS:
        try:
            chapters = parser(page)
        except Exception as e:
            current_app.logger.warning(f"[chapters] {parser.__name__} failed for {video_id}: {e}")
            continue
        if chapters:
            return chapters
    return []

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.executescript("""
        CREATE TABLE IF NOT EXISTS videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            video_id TEXT UNIQUE NOT NULL,
            url TEXT NOT NULL,
            title TEXT DEFAULT 'Untitled Video',
            artist TEXT DEFAULT 'Unknown Artist',
            duration INTEGER DEFAULT 0,
            thumbnail_url TEXT,
            chapters_json TEXT DEFAULT '[]',
            playlist TEXT,
            category TEXT,
            is_new INTEGER DEFAULT 1,
            chapter_checked INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL COLLATE NOCASE
        );

        CREATE TABLE IF NOT EXISTS video_tags (
            video_id INTEGER NOT NULL,
            tag_id INTEGER NOT NULL,
            PRIMARY KEY (video_id, tag_id),
            FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_videos_is_new ON videos(is_new);
        CREATE INDEX IF NOT EXISTS idx_videos_playlist ON videos(playlist);
        CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(id DESC);
    """)

    cursor.execute("PRAGMA table_info(videos)")
    cols = [row[1] for row in cursor.fetchall()]
    if 'playlist' not in cols:
        cursor.execute("ALTER TABLE videos ADD COLUMN playlist TEXT")
    if 'chapter_checked' not in cols:
        cursor.execute("ALTER TABLE videos ADD COLUMN chapter_checked INTEGER DEFAULT 0")
    if 'category' not in cols:
        cursor.execute("ALTER TABLE videos ADD COLUMN category TEXT")

    cursor.execute("SELECT COUNT(*) FROM videos")
    if cursor.fetchone()[0] == 0:
        json_path = os.path.join(current_app.root_path, 'data', 'mm', 'youtube_videos.json')
        if os.path.exists(json_path):
            try:
                with open(json_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    for link in data.get('videos', []):
                        vid = extract_video_id(link)
                        if vid:
                            thumb = f"https://img.youtube.com/vi/{vid}/mqdefault.jpg"
                            cursor.execute("""
                                INSERT OR IGNORE INTO videos (video_id, url, thumbnail_url, playlist, is_new)
                                VALUES (?, ?, ?, 'hindi', 1)
                            """, (vid, f"https://www.youtube.com/watch?v={vid}", thumb))
            except Exception as e:
                current_app.logger.error(f"Error seeding videos: {e}")

    conn.commit()
    conn.close()


SCOPES = ['https://www.googleapis.com/auth/youtube.readonly']

@routes_mm.route('/auth/login')
def auth_login():
    client_secrets_file = os.path.join(current_app.root_path, 'data', 'mm', 'youtube_token.json')
    flow = Flow.from_client_secrets_file(
        client_secrets_file,
        scopes=SCOPES,
        redirect_uri=url_for('routes_mm.auth_callback', _external=True)
    )
    auth_url, _ = flow.authorization_url(prompt='consent', access_type='offline')
    return redirect(auth_url)

@routes_mm.route('/auth/callback')
def auth_callback():
    client_secrets_file = os.path.join(current_app.root_path, 'data', 'mm', 'youtube_token.json')
    flow = Flow.from_client_secrets_file(
        client_secrets_file,
        scopes=SCOPES,
        redirect_uri=url_for('routes_mm.auth_callback', _external=True)
    )
    flow.fetch_token(authorization_response=request.url)
    credentials = flow.credentials

    # Save the credentials & permanent refresh_token
    token_path = os.path.join(current_app.root_path, 'data', 'mm', 'youtube_token.json')
    with open(token_path, 'w') as token_file:
        token_file.write(credentials.to_json())

    return "<h2>✅ YouTube Account Authenticated!</h2><p>Your server will now permanently stay logged in.</p>"

@routes_mm.route('/mm/youtube')
def mm_youtube():
    init_db()

    conn = get_db_connection()
    cursor = conn.cursor()

    # 1. Fetch all unique playlists
    cursor.execute("""
        SELECT DISTINCT playlist 
        FROM videos 
        WHERE playlist IS NOT NULL AND TRIM(playlist) != '' 
        ORDER BY playlist ASC
    """)
    all_playlists = [row[0] for row in cursor.fetchall()]

    if not all_playlists:
        all_playlists = ['Default']

    # Strictly single playlist selection: default to first playlist
    req_playlist = request.args.get('playlist', '').strip()
    if req_playlist in all_playlists:
        selected_playlist = req_playlist
    else:
        selected_playlist = all_playlists[0]

    page = request.args.get('page', 1, type=int)
    if page < 1:
        page = 1
    per_page = 7
    offset = (page - 1) * per_page

    raw_tags = request.args.get('tags', '')
    selected_tags = [t.strip() for t in raw_tags.split(',') if t.strip()]

    # Category: optional; empty means no category filtering
    cursor.execute("""
        SELECT DISTINCT category FROM videos
        WHERE playlist = ? AND category IS NOT NULL AND TRIM(category) != ''
        ORDER BY category COLLATE NOCASE
    """, (selected_playlist,))
    playlist_categories = [row[0] for row in cursor.fetchall()]
    req_category = request.args.get('category', '').strip()
    selected_category = req_category if req_category in playlist_categories else ''
    cat_sql = " AND v.category = ?" if selected_category else ""
    cat_args = [selected_category] if selected_category else []

    # every category in use, offered as suggestions when editing a video
    cursor.execute("""
        SELECT DISTINCT category FROM videos
        WHERE category IS NOT NULL AND TRIM(category) != ''
        ORDER BY category COLLATE NOCASE
    """)
    all_categories = [row[0] for row in cursor.fetchall()]

    # 2. Fetch tags belonging to this playlist/category (excluding playlist name itself)
    cursor.execute(f"""
        SELECT t.name, COUNT(vt.video_id) AS count
        FROM tags t
        JOIN video_tags vt ON t.id = vt.tag_id
        JOIN videos v ON vt.video_id = v.id
        WHERE v.playlist = ?{cat_sql} AND LOWER(t.name) != LOWER(?)
        GROUP BY t.id
        ORDER BY count DESC, t.name ASC
    """, [selected_playlist] + cat_args + [selected_playlist])
    all_tags = [dict(r) for r in cursor.fetchall()]

    # 3. Query videos
    if selected_tags:
        placeholders = ', '.join(['?'] * len(selected_tags))
        count_sql = f"""
            SELECT COUNT(*) FROM (
                SELECT v.id
                FROM videos v
                JOIN video_tags vt ON v.id = vt.video_id
                JOIN tags t ON vt.tag_id = t.id
                WHERE v.playlist = ?{cat_sql} AND t.name IN ({placeholders})
                GROUP BY v.id
                HAVING COUNT(DISTINCT t.id) = ?
            )
        """
        cursor.execute(count_sql, [selected_playlist] + cat_args + selected_tags + [len(selected_tags)])
        total_videos = cursor.fetchone()[0]

        select_sql = f"""
            SELECT v.*, 
                   (SELECT GROUP_CONCAT(t2.name, ',') 
                    FROM tags t2 
                    JOIN video_tags vt2 ON t2.id = vt2.tag_id 
                    WHERE vt2.video_id = v.id AND LOWER(t2.name) != LOWER(?)) AS tag_list
            FROM videos v
            JOIN video_tags vt ON v.id = vt.video_id
            JOIN tags t ON vt.tag_id = t.id
            WHERE v.playlist = ?{cat_sql} AND t.name IN ({placeholders})
            GROUP BY v.id
            HAVING COUNT(DISTINCT t.id) = ?
            ORDER BY v.id DESC
            LIMIT ? OFFSET ?
        """
        cursor.execute(select_sql, [selected_playlist, selected_playlist] + cat_args + selected_tags + [len(selected_tags), per_page, offset])
        videos = [dict(r) for r in cursor.fetchall()]
    else:
        cursor.execute(f"SELECT COUNT(*) FROM videos v WHERE v.playlist = ?{cat_sql}", [selected_playlist] + cat_args)
        total_videos = cursor.fetchone()[0]

        select_sql = f"""
            SELECT v.*, 
                   (SELECT GROUP_CONCAT(t.name, ',') 
                    FROM tags t 
                    JOIN video_tags vt ON t.id = vt.tag_id 
                    WHERE vt.video_id = v.id AND LOWER(t.name) != LOWER(?)) AS tag_list
            FROM videos v
            WHERE v.playlist = ?{cat_sql}
            ORDER BY v.id DESC
            LIMIT ? OFFSET ?
        """
        cursor.execute(select_sql, [selected_playlist, selected_playlist] + cat_args + [per_page, offset])
        videos = [dict(r) for r in cursor.fetchall()]

    conn.close()

    total_pages = max(1, (total_videos + per_page - 1) // per_page)
    if page > total_pages:
        page = total_pages

    return render_template('mm/youtube.html',
                           videos=videos,
                           all_playlists=all_playlists,
                           selected_playlist=selected_playlist,
                           playlist_categories=playlist_categories,
                           selected_category=selected_category,
                           all_categories=all_categories,
                           all_tags=all_tags,
                           selected_tags=selected_tags,
                           page=page,
                           total_pages=total_pages,
                           total_videos=total_videos)

@routes_mm.route('/mm/api/video/add', methods=['POST'])
def api_add_video():
    init_db()
    data = request.get_json() or {}
    vid = extract_video_id((data.get('url') or '').strip())
    if not vid:
        return jsonify({'success': False, 'error': 'Not a valid YouTube link or ID'}), 400
    playlist = (data.get('playlist') or '').strip()
    if not playlist:
        return jsonify({'success': False, 'error': 'Playlist required'}), 400
    category = (data.get('category') or '').strip() or None
    tags = [t.strip() for t in (data.get('tags') or []) if isinstance(t, str) and t.strip()]

    conn = get_db_connection()
    try:
        if conn.execute("SELECT 1 FROM videos WHERE video_id = ?", (vid,)).fetchone():
            return jsonify({'success': False, 'error': 'This video is already in the database'}), 409
        cur = conn.execute("""
            INSERT INTO videos (video_id, url, thumbnail_url, playlist, category, is_new)
            VALUES (?, ?, ?, ?, ?, 1)
        """, (vid, f"https://www.youtube.com/watch?v={vid}",
              f"https://img.youtube.com/vi/{vid}/mqdefault.jpg", playlist, category))
        new_id = cur.lastrowid
        for tag in tags:
            conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (tag,))
            tag_id = conn.execute("SELECT id FROM tags WHERE name = ?", (tag,)).fetchone()['id']
            conn.execute("INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)", (new_id, tag_id))
        conn.commit()
        return jsonify({'success': True, 'id': new_id, 'video_id': vid})
    finally:
        conn.close()

@routes_mm.route('/mm/api/tv/videos')
def api_tv_videos():
    """Lightweight JSON endpoint designed for Native Android TV clients."""
    conn = get_db_connection()
    cursor = conn.cursor()

    # 1. Get playlist and pagination parameters
    playlist = request.args.get('playlist', '').strip()
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 20, type=int)
    offset = (page - 1) * per_page

    # Default to first available playlist if none specified
    if not playlist:
        cursor.execute("SELECT DISTINCT playlist FROM videos WHERE playlist IS NOT NULL ORDER BY playlist ASC LIMIT 1")
        row = cursor.fetchone()
        playlist = row[0] if row else 'Default'

    # 2. Fetch video list
    cursor.execute("""
        SELECT v.id, v.video_id, v.title, v.artist, v.duration, v.thumbnail_url, v.playlist
        FROM videos v
        WHERE v.playlist = ?
        ORDER BY v.id DESC
        LIMIT ? OFFSET ?
    """, (playlist, per_page, offset))
    
    videos = [dict(row) for row in cursor.fetchall()]

    # 3. Fetch all available playlists for TV sidebar
    cursor.execute("SELECT DISTINCT playlist FROM videos WHERE playlist IS NOT NULL ORDER BY playlist ASC")
    all_playlists = [r[0] for r in cursor.fetchall()]

    conn.close()

    # Return pure JSON
    return jsonify({
        'status': 'success',
        'current_playlist': playlist,
        'page': page,
        'playlists': all_playlists,
        'videos': videos
    })



@routes_mm.route('/mm/api/video/<int:vid_id>', methods=['DELETE'])
def api_delete_video(vid_id):
    init_db()
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM videos WHERE id = ?", (vid_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return jsonify({'success': deleted})

@routes_mm.route('/mm/api/video/<int:vid_id>/playlist', methods=['POST'])
def api_update_video_playlist(vid_id):
    init_db()
    data = request.get_json() or {}
    new_playlist = data.get('playlist', '').strip()
    if not new_playlist:
        return jsonify({'success': False, 'error': 'Playlist name required'}), 400

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE videos SET playlist = ? WHERE id = ?", (new_playlist, vid_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'playlist': new_playlist})

@routes_mm.route('/mm/api/video/<int:vid_id>/category', methods=['POST'])
def api_update_video_category(vid_id):
    init_db()
    data = request.get_json() or {}
    new_category = (data.get('category') or '').strip()

    conn = get_db_connection()
    conn.execute("UPDATE videos SET category = ? WHERE id = ?", (new_category or None, vid_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'category': new_category})

@routes_mm.route('/mm/api/video/<int:vid_id>/update_metadata', methods=['POST'])
def api_update_video_metadata(vid_id):
    init_db()
    data = request.get_json() or {}
    title = data.get('title', '').strip()
    artist = data.get('artist', '').strip()
    duration = data.get('duration', 0)

    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
        UPDATE videos 
        SET title = COALESCE(NULLIF(?, ''), title),
            artist = COALESCE(NULLIF(?, ''), artist),
            duration = CASE WHEN ? > 0 THEN ? ELSE duration END,
            is_new = 0
        WHERE id = ?
    """, (title, artist, duration, duration, vid_id))

    conn.commit()
    conn.close()
    return jsonify({'success': True})

@routes_mm.route('/mm/api/video/<int:vid_id>/tag', methods=['POST', 'DELETE'])
def api_manage_video_tag(vid_id):
    init_db()
    data = request.get_json() or {}
    tag_name = data.get('tag', '').strip()
    if not tag_name:
        return jsonify({'success': False, 'error': 'Tag name required'}), 400

    conn = get_db_connection()
    cursor = conn.cursor()

    if request.method == 'POST':
        cursor.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (tag_name,))
        cursor.execute("SELECT id FROM tags WHERE name = ?", (tag_name,))
        tag_id = cursor.fetchone()['id']
        cursor.execute("INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)", (vid_id, tag_id))
    else:
        cursor.execute("SELECT id FROM tags WHERE name = ?", (tag_name,))
        tag_row = cursor.fetchone()
        if tag_row:
            cursor.execute("DELETE FROM video_tags WHERE video_id = ? AND tag_id = ?", (vid_id, tag_row['id']))

    conn.commit()
    conn.close()
    return jsonify({'success': True, 'tag': tag_name})

@routes_mm.route('/mm/api/video/<int:vid_id>/chapters', methods=['POST'])
def api_video_chapters(vid_id):
    """Look up chapters once per video; later calls return the stored result."""
    init_db()
    conn = get_db_connection()
    try:
        row = conn.execute(
            "SELECT video_id, chapters_json, chapter_checked FROM videos WHERE id = ?", (vid_id,)
        ).fetchone()
        if not row:
            return jsonify({'success': False, 'error': 'Video not found'}), 404

        if row['chapter_checked']:
            return jsonify({'success': True, 'chapters': json.loads(row['chapters_json'] or '[]')})

        try:
            chapters = find_chapters(row['video_id'])
        except Exception as e:
            # not marked checked, so a temporary network/YouTube failure retries next play
            current_app.logger.warning(f"[chapters] fetch failed for {row['video_id']}: {e}")
            return jsonify({'success': False, 'error': 'Could not read video page'}), 502

        conn.execute(
            "UPDATE videos SET chapters_json = ?, chapter_checked = 1 WHERE id = ?",
            (json.dumps(chapters, ensure_ascii=False), vid_id),
        )
        conn.commit()
        return jsonify({'success': True, 'chapters': chapters})
    finally:
        conn.close()

def configure_routes_mm(app, socketio):
    app.register_blueprint(routes_mm)
