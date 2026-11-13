import os
import json
import hashlib
import hmac
import ipaddress
import re
import sqlite3
import shutil
import subprocess
import time
import csv
import io
import math
import urllib.request
import urllib.parse
from pathlib import Path
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from flask import Blueprint, url_for, render_template, request, redirect, jsonify, current_app, send_file, Response, session
from itsdangerous import URLSafeTimedSerializer, BadSignature
from routes.media_chapters import normalize_chapter_timestamps
from routes.mm_config import load_mm_config, mm_db_path, mm_path, save_tv_ip
from routes.media_downloads import download_folder, download_status, start_download

os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'
routes_mm = Blueprint('routes_mm', __name__)

def _media_serializer(database, purpose):
    pin_key = 'movie_pin' if database == 'mov' else 'x_pin'
    pin = str(load_mm_config().get(pin_key) or '')
    if not re.fullmatch(r'[0-9]+', pin):
        return None
    secret = hmac.new(str(current_app.secret_key).encode(), pin.encode(), hashlib.sha256).hexdigest()
    return URLSafeTimedSerializer(secret, salt=f'mm-{database}-{purpose}')

def _x_serializer(purpose):
    return _media_serializer('x', purpose)

def _media_access_valid(database, token=None):
    serializer = _media_serializer(database, 'access')
    if serializer is None:
        return False
    token = token or session.get(f'{database}_access', '')
    if not isinstance(token, str):
        return False
    try:
        return serializer.loads(token, max_age=86400) == 'unlocked'
    except BadSignature:
        return False

def _x_access_valid(token=None):
    return _media_access_valid('x', token)

def _unlock_media(database, pin):
    pin_key = 'movie_pin' if database == 'mov' else 'x_pin'
    configured = str(load_mm_config().get(pin_key) or '')
    serializer = _media_serializer(database, 'access')
    if serializer is None:
        return None, f'Set a numeric {pin_key} in data/mm/mm_config.json.'
    if not re.fullmatch(r'[0-9]+', pin or '') or not hmac.compare_digest(configured, pin):
        return None, 'Incorrect PIN.'
    token = serializer.dumps('unlocked')
    session[f'{database}_access'] = token
    return token, ''

def _unlock_x(pin):
    return _unlock_media('x', pin)

def _display_state(state):
    state = dict(state)
    database = state.get('database_name')
    if database in {'x', 'mov'} and state.get('media_id'):
        serializer = _media_serializer(database, 'stream')
        if serializer:
            token = serializer.dumps({'id': state['media_id'], 'revision': state['revision']})
            state['stream_url'] = f"/mm/api/{database}/stream/{state['media_id']}?token={urllib.parse.quote(token)}"
    return state

@routes_mm.before_request
def protect_x_requests():
    database = next((name for name in ('x', 'mov') if request.path.startswith(f'/mm/api/{name}/')), None)
    if database and request.path != '/mm/api/x/unlock':
        if _media_access_valid(database):
            return None
        if request.path.startswith(f'/mm/api/{database}/stream/'):
            serializer = _media_serializer(database, 'stream')
            try:
                granted = serializer.loads(request.args.get('token', ''), max_age=86400) if serializer else None
                state = _get_remote_state()
                if granted and state['database_name'] == database and granted == {'id': request.view_args.get('vid_id'), 'revision': state['revision']}:
                    return None
            except BadSignature:
                pass
        return jsonify({'success': False, 'error': 'Database PIN required.'}), 403
    database = request.values.get('database', '').strip().lower()
    if database in {'x', 'mov'} and not _media_access_valid(database):
        if request.path == '/mm/api/remote/library':
            return jsonify({'success': False, 'error': 'Database PIN required.'}), 403
        if request.path == '/mm/update':
            return redirect(url_for(f'routes_mm.mm_{database}', next='update'))

@routes_mm.route('/mm/api/x/unlock', methods=['POST'])
def api_unlock_x():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({'success': False, 'error': 'Invalid PIN request.'}), 400
    token, error = _unlock_x(str(data.get('pin') or ''))
    if error:
        return jsonify({'success': False, 'error': error}), 403
    return jsonify({'success': True, 'access_token': token})

@routes_mm.route('/mm/api/remote/database', methods=['POST'])
def api_remote_database():
    data = request.get_json(silent=True)
    if isinstance(data, dict) and isinstance(data.get('database'), str):
        database = data['database']
        if database in _unlocked_remote_databases():
            token = session.get(f'{database}_access') if database in {'x', 'mov'} else None
            return jsonify({'success': True, 'database': database, 'access_token': token})
        return jsonify({'success': False, 'error': 'Enter the PIN for this database.'}), 403
    if not isinstance(data, dict) or not isinstance(data.get('pin'), str):
        return jsonify({'success': False, 'error': 'Enter a numeric PIN.'}), 400
    pin = data['pin']
    if pin == '':
        return jsonify({'success': True, 'database': 'youtube', 'access_token': None})
    if not re.fullmatch(r'[0-9]+', pin):
        return jsonify({'success': False, 'error': 'Enter a numeric PIN.'}), 400
    config = load_mm_config()
    pins = {database: str(config.get(key) or '') for database, key in (
        ('mov', 'movie_pin'), ('vdo', 'vdo_pin'), ('x', 'x_pin')
    )}
    if not all(re.fullmatch(r'[0-9]+', value) for value in pins.values()) or len(set(pins.values())) != len(pins):
        return jsonify({'success': False, 'error': 'Configure distinct numeric database PINs in mm_config.json.'}), 503
    for database, configured_pin in pins.items():
        if not hmac.compare_digest(configured_pin, pin):
            continue
        token = None
        if database in {'x', 'mov'}:
            token, error = _unlock_media(database, pin)
            if error:
                return jsonify({'success': False, 'error': error}), 403
        else:
            session['vdo_access'] = True
        return jsonify({'success': True, 'database': database, 'access_token': token})
    return jsonify({'success': False, 'error': 'Incorrect PIN.'}), 403

def _unlocked_remote_databases():
    unlocked = ['youtube']
    if session.get('vdo_access'):
        unlocked.append('vdo')
    return unlocked + [database for database in ('mov', 'x') if _media_access_valid(database)]

def get_db_path():
    return mm_db_path('youtube_db')

def get_vdo_db_path():
    return mm_db_path('vdo_db')

def get_mov_db_path():
    return mm_db_path('mov_db')

def get_x_db_path():
    return mm_db_path('x_db')

def get_vdo_root():
    configured_root = current_app.config.get('MM_VDO_ROOT') or os.environ.get('MM_VDO_ROOT')
    if configured_root:
        return os.path.realpath(os.path.expanduser(configured_root))
    media_mount = str(mm_path('media_mount'))
    if os.path.isdir(media_mount):
        return os.path.realpath(media_mount)
    return os.path.realpath(mm_path('vdo_root'))

def get_vdo_roots():
    roots = [get_vdo_root()]
    configured_roots = load_mm_config()['paths'].get('media_roots', [])
    if not isinstance(configured_roots, list):
        raise ValueError('paths.media_roots must be a list of directories')
    for root in configured_roots:
        if not isinstance(root, str) or not root.strip():
            raise ValueError('Each media root must be a non-empty directory path')
        expanded = os.path.expanduser(os.path.expandvars(root))
        if not os.path.isabs(expanded):
            expanded = os.path.join(Path(__file__).resolve().parent.parent, expanded)
        resolved = os.path.realpath(expanded)
        if os.path.normcase(resolved) not in {os.path.normcase(value) for value in roots}:
            roots.append(resolved)
    return roots

def resolve_vdo_file(path):
    if not path:
        return None
    roots = get_vdo_roots()
    expanded_path = os.path.expanduser(path)
    candidates = [expanded_path] if os.path.isabs(expanded_path) else [os.path.join(root, expanded_path) for root in roots]
    for candidate in candidates:
        resolved = os.path.realpath(candidate)
        if not any(Path(resolved).is_relative_to(Path(root)) for root in roots):
            continue
        if os.path.isfile(resolved) and os.path.splitext(resolved)[1].lower() in {
            '.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.ts', '.ogv'
        }:
            return resolved
    return None

def get_db_connection(db_path=None):
    conn = sqlite3.connect(db_path or get_db_path())
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

def _legacy_chapters_to_text(value: str) -> str:
    try:
        chapters = json.loads(value or '[]')
    except (TypeError, ValueError):
        return ''
    timestamps = sorted({int(chapter['seconds']) for chapter in chapters
                         if isinstance(chapter, dict) and str(chapter.get('seconds', '')).isdigit()})
    return ' '.join(str(seconds) for seconds in timestamps if seconds >= 0)

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

def find_chapters(video_id: str, page=None) -> list:
    if page is None:
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

def fetch_video_metadata(video_id: str) -> dict:
    page = _fetch_watch_page(video_id)
    details = page['player_response'].get('videoDetails') or {}
    if not details:
        raise ValueError('YouTube video details are unavailable')
    title = details.get('title') or 'Untitled Video'
    artist = details.get('author') or 'Unknown Artist'
    duration = max(0, int(details.get('lengthSeconds') or 0))
    thumbnails = [thumbnail for thumbnail in (details.get('thumbnail') or {}).get('thumbnails', [])
                  if thumbnail.get('url')]
    thumbnail_url = (max(thumbnails, key=lambda thumbnail: thumbnail.get('width', 0))['url']
                     if thumbnails else f'https://img.youtube.com/vi/{video_id}/mqdefault.jpg')
    chapters = find_chapters(video_id, page)
    return {
        'title': title,
        'artist': artist,
        'duration': duration,
        'thumbnail_url': thumbnail_url,
        'chapter': normalize_chapter_timestamps(' '.join(str(chapter['seconds']) for chapter in chapters)),
        'chapter_checked': 1,
        'is_new': int(not (details.get('title') and details.get('author') and duration))
    }

def init_db(db_path=None):
    conn = get_db_connection(db_path)
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
            chapter TEXT DEFAULT '',
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
    if 'chapter' not in cols:
        cursor.execute("ALTER TABLE videos ADD COLUMN chapter TEXT DEFAULT ''")
    if 'chapters_json' in cols:
        rows = cursor.execute(
            "SELECT id, chapters_json FROM videos WHERE chapter IS NULL OR TRIM(chapter) = ''"
        ).fetchall()
        for row in rows:
            chapter_text = _legacy_chapters_to_text(row['chapters_json'])
            if chapter_text:
                cursor.execute("UPDATE videos SET chapter = ? WHERE id = ?", (chapter_text, row['id']))
        cursor.execute("ALTER TABLE videos DROP COLUMN chapters_json")

    for row in cursor.execute("SELECT id, chapter FROM videos WHERE chapter IS NOT NULL AND TRIM(chapter) != ''").fetchall():
        normalized = normalize_chapter_timestamps(row['chapter'])
        if normalized != row['chapter']:
            cursor.execute("UPDATE videos SET chapter = ? WHERE id = ?", (normalized, row['id']))

    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_url_unique ON videos(url)")

    cursor.execute("SELECT COUNT(*) FROM videos")
    if cursor.fetchone()[0] == 0 and db_path is None:
        json_path = mm_path('youtube_seed')
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


MEDIA_CSV_FIELDS = (
    'video_id', 'url', 'title', 'artist', 'duration', 'thumbnail_url',
    'chapter', 'playlist', 'category', 'is_new', 'chapter_checked', 'tags'
)
MAX_MEDIA_CSV_BYTES = 16 * 1024 * 1024


def _media_databases():
    return {
        'youtube': ('YouTube', get_db_path()),
        'vdo': ('VDO', get_vdo_db_path()),
        'mov': ('Movie', get_mov_db_path()),
        'x': ('X', get_x_db_path()),
    }


def _mp3_database_path():
    return mm_db_path('mp3_db')


def _init_mp3_csv_database(db_path):
    conn = sqlite3.connect(db_path, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            title TEXT,
            artist TEXT,
            album TEXT,
            category TEXT DEFAULT NULL,
            playlist TEXT NOT NULL,
            tag_list TEXT DEFAULT '',
            chapter TEXT DEFAULT '',
            duration INTEGER DEFAULT 0,
            size_bytes INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    columns = {row['name'] for row in conn.execute('PRAGMA table_info(tracks)').fetchall()}
    if 'category' not in columns:
        conn.execute('ALTER TABLE tracks ADD COLUMN category TEXT DEFAULT NULL')
    if 'chapter' not in columns:
        conn.execute("ALTER TABLE tracks ADD COLUMN chapter TEXT DEFAULT ''")
    for row in conn.execute("SELECT id, chapter FROM tracks WHERE chapter IS NOT NULL AND TRIM(chapter) != ''").fetchall():
        chapter = normalize_chapter_timestamps(row['chapter'])
        if chapter != row['chapter']:
            conn.execute('UPDATE tracks SET chapter = ? WHERE id = ?', (chapter, row['id']))
    conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_path ON tracks(path)')
    conn.commit()
    conn.close()


def _remote_state_db_path():
    return mm_db_path('remote_state_db')


def _get_remote_state():
    conn = sqlite3.connect(_remote_state_db_path(), timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS playback_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            database_name TEXT NOT NULL DEFAULT 'youtube',
            media_id INTEGER,
            video_id TEXT,
            title TEXT NOT NULL DEFAULT '',
            duration INTEGER NOT NULL DEFAULT 0,
            chapter TEXT NOT NULL DEFAULT '',
            position REAL NOT NULL DEFAULT 0,
            paused INTEGER NOT NULL DEFAULT 1,
            volume REAL NOT NULL DEFAULT 100,
            audio_only INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 0
        )
    """)
    state_columns = {row['name'] for row in conn.execute('PRAGMA table_info(playback_state)').fetchall()}
    if 'duration' not in state_columns:
        conn.execute('ALTER TABLE playback_state ADD COLUMN duration INTEGER NOT NULL DEFAULT 0')
    if 'chapter' not in state_columns:
        conn.execute("ALTER TABLE playback_state ADD COLUMN chapter TEXT NOT NULL DEFAULT ''")
    if 'volume' not in state_columns:
        conn.execute('ALTER TABLE playback_state ADD COLUMN volume REAL NOT NULL DEFAULT 100')
    if 'audio_only' not in state_columns:
        conn.execute('ALTER TABLE playback_state ADD COLUMN audio_only INTEGER NOT NULL DEFAULT 0')
    conn.execute("INSERT OR IGNORE INTO playback_state (id) VALUES (1)")
    conn.commit()
    state = dict(conn.execute("SELECT * FROM playback_state WHERE id = 1").fetchone())
    conn.close()
    return state


def _save_remote_state(state):
    conn = sqlite3.connect(_remote_state_db_path(), timeout=5)
    conn.execute("""
        INSERT INTO playback_state (id, database_name, media_id, video_id, title, duration, chapter, position, paused, volume, audio_only, revision)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            database_name = excluded.database_name,
            media_id = excluded.media_id,
            video_id = excluded.video_id,
            title = excluded.title,
            duration = excluded.duration,
            chapter = excluded.chapter,
            position = excluded.position,
            paused = excluded.paused,
            volume = excluded.volume,
            audio_only = excluded.audio_only,
            revision = excluded.revision
        """, (state['database_name'], state['media_id'], state['video_id'], state['title'],
                state['duration'], state['chapter'], state['position'], state['paused'], state['volume'],
              state['audio_only'], state['revision']))
    conn.commit()
    conn.close()


def _get_media_database(database):
    return _media_databases().get(database)


def _load_remote_media(state, database, media_id):
    if database == 'mp3':
        from routes.routes_mm_mp3 import get_db
        conn = get_db()
        try:
            row = conn.execute('SELECT * FROM tracks WHERE id = ?', (media_id,)).fetchone()
        finally:
            conn.close()
        if not row:
            return 'Track not found.'
        if not os.path.isfile(row['path']):
            return 'Audio file is unavailable.'
        state.update({
            'database_name': database, 'media_id': row['id'], 'video_id': '',
            'title': row['title'] or 'Untitled', 'duration': row['duration'] or 0,
            'chapter': row['chapter'] or '', 'position': 0, 'paused': 0,
            'audio_only': 1, 'revision': int(state['revision']) + 1
        })
        return None
    selected = _get_media_database(database)
    if not selected:
        return 'Unknown media database.'
    _label, db_path = selected
    init_db(None if database == 'youtube' else db_path)
    conn = get_db_connection(db_path)
    row = conn.execute(
        'SELECT id, video_id, title, duration, chapter, url FROM videos WHERE id = ?', (media_id,)
    ).fetchone()
    conn.close()
    if not row:
        return 'Media item not found.'
    if database != 'youtube' and not resolve_vdo_file(row['url']):
        return 'Local video file is unavailable.'
    state.update({
        'database_name': database,
        'media_id': row['id'],
        'video_id': row['video_id'],
        'title': row['title'] or row['video_id'],
        'duration': row['duration'] or 0,
        'chapter': row['chapter'] or '',
        'position': 0,
        'paused': 0,
        'revision': int(state['revision']) + 1
    })
    return None


def _queue_context(data):
    data = data if isinstance(data, dict) else {}
    tags = data.get('tags') if isinstance(data.get('tags'), list) else []
    return {
        'playlist': str(data.get('playlist') or '').strip()[:200],
        'category': str(data.get('category') or '').strip()[:200],
        'tags': [str(tag).strip()[:100] for tag in tags[:20] if str(tag).strip()],
        'mp3_ids': list(dict.fromkeys(value for value in data.get('mp3_ids', [])
                                    if type(value) is int and value > 0))[:10000]
                   if isinstance(data.get('mp3_ids'), list) else []
    }


def _next_queue_media_id(database, media_id, queue):
    """Next item in the remote list order (title, id), wrapping to the first."""
    if database == 'mp3':
        ids = queue.get('mp3_ids') or []
        if media_id not in ids or ids.index(media_id) + 1 >= len(ids):
            return None
        return ids[ids.index(media_id) + 1]
    selected = _get_media_database(database)
    if not selected:
        return None
    conn = get_db_connection(selected[1])
    try:
        playlist = queue.get('playlist')
        if not playlist:
            row = conn.execute('SELECT playlist FROM videos WHERE id = ?', (media_id,)).fetchone()
            playlist = row['playlist'] if row else ''
        category = queue.get('category') or ''
        tags = queue.get('tags') or []
        if tags:
            placeholders = ','.join('?' for _ in tags)
            rows = conn.execute(f"""
                SELECT v.id FROM videos v JOIN video_tags vt ON vt.video_id = v.id JOIN tags t ON t.id = vt.tag_id
                WHERE v.playlist = ? AND (? = '' OR v.category = ?) AND t.name IN ({placeholders})
                GROUP BY v.id HAVING COUNT(DISTINCT t.id) = ?
                ORDER BY v.title COLLATE NOCASE, v.id
            """, [playlist, category, category] + tags + [len(tags)]).fetchall()
        else:
            rows = conn.execute("""
                SELECT id FROM videos WHERE playlist = ? AND (? = '' OR category = ?)
                ORDER BY title COLLATE NOCASE, id
            """, (playlist, category, category)).fetchall()
    finally:
        conn.close()
    ids = [row['id'] for row in rows]
    if not ids:
        return None
    return ids[(ids.index(media_id) + 1) % len(ids)] if media_id in ids else ids[0]


@routes_mm.route('/mm')
@routes_mm.route('/mm/')
def mm_dashboard():
    return render_template('mm/dashboard.html')


@routes_mm.route('/mm/remote')
def mm_remote():
    return render_template('mm/remote.html', databases={key: value[0] for key, value in _media_databases().items()},
                           unlocked=_unlocked_remote_databases())


def _tv_control_error(tv):
    control_key = str(tv.get('control_key') or '')
    if not control_key:
        return jsonify({'success': False, 'error': 'TV control is disabled until a control key is configured.'}), 503
    supplied_key = request.headers.get('X-TV-Control-Key', '')
    if not hmac.compare_digest(control_key.encode('utf-8'), supplied_key.encode('utf-8')):
        return jsonify({'success': False, 'error': 'Invalid TV control key.'}), 403
    return None


@routes_mm.route('/mm/api/remote/tv/config', methods=['GET', 'POST'])
def api_remote_tv_config():
    try:
        tv = load_mm_config()['tv']
        error = _tv_control_error(tv)
        if error is not None:
            return error
        if request.method == 'GET':
            response = jsonify({'success': True, 'ip': tv.get('ip', '')})
            response.headers['Cache-Control'] = 'no-store'
            return response
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or not isinstance(data.get('ip'), str):
            return jsonify({'success': False, 'error': 'Enter a valid TV IP address.'}), 400
        try:
            address = str(ipaddress.ip_address(data['ip'].strip()))
        except ValueError:
            return jsonify({'success': False, 'error': 'Enter a valid IPv4 or IPv6 address without a port.'}), 400
        save_tv_ip(address)
        return jsonify({'success': True, 'ip': address})
    except (OSError, ValueError, KeyError, TypeError):
        return jsonify({'success': False, 'error': 'Could not read or save mm_config.json. Check server file permissions.'}), 503


@routes_mm.route('/mm/api/remote/tv/start', methods=['POST'])
def api_remote_tv_start():
    try:
        config = load_mm_config()
        tv = config['tv']
        address = ipaddress.ip_address(tv['ip'])
        data = request.get_json(silent=True)
        if data is not None and not isinstance(data, dict):
            return jsonify({'success': False, 'error': 'Invalid TV selection.'}), 400
        selection = data.get('selection', 4) if data is not None else 4
        if type(selection) is not int or selection not in (1, 2, 4):
            return jsonify({'success': False, 'error': 'Choose TV option 1, 2, or 4.'}), 400
        port = int(tv['adb_port'])
        timeout = float(tv['timeout_seconds'])
        if not 1 <= port <= 65535 or not 0 < timeout <= 60:
            raise ValueError('Invalid TV port or timeout')
        site_url = str(config['site_url']).rstrip('/')
        if urllib.parse.urlsplit(site_url).scheme not in {'http', 'https'}:
            raise ValueError('Invalid site URL')
        target = f'[{address}]:{port}' if address.version == 6 else f'{address}:{port}'
        executable = os.path.expandvars(os.path.expanduser(tv['adb_executable']))
        component = str(tv['app_component'])
        if not component or component.startswith('-') or '/' not in component:
            raise ValueError('Invalid app component')
    except (OSError, ValueError, KeyError, TypeError):
        return jsonify({'success': False, 'error': 'Check the TV settings in data/mm/mm_config.json.'}), 503

    # Stay under common reverse-proxy timeouts (~30-60s) so the browser always receives JSON.
    deadline = time.monotonic() + min(timeout * 2, 25)

    def run_adb(arguments):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(arguments, 0)
        return subprocess.run(
            [executable, *arguments], capture_output=True, text=True, errors='replace',
            timeout=min(timeout, remaining), check=True
        )

    try:
        connection = run_adb(['connect', target])
        if 'connected to' not in connection.stdout.lower():
            return jsonify({'success': False, 'error': 'ADB could not connect. Check TV network debugging and authorization.'}), 502
        for command in (
            ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'],
            ['shell', 'am', 'start', '-W', '-n', component],
            ['shell', 'input', 'keyevent', f'KEYCODE_{selection}']
        ):
            result = run_adb(['-s', target, *command])
            if any(line.lstrip().startswith('Error:') for line in (result.stdout + result.stderr).splitlines()):
                return jsonify({'success': False, 'error': 'ADB could not start FunHub. Check that the app is installed on the TV.'}), 502
    except FileNotFoundError:
        return jsonify({'success': False, 'error': 'ADB is not installed on the server, or its configured executable path is incorrect.'}), 503
    except subprocess.TimeoutExpired:
        return jsonify({'success': False, 'error': 'TV connection timed out. The TV must be reachable in network standby.'}), 504
    except (OSError, subprocess.CalledProcessError):
        return jsonify({'success': False, 'error': 'TV command failed. Check ADB authorization and the configured app component.'}), 502
    except Exception:
        current_app.logger.exception('TV start failed')
        return jsonify({'success': False, 'error': 'Unexpected TV start error. Check the server logs.'}), 500
    display_path = '/mm/tv' if selection == 4 else f'/catan/{selection}/game'
    return jsonify({'success': True, 'display_url': f'{site_url}{display_path}'})


@routes_mm.route('/mm/tv')
def mm_tv():
    return render_template('mm/tv.html')


FAV_TAG = 'fav'
FAV_SQL = ("EXISTS (SELECT 1 FROM video_tags fvt JOIN tags ft ON ft.id = fvt.tag_id "
           "WHERE fvt.video_id = {id} AND ft.name = '" + FAV_TAG + "')")


@routes_mm.route('/mm/api/remote/library')
def api_remote_library():
    database = request.args.get('database', 'youtube').strip().lower()
    selected = _get_media_database(database)
    if not selected:
        return jsonify({'success': False, 'error': 'Unknown media database'}), 400
    _label, db_path = selected
    init_db(None if database == 'youtube' else db_path)
    conn = get_db_connection(db_path)
    playlists = [row['playlist'] for row in conn.execute(
        "SELECT DISTINCT playlist FROM videos WHERE playlist IS NOT NULL AND TRIM(playlist) != '' ORDER BY playlist COLLATE NOCASE"
    ).fetchall()]
    playlist = request.args.get('playlist', '').strip()
    if playlist not in playlists:
        playlist = playlists[0] if playlists else ''
    categories = [row['category'] for row in conn.execute("""
        SELECT DISTINCT category FROM videos
        WHERE playlist = ? AND category IS NOT NULL AND TRIM(category) != ''
        ORDER BY category COLLATE NOCASE
    """, (playlist,)).fetchall()] if playlist else []
    category = request.args.get('category', '').strip()
    if category not in categories:
        category = ''
    tags = [dict(row) for row in conn.execute("""
        SELECT t.name, COUNT(DISTINCT vt.video_id) AS count
        FROM tags t
        JOIN video_tags vt ON vt.tag_id = t.id
        JOIN videos v ON v.id = vt.video_id
        WHERE v.playlist = ? AND (? = '' OR v.category = ?) AND LOWER(t.name) != LOWER(?)
        GROUP BY t.id ORDER BY count DESC, t.name COLLATE NOCASE
    """, (playlist, category, category, playlist)).fetchall()] if playlist else []
    selected_tags = [tag.strip() for tag in request.args.get('tags', '').split(',') if tag.strip()]
    search = request.args.get('search', '').strip().casefold()
    conn.create_function('CASEFOLD', 1, lambda value: (value or '').casefold())
    search_clause = " AND (INSTR(CASEFOLD(COALESCE(title, '')), ?) > 0 OR INSTR(CASEFOLD(COALESCE(artist, '')), ?) > 0)" if search else ''
    search_params = [search, search] if search else []
    scope_params = [playlist, category, category] + search_params
    page_size = 10
    page = max(1, request.args.get('page', 1, type=int))
    if playlist and selected_tags:
        placeholders = ','.join('?' for _ in selected_tags)
        filter_params = [playlist, category, category] + selected_tags + search_params + [len(selected_tags)]
        total_items = conn.execute(f"""
            SELECT COUNT(*) FROM (
                SELECT v.id FROM videos v
                JOIN video_tags vt ON vt.video_id = v.id
                JOIN tags t ON t.id = vt.tag_id
                WHERE v.playlist = ? AND (? = '' OR v.category = ?) AND t.name IN ({placeholders}){search_clause}
                GROUP BY v.id HAVING COUNT(DISTINCT t.id) = ?
            )
        """, filter_params).fetchone()[0]
        total_pages = max(1, (total_items + page_size - 1) // page_size)
        page = min(page, total_pages)
        rows = conn.execute(f"""
            SELECT v.id, v.video_id, v.title, v.artist, v.duration, v.playlist, v.category, v.chapter, {FAV_SQL.format(id='v.id')} AS fav
            FROM videos v JOIN video_tags vt ON vt.video_id = v.id JOIN tags t ON t.id = vt.tag_id
            WHERE v.playlist = ? AND (? = '' OR v.category = ?) AND t.name IN ({placeholders}){search_clause}
            GROUP BY v.id HAVING COUNT(DISTINCT t.id) = ?
            ORDER BY v.title COLLATE NOCASE, v.id LIMIT ? OFFSET ?
        """, filter_params + [page_size, (page - 1) * page_size]).fetchall()
    elif playlist:
        total_items = conn.execute(f"""
            SELECT COUNT(*) FROM videos
            WHERE playlist = ? AND (? = '' OR category = ?){search_clause}
        """, scope_params).fetchone()[0]
        total_pages = max(1, (total_items + page_size - 1) // page_size)
        focus_id = request.args.get('focus_id', type=int)
        focus = conn.execute(f"""
            SELECT title FROM videos WHERE id = ? AND playlist = ? AND (? = '' OR category = ?){search_clause}
        """, [focus_id] + scope_params).fetchone() if focus_id else None
        if focus:
            rank = conn.execute(f"""
                SELECT COUNT(*) FROM videos
                WHERE playlist = ? AND (? = '' OR category = ?){search_clause}
                  AND (title < ? COLLATE NOCASE OR (title = ? COLLATE NOCASE AND id < ?))
            """, scope_params + [focus['title'], focus['title'], focus_id]).fetchone()[0]
            page = rank // page_size + 1
        page = min(page, total_pages)
        rows = conn.execute(f"""
            SELECT id, video_id, title, artist, duration, playlist, category, chapter, {FAV_SQL.format(id='videos.id')} AS fav
            FROM videos WHERE playlist = ? AND (? = '' OR category = ?){search_clause}
            ORDER BY title COLLATE NOCASE, id LIMIT ? OFFSET ?
        """, scope_params + [page_size, (page - 1) * page_size]).fetchall()
    else:
        total_items = 0
        total_pages = 1
        rows = []
    items = [dict(row, tags=[]) for row in rows]
    if items:
        items_by_id = {item['id']: item for item in items}
        placeholders = ','.join('?' for _ in items)
        for tag in conn.execute(f"""
            SELECT vt.video_id, t.name FROM video_tags vt JOIN tags t ON t.id = vt.tag_id
            WHERE vt.video_id IN ({placeholders}) ORDER BY t.name COLLATE NOCASE
        """, list(items_by_id)).fetchall():
            items_by_id[tag['video_id']]['tags'].append(tag['name'])
    conn.close()
    return jsonify({
        'success': True,
        'database': database,
        'playlists': playlists,
        'playlist': playlist,
        'categories': categories,
        'category': category,
        'tags': tags,
        'selected_tags': selected_tags,
        'page': page,
        'pages': total_pages,
        'total_items': total_items,
        'page_size': page_size,
        'items': items
    })


@routes_mm.route('/mm/api/remote/state')
def api_remote_state():
    state = _get_remote_state()
    if state['database_name'] in {'x', 'mov'} and not _media_access_valid(state['database_name']):
        return jsonify({'success': False, 'error': 'X PIN required.'}), 403
    return jsonify(state)


def _remote_view_connection():
    conn = sqlite3.connect(_remote_state_db_path(), timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS remote_view_state (
            database_name TEXT PRIMARY KEY,
            playlist TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',
            search TEXT NOT NULL DEFAULT '',
            page INTEGER NOT NULL DEFAULT 1,
            media_id INTEGER
        )
    """)
    return conn


def _remote_database_error(database):
    if not _get_media_database(database):
        return jsonify({'success': False, 'error': 'Unknown media database.'}), 400
    if database not in _unlocked_remote_databases():
        return jsonify({'success': False, 'error': 'Enter the PIN for this database.'}), 403
    return None


@routes_mm.route('/mm/api/remote/view/<database>', methods=['GET', 'POST'])
def api_remote_view(database):
    error = _remote_database_error(database)
    if error:
        return error
    conn = _remote_view_connection()
    try:
        if request.method == 'GET':
            row = conn.execute('SELECT * FROM remote_view_state WHERE database_name = ?', (database,)).fetchone()
            if not row:
                return jsonify({'success': True, 'view': None})
            view = dict(row)
            view['tags'] = json.loads(view['tags'] or '[]')
            return jsonify({'success': True, 'view': view})
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({'success': False, 'error': 'Invalid view state.'}), 400
        text = {key: data.get(key, '') for key in ('playlist', 'category', 'search')}
        tags = data.get('tags', [])
        page = data.get('page', 1)
        media_id = data.get('media_id')
        if (any(not isinstance(value, str) or len(value) > 200 for value in text.values())
                or not isinstance(tags, list) or len(tags) > 20
                or any(not isinstance(tag, str) or len(tag) > 100 for tag in tags)
                or type(page) is not int or not 1 <= page <= 100000
                or (media_id is not None and type(media_id) is not int)):
            return jsonify({'success': False, 'error': 'Invalid view state.'}), 400
        conn.execute("""
            INSERT INTO remote_view_state (database_name, playlist, category, tags, search, page, media_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(database_name) DO UPDATE SET playlist = excluded.playlist, category = excluded.category,
                tags = excluded.tags, search = excluded.search, page = excluded.page, media_id = excluded.media_id
        """, (database, text['playlist'].strip(), text['category'].strip(), json.dumps([tag.strip() for tag in tags if tag.strip()]),
              text['search'].strip(), page, media_id))
        conn.commit()
        return jsonify({'success': True})
    finally:
        conn.close()


MEDIA_EDIT_LIMITS = {'title': 300, 'artist': 200, 'playlist': 200, 'category': 200, 'thumbnail_url': 2000, 'url': 2000}
CHAPTER_MARKER_GAP = 5


@routes_mm.route('/mm/api/remote/fav/<database>/<int:media_id>', methods=['POST'])
def api_remote_toggle_fav(database, media_id):
    error = _remote_database_error(database)
    if error:
        return error
    db_path = _get_media_database(database)[1]
    init_db(None if database == 'youtube' else db_path)
    conn = get_db_connection(db_path)
    try:
        if not conn.execute('SELECT 1 FROM videos WHERE id = ?', (media_id,)).fetchone():
            return jsonify({'success': False, 'error': 'Media item not found.'}), 404
        conn.execute('INSERT OR IGNORE INTO tags (name) VALUES (?)', (FAV_TAG,))
        tag_id = conn.execute('SELECT id FROM tags WHERE name = ?', (FAV_TAG,)).fetchone()['id']
        removed = conn.execute('DELETE FROM video_tags WHERE video_id = ? AND tag_id = ?', (media_id, tag_id)).rowcount
        if not removed:
            conn.execute('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)', (media_id, tag_id))
        conn.commit()
    finally:
        conn.close()
    return jsonify({'success': True, 'fav': not removed})


@routes_mm.route('/mm/api/remote/chapter', methods=['POST'])
def api_remote_add_chapter():
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get('database'), str) or type(data.get('media_id')) is not int:
        return jsonify({'success': False, 'error': 'Invalid chapter request.'}), 400
    position = data.get('position')
    if type(position) not in (int, float) or not math.isfinite(position) or position < 0:
        return jsonify({'success': False, 'error': 'Invalid playback position.'}), 400
    database, media_id = data['database'], data['media_id']
    error = _remote_database_error(database)
    if error:
        return error
    state = _get_remote_state()
    if state['database_name'] != database or state['media_id'] != media_id:
        return jsonify({'success': False, 'error': 'The playing item changed. Try again.'}), 409
    if state['duration']:
        position = min(position, state['duration'])
    seconds = int(position)
    db_path = _get_media_database(database)[1]
    init_db(None if database == 'youtube' else db_path)
    conn = get_db_connection(db_path)
    try:
        row = conn.execute('SELECT chapter FROM videos WHERE id = ?', (media_id,)).fetchone()
        if not row:
            return jsonify({'success': False, 'error': 'Media item not found.'}), 404
        existing = [float(value) for value in normalize_chapter_timestamps(row['chapter'] or '').split()]
        nearby = next((value for value in existing if abs(value - seconds) <= CHAPTER_MARKER_GAP), None)
        if nearby is not None:
            return jsonify({'success': True, 'added': False, 'position': seconds, 'nearby': nearby,
                            'chapter': row['chapter'] or ''})
        chapter = normalize_chapter_timestamps(' '.join([row['chapter'] or '', str(seconds)]))
        conn.execute('UPDATE videos SET chapter = ?, chapter_checked = 1 WHERE id = ?', (chapter, media_id))
        conn.commit()
    finally:
        conn.close()
    state['chapter'] = chapter
    _save_remote_state(state)
    socketio = current_app.extensions.get('socketio')
    if socketio:
        socketio.emit('media_state', {'state': _display_state(state), 'command': 'metadata'})
    return jsonify({'success': True, 'added': True, 'position': seconds, 'chapter': chapter})


@routes_mm.route('/mm/api/remote/media/<database>/<int:media_id>', methods=['GET', 'POST'])
def api_remote_media_entry(database, media_id):
    error = _remote_database_error(database)
    if error:
        return error
    db_path = _get_media_database(database)[1]
    init_db(None if database == 'youtube' else db_path)
    conn = get_db_connection(db_path)
    try:
        row = conn.execute('SELECT * FROM videos WHERE id = ?', (media_id,)).fetchone()
        if not row:
            return jsonify({'success': False, 'error': 'Media item not found.'}), 404
        if request.method == 'GET':
            tags = [tag['name'] for tag in conn.execute("""
                SELECT t.name FROM tags t JOIN video_tags vt ON vt.tag_id = t.id
                WHERE vt.video_id = ? ORDER BY t.name COLLATE NOCASE
            """, (media_id,)).fetchall()]
            return jsonify({'success': True, 'local': database != 'youtube',
                            'media': {**{key: row[key] for key in row.keys()}, 'tags': tags}})

        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({'success': False, 'error': 'Invalid media entry.'}), 400
        values = {}
        for field, limit in MEDIA_EDIT_LIMITS.items():
            value = data.get(field, '')
            if not isinstance(value, str) or len(value) > limit:
                return jsonify({'success': False, 'error': f'Invalid {field.replace("_", " ")}.'}), 400
            values[field] = value.strip()
        tags = data.get('tags', [])
        duration = data.get('duration', 0)
        chapter = data.get('chapter', '')
        if (not isinstance(tags, list) or len(tags) > 50 or any(not isinstance(tag, str) or len(tag) > 100 for tag in tags)
                or type(duration) is not int or duration < 0 or not isinstance(chapter, str) or len(chapter) > 4000):
            return jsonify({'success': False, 'error': 'Check tags, duration and chapters.'}), 400
        if not values['playlist']:
            return jsonify({'success': False, 'error': 'Playlist is required.'}), 400
        if values['thumbnail_url'] and urllib.parse.urlsplit(values['thumbnail_url']).scheme not in {'http', 'https'}:
            return jsonify({'success': False, 'error': 'Thumbnail must be an http(s) link.'}), 400
        url = row['url']
        if database != 'youtube' and values['url'] != row['url']:
            if not resolve_vdo_file(values['url']):
                return jsonify({'success': False, 'error': 'File path must be an existing video under a media root.'}), 400
            url = values['url']
        chapter = normalize_chapter_timestamps(chapter)
        try:
            conn.execute("""
                UPDATE videos SET title = ?, artist = ?, duration = ?, thumbnail_url = ?, chapter = ?, chapter_checked = 1,
                    playlist = ?, category = ?, url = ?, is_new = 0
                WHERE id = ?
            """, (values['title'] or 'Untitled Video', values['artist'] or 'Unknown Artist', duration,
                  values['thumbnail_url'] or None, chapter, values['playlist'], values['category'] or None, url, media_id))
        except sqlite3.IntegrityError:
            return jsonify({'success': False, 'error': 'Another entry already uses that file path.'}), 409
        conn.execute('DELETE FROM video_tags WHERE video_id = ?', (media_id,))
        for tag in dict.fromkeys(tag.strip() for tag in tags if tag.strip()):
            conn.execute('INSERT OR IGNORE INTO tags (name) VALUES (?)', (tag,))
            tag_id = conn.execute('SELECT id FROM tags WHERE name = ?', (tag,)).fetchone()['id']
            conn.execute('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)', (media_id, tag_id))
        conn.commit()
    finally:
        conn.close()

    state = _get_remote_state()
    if state['database_name'] == database and state['media_id'] == media_id:
        state.update(title=values['title'] or 'Untitled Video', duration=duration or state['duration'], chapter=chapter)
        _save_remote_state(state)
        socketio = current_app.extensions.get('socketio')
        if socketio:
            # 'metadata' updates text on screens without reloading or seeking the player.
            socketio.emit('media_state', {'state': _display_state(state), 'command': 'metadata'})
    return jsonify({'success': True})


def _export_media_csv(database, db_path):
    conn = get_db_connection(db_path)
    rows = conn.execute("""
        SELECT v.*,
               (SELECT GROUP_CONCAT(t.name, ',')
                FROM tags t JOIN video_tags vt ON vt.tag_id = t.id
                WHERE vt.video_id = v.id) AS tags
        FROM videos v
        ORDER BY v.id
    """).fetchall()
    conn.close()

    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=MEDIA_CSV_FIELDS, lineterminator='\r\n')
    writer.writeheader()
    for row in rows:
        writer.writerow({field: '' if row[field] is None else row[field] for field in MEDIA_CSV_FIELDS})

    return Response(
        output.getvalue(),
        mimetype='text/csv; charset=utf-8',
        headers={'Content-Disposition': f'attachment; filename="{database}.csv"'}
    )


def _csv_value(row, headers, field, existing, default=''):
    if field in headers:
        return str(row.get(field) or '').strip()
    if existing is not None and existing[field] is not None:
        return str(existing[field])
    return default


def _csv_flag(value, field, default):
    if not value:
        return default
    normalized = value.strip().lower()
    if normalized in {'1', 'true', 'yes', 'y'}:
        return 1
    if normalized in {'0', 'false', 'no', 'n'}:
        return 0
    raise ValueError(f'{field} must be 0 or 1')


def _import_media_csv(database, db_path, uploaded_file):
    content = uploaded_file.stream.read(MAX_MEDIA_CSV_BYTES + 1)
    if len(content) > MAX_MEDIA_CSV_BYTES:
        raise ValueError('CSV file is larger than 16 MB')
    try:
        text = content.decode('utf-8-sig')
    except UnicodeDecodeError as error:
        raise ValueError('CSV must use UTF-8 encoding') from error

    reader = csv.DictReader(io.StringIO(text))
    header_map = {str(name or '').strip().lower(): name for name in (reader.fieldnames or [])}
    if 'url' not in header_map:
        raise ValueError('CSV must contain a url column')

    normalized_rows = []
    seen_video_ids = set()
    seen_urls = set()
    local_media = database in {'vdo', 'mov', 'x'}

    for row in reader:
        line = reader.line_num
        if not any(str(value or '').strip() for value in row.values()):
            continue
        values = {key: row.get(column) for key, column in header_map.items()}
        url = str(values.get('url') or '').strip()
        if not url:
            raise ValueError(f'Row {line}: url is required')

        if local_media:
            url = resolve_vdo_file(url)
            if not url:
                raise ValueError(f'Row {line}: local path must resolve to an existing video under one of the configured media roots')
            url_key = os.path.normcase(url)
        else:
            extracted_id = extract_video_id(url)
            if not extracted_id:
                raise ValueError(f'Row {line}: url is not a valid YouTube link or ID')
            url_key = url

        video_id = str(values.get('video_id') or '').strip()
        if local_media:
            if not video_id:
                video_id = f"local-{hashlib.sha256(os.path.normcase(url).encode('utf-8')).hexdigest()[:24]}"
        else:
            if video_id and video_id != extracted_id:
                raise ValueError(f'Row {line}: video_id does not match the YouTube URL')
            video_id = video_id or extracted_id

        if video_id in seen_video_ids or url_key in seen_urls:
            raise ValueError(f'Row {line}: duplicate video_id or url in this CSV')
        seen_video_ids.add(video_id)
        seen_urls.add(url_key)

        normalized_rows.append((line, values, video_id, url, url_key))

    if not normalized_rows:
        raise ValueError('CSV contains no video rows')

    conn = get_db_connection(db_path)
    added = updated = 0
    try:
        conn.execute('BEGIN IMMEDIATE')
        for line, values, video_id, url, _url_key in normalized_rows:
            by_id = conn.execute('SELECT * FROM videos WHERE video_id = ?', (video_id,)).fetchone()
            by_url = conn.execute('SELECT * FROM videos WHERE url = ?', (url,)).fetchone()
            if by_id and by_url and by_id['id'] != by_url['id']:
                raise ValueError(f'Row {line}: video_id and url match different database records')
            existing = by_id or by_url

            title = _csv_value(values, header_map, 'title', existing,
                               os.path.splitext(os.path.basename(url))[0] if local_media else 'Untitled Video')
            artist = _csv_value(values, header_map, 'artist', existing, 'Local video' if local_media else 'Unknown Artist')
            duration_text = _csv_value(values, header_map, 'duration', existing, '0')
            try:
                duration = int(duration_text or 0)
            except ValueError as error:
                raise ValueError(f'Row {line}: duration must be a non-negative integer') from error
            if duration < 0:
                raise ValueError(f'Row {line}: duration must be a non-negative integer')

            thumbnail_url = _csv_value(values, header_map, 'thumbnail_url', existing, '') or None
            chapter = normalize_chapter_timestamps(
                _csv_value(values, header_map, 'chapter', existing, '')
            )
            playlist = _csv_value(values, header_map, 'playlist', existing, 'Default') or 'Default'
            category = _csv_value(values, header_map, 'category', existing, '') or None
            is_new = _csv_flag(
                _csv_value(values, header_map, 'is_new', existing, '1'),
                'is_new', 1
            )
            chapter_checked = _csv_flag(
                _csv_value(values, header_map, 'chapter_checked', existing, '0'),
                'chapter_checked', 0
            )

            if existing:
                conn.execute("""
                    UPDATE videos SET video_id = ?, url = ?, title = ?, artist = ?, duration = ?,
                        thumbnail_url = ?, chapter = ?, playlist = ?, category = ?, is_new = ?, chapter_checked = ?
                    WHERE id = ?
                """, (video_id, url, title, artist, duration, thumbnail_url, chapter,
                      playlist, category, is_new, chapter_checked, existing['id']))
                video_row_id = existing['id']
                updated += 1
            else:
                cursor = conn.execute("""
                    INSERT INTO videos (video_id, url, title, artist, duration, thumbnail_url,
                        chapter, playlist, category, is_new, chapter_checked)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (video_id, url, title, artist, duration, thumbnail_url, chapter,
                      playlist, category, is_new, chapter_checked))
                video_row_id = cursor.lastrowid
                added += 1

            if 'tags' in header_map:
                conn.execute('DELETE FROM video_tags WHERE video_id = ?', (video_row_id,))
                tags = dict.fromkeys(tag.strip() for tag in str(values.get('tags') or '').split(',') if tag.strip())
                for tag in tags:
                    conn.execute('INSERT OR IGNORE INTO tags (name) VALUES (?)', (tag,))
                    tag_id = conn.execute('SELECT id FROM tags WHERE name = ?', (tag,)).fetchone()['id']
                    conn.execute('INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)', (video_row_id, tag_id))

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return added, updated


MP3_CSV_FIELDS = (
    'id', 'path', 'title', 'artist', 'album', 'category', 'playlist',
    'tag_list', 'chapter', 'duration', 'size_bytes', 'created_at'
)
MP3_AUDIO_EXTENSIONS = {'.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac', '.wma'}


def _export_mp3_csv(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute('SELECT * FROM tracks ORDER BY id').fetchall()
    conn.close()
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=MP3_CSV_FIELDS, lineterminator='\r\n')
    writer.writeheader()
    for row in rows:
        writer.writerow({field: '' if row[field] is None else row[field] for field in MP3_CSV_FIELDS})
    return Response(
        output.getvalue(),
        mimetype='text/csv; charset=utf-8',
        headers={'Content-Disposition': 'attachment; filename="mp3.csv"'}
    )


def _import_mp3_csv(db_path, uploaded_file):
    content = uploaded_file.stream.read(MAX_MEDIA_CSV_BYTES + 1)
    if len(content) > MAX_MEDIA_CSV_BYTES:
        raise ValueError('CSV file is larger than 16 MB')
    try:
        text = content.decode('utf-8-sig')
    except UnicodeDecodeError as error:
        raise ValueError('CSV must use UTF-8 encoding') from error

    reader = csv.DictReader(io.StringIO(text))
    header_map = {str(name or '').strip().lower(): name for name in (reader.fieldnames or [])}
    if 'path' not in header_map:
        raise ValueError('MP3 CSV must contain a path column')

    rows = []
    seen_ids = set()
    seen_paths = set()
    for line, row in enumerate(reader, start=2):
        if not any(str(value or '').strip() for value in row.values()):
            continue
        values = {key: row.get(column) for key, column in header_map.items()}
        raw_path = str(values.get('path') or '').strip()
        path = os.path.realpath(os.path.expanduser(raw_path)) if raw_path else ''
        if not path or not os.path.isfile(path):
            raise ValueError(f'Row {line}: path must point to an existing audio file')
        if os.path.splitext(path)[1].lower() not in MP3_AUDIO_EXTENSIONS:
            raise ValueError(f'Row {line}: unsupported audio file type')
        path_key = os.path.normcase(path)

        raw_id = str(values.get('id') or '').strip()
        try:
            track_id = int(raw_id) if raw_id else None
        except ValueError as error:
            raise ValueError(f'Row {line}: id must be a positive integer or empty') from error
        if track_id is not None and track_id <= 0:
            raise ValueError(f'Row {line}: id must be a positive integer or empty')
        if (track_id is not None and track_id in seen_ids) or path_key in seen_paths:
            raise ValueError(f'Row {line}: duplicate id or path in this CSV')
        if track_id is not None:
            seen_ids.add(track_id)
        seen_paths.add(path_key)
        rows.append((line, values, track_id, path, path_key))

    if not rows:
        raise ValueError('CSV contains no MP3 rows')

    conn = sqlite3.connect(db_path, timeout=5)
    conn.row_factory = sqlite3.Row
    added = updated = 0
    try:
        conn.execute('BEGIN IMMEDIATE')
        for line, values, track_id, path, path_key in rows:
            by_id = conn.execute('SELECT * FROM tracks WHERE id = ?', (track_id,)).fetchone() if track_id else None
            by_path = conn.execute('SELECT * FROM tracks WHERE path = ?', (path,)).fetchone()
            if by_id and by_path and by_id['id'] != by_path['id']:
                raise ValueError(f'Row {line}: id and path match different MP3 records')
            existing = by_id or by_path
            other_path = conn.execute('SELECT id FROM tracks WHERE path = ?', (path,)).fetchone()
            if other_path and (not existing or other_path['id'] != existing['id']):
                raise ValueError(f'Row {line}: path already belongs to another MP3 record')

            def value(field, default=''):
                return _csv_value(values, header_map, field, existing, default)

            title = value('title', os.path.splitext(os.path.basename(path))[0]) or os.path.splitext(os.path.basename(path))[0]
            artist = value('artist', '')
            album = value('album', '')
            category = value('category', '') or None
            playlist = value('playlist', 'Default') or (existing['playlist'] if existing else 'Default')
            tags = ', '.join(dict.fromkeys(tag.strip() for tag in value('tag_list', '').split(',') if tag.strip()))
            chapter = normalize_chapter_timestamps(value('chapter', ''))
            numeric = {}
            for field in ('duration', 'size_bytes'):
                raw = value(field, '0') or '0'
                try:
                    numeric[field] = int(raw)
                except ValueError as error:
                    raise ValueError(f'Row {line}: {field} must be a non-negative integer') from error
                if numeric[field] < 0:
                    raise ValueError(f'Row {line}: {field} must be a non-negative integer')

            record = (path, title, artist, album, category, playlist, tags, chapter, numeric['duration'], numeric['size_bytes'])
            if existing:
                conn.execute("""
                    UPDATE tracks SET path = ?, title = ?, artist = ?, album = ?, category = ?, playlist = ?,
                        tag_list = ?, chapter = ?, duration = ?, size_bytes = ? WHERE id = ?
                """, record + (existing['id'],))
                updated += 1
            else:
                conn.execute("""
                    INSERT INTO tracks (path, title, artist, album, category, playlist, tag_list, chapter, duration, size_bytes)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, record)
                added += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return added, updated


@routes_mm.route('/mm/update', methods=['GET', 'POST'])
def mm_update():
    databases = {**_media_databases(), 'mp3': ('MP3', _mp3_database_path())}
    database = request.values.get('database', 'youtube').strip().lower()
    if database not in databases:
        database = 'youtube'
        error = 'Select one of the available databases.'
    else:
        error = ''
    label, db_path = databases[database]
    if database == 'mp3':
        _init_mp3_csv_database(db_path)
    else:
        init_db(None if database == 'youtube' else db_path)

    if request.method == 'GET' and request.args.get('action') == 'download':
        return _export_mp3_csv(db_path) if database == 'mp3' else _export_media_csv(database, db_path)

    message = ''
    if request.method == 'POST' and not error:
        uploaded_file = request.files.get('file')
        if not uploaded_file or not uploaded_file.filename:
            error = 'Choose a CSV file to upload.'
        else:
            try:
                if database == 'mp3':
                    added, updated = _import_mp3_csv(db_path, uploaded_file)
                else:
                    added, updated = _import_media_csv(database, db_path, uploaded_file)
                message = f'Import complete: {added} added, {updated} updated.'
            except (ValueError, sqlite3.IntegrityError, csv.Error) as import_error:
                error = f'Import failed; no rows were changed. {import_error}'

    return render_template(
        'mm/update.html',
        databases={key: value[0] for key, value in databases.items()},
        selected_database=database,
        database_label=label,
        message=message,
        error=error
    )


SCOPES = ['https://www.googleapis.com/auth/youtube.readonly']

@routes_mm.route('/auth/login')
def auth_login():
    client_secrets_file = str(mm_path('youtube_credentials'))
    flow = Flow.from_client_secrets_file(
        client_secrets_file,
        scopes=SCOPES,
        redirect_uri=url_for('routes_mm.auth_callback', _external=True)
    )
    auth_url, _ = flow.authorization_url(prompt='consent', access_type='offline')
    return redirect(auth_url)

@routes_mm.route('/auth/callback')
def auth_callback():
    client_secrets_file = str(mm_path('youtube_credentials'))
    flow = Flow.from_client_secrets_file(
        client_secrets_file,
        scopes=SCOPES,
        redirect_uri=url_for('routes_mm.auth_callback', _external=True)
    )
    flow.fetch_token(authorization_response=request.url)
    credentials = flow.credentials

    # Save the credentials & permanent refresh_token
    token_path = mm_path('youtube_credentials')
    with open(token_path, 'w') as token_file:
        token_file.write(credentials.to_json())

    return "<h2>✅ YouTube Account Authenticated!</h2><p>Your server will now permanently stay logged in.</p>"

@routes_mm.route('/mm/youtube')
def mm_youtube():
    return _render_media_library('youtube')

@routes_mm.route('/mm/vdo')
def mm_vdo():
    return _render_media_library('local', 'vdo')

@routes_mm.route('/mm/mov', methods=['GET', 'POST'])
def mm_mov():
    if request.method == 'GET' and _media_access_valid('mov'):
        return _render_media_library('local', 'mov')
    error = ''
    if request.method == 'POST':
        token, error = _unlock_media('mov', request.form.get('pin', ''))
        if token:
            if request.args.get('next') == 'update':
                return redirect(url_for('routes_mm.mm_update', database='mov'))
            return _render_media_library('local', 'mov')
    return render_template('mm/x_pin.html', error=error, media_label='Movie'), 403 if error else 200

@routes_mm.route('/mm/x', methods=['GET', 'POST'])
def mm_x():
    if request.method == 'GET' and _x_access_valid():
        return _render_media_library('local', 'x')
    error = ''
    if request.method == 'POST':
        token, error = _unlock_x(request.form.get('pin', ''))
        if token:
            if request.args.get('next') == 'update':
                return redirect(url_for('routes_mm.mm_update', database='x'))
            return _render_media_library('local', 'x')
    return render_template('mm/x_pin.html', error=error, media_label='X'), 403 if error else 200

def _render_media_library(media_source, local_kind=None):
    db_path = _media_databases()[local_kind][1] if local_kind else None
    init_db(db_path)

    conn = get_db_connection(db_path)
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
                           total_videos=total_videos,
                           media_source=media_source,
                           media_kind=local_kind,
                           media_label='X' if local_kind == 'x' else 'Movies' if local_kind == 'mov' else 'Local Video' if media_source == 'local' else 'YouTube',
                           api_base=f'/mm/api/{local_kind}' if local_kind else '/mm/api/video',
                           stream_endpoint=f'/mm/api/{local_kind}/stream' if local_kind else '',
                           route_endpoint=f'routes_mm.mm_{local_kind}' if local_kind else 'routes_mm.mm_youtube')

def _register_media_download(record, kind, path, info, db_path=None):
    duration = int(record.get('duration') or info.get('duration') or 0)
    chapter = normalize_chapter_timestamps(record.get('chapter') or '')
    if kind == 'audio':
        db_path = db_path or _mp3_database_path()
        _init_mp3_csv_database(db_path)
        conn = sqlite3.connect(db_path, timeout=5)
        try:
            conn.execute("""
                INSERT INTO tracks (path, title, artist, album, playlist, category, tag_list, chapter, duration, size_bytes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET title = excluded.title, artist = excluded.artist, album = excluded.album,
                    playlist = excluded.playlist, category = excluded.category, tag_list = excluded.tag_list,
                    chapter = excluded.chapter, duration = excluded.duration, size_bytes = excluded.size_bytes
            """, (str(path), record['title'], record['artist'], record.get('album') or '', record['playlist'], record['category'],
                  record['tag_list'] or '', chapter, duration, path.stat().st_size))
            conn.commit()
        finally:
            conn.close()
        return
    db_path = db_path or get_vdo_db_path()
    init_db(db_path)
    conn = get_db_connection(db_path)
    try:
        video_id = f"local-{hashlib.sha256(os.path.normcase(str(path)).encode('utf-8')).hexdigest()[:24]}"
        conn.execute("""
            INSERT INTO videos (video_id, url, title, artist, duration, thumbnail_url,
                                chapter, chapter_checked, playlist, category, is_new)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)
            ON CONFLICT(url) DO UPDATE SET title = excluded.title, artist = excluded.artist,
                duration = excluded.duration, thumbnail_url = excluded.thumbnail_url,
                chapter = excluded.chapter, chapter_checked = 1, playlist = excluded.playlist,
                category = excluded.category, is_new = 0
        """, (video_id, str(path), record['title'], record['artist'], duration, record['thumbnail_url'],
              chapter, record['playlist'], record['category']))
        video_row_id = conn.execute('SELECT id FROM videos WHERE url = ?', (str(path),)).fetchone()['id']
        conn.execute('DELETE FROM video_tags WHERE video_id = ?', (video_row_id,))
        for tag in dict.fromkeys(value.strip() for value in (record['tag_list'] or '').split(',') if value.strip()):
            conn.execute('INSERT OR IGNORE INTO tags (name) VALUES (?)', (tag,))
            tag_id = conn.execute('SELECT id FROM tags WHERE name = ?', (tag,)).fetchone()['id']
            conn.execute('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)', (video_row_id, tag_id))
        conn.commit()
    finally:
        conn.close()


@routes_mm.route('/mm/api/video/<int:vid_id>/download', methods=['POST'])
def api_download_video(vid_id):
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get('kind'), str) or data['kind'] not in {'audio', 'video'}:
        return jsonify({'success': False, 'error': 'Choose audio or video.'}), 400
    kind = data['kind']
    try:
        import yt_dlp
    except ImportError:
        return jsonify({'success': False, 'error': 'Install yt-dlp[default] from requirements.txt on the Flask server.'}), 503
    if any(not shutil.which(tool) for tool in ('ffmpeg', 'ffprobe', 'node')):
        return jsonify({'success': False, 'error': 'Install FFmpeg and Node.js 20+ on the Flask server, or recreate the updated Docker container.'}), 503
    conn = get_db_connection()
    try:
        row = conn.execute("""
            SELECT v.*, (SELECT GROUP_CONCAT(t.name, ',') FROM tags t
                         JOIN video_tags vt ON vt.tag_id = t.id WHERE vt.video_id = v.id) AS tag_list
            FROM videos v WHERE v.id = ?
        """, (vid_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        return jsonify({'success': False, 'error': 'Video not found.'}), 404
    record = dict(row)
    if not re.fullmatch(r'[A-Za-z0-9_-]{11}', record['video_id']):
        return jsonify({'success': False, 'error': 'The selected item is not a valid YouTube video.'}), 400
    try:
        destination = download_folder(mm_path(f'download_{kind}_root'), record['playlist'], record['category'])
        if kind == 'video' and not any(destination.is_relative_to(Path(root)) for root in get_vdo_roots()):
            return jsonify({'success': False, 'error': 'The video download root must be inside one of the configured local-media roots.'}), 400
    except (KeyError, ValueError, OSError):
        return jsonify({'success': False, 'error': 'Check the download roots in mm_config.json.'}), 400
    app = current_app._get_current_object()
    owner = session.get('download_owner') or os.urandom(24).hex()
    session['download_owner'] = owner

    def completed(path, info):
        with app.app_context():
            _register_media_download(record, kind, path, info)

    try:
        job_id = start_download(owner, record, kind, destination, completed)
    except RuntimeError as error:
        return jsonify({'success': False, 'error': str(error)}), 429
    return jsonify({'success': True, 'job_id': job_id}), 202


@routes_mm.route('/mm/api/video/download/<job_id>')
def api_download_status(job_id):
    job = download_status(job_id, session.get('download_owner'))
    if job is None:
        return jsonify({'success': False, 'error': 'Download not found for this browser session.'}), 404
    return jsonify({'success': True, **job})


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
    video_url = f"https://www.youtube.com/watch?v={vid}"

    conn = get_db_connection()
    try:
        if conn.execute("SELECT 1 FROM videos WHERE video_id = ? OR url = ?", (vid, video_url)).fetchone():
            return jsonify({'success': False, 'error': 'This video URL or ID is already in the database'}), 409
        metadata = {
            'title': 'Untitled Video',
            'artist': 'Unknown Artist',
            'duration': 0,
            'thumbnail_url': f'https://img.youtube.com/vi/{vid}/mqdefault.jpg',
            'chapter': '',
            'chapter_checked': 0,
            'is_new': 1
        }
        try:
            metadata.update(fetch_video_metadata(vid))
        except Exception as error:
            current_app.logger.warning(f'[metadata] fetch failed for {vid}: {error}')
        cur = conn.execute("""
            INSERT INTO videos (video_id, url, title, artist, duration, thumbnail_url,
                                chapter, chapter_checked, playlist, category, is_new)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (vid, video_url, metadata['title'], metadata['artist'], metadata['duration'],
              metadata['thumbnail_url'], metadata['chapter'], metadata['chapter_checked'],
              playlist, category, metadata['is_new']))
        new_id = cur.lastrowid
        for tag in tags:
            conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (tag,))
            tag_id = conn.execute("SELECT id FROM tags WHERE name = ?", (tag,)).fetchone()['id']
            conn.execute("INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)", (new_id, tag_id))
        conn.commit()
        return jsonify({'success': True, 'id': new_id, 'video_id': vid})
    finally:
        conn.close()

@routes_mm.route('/mm/api/vdo/add', methods=['POST'])
@routes_mm.route('/mm/api/mov/add', methods=['POST'])
@routes_mm.route('/mm/api/x/add', methods=['POST'])
def api_add_vdo():
    db_path = _request_media_db_path()
    init_db(db_path)
    data = request.get_json() or {}
    file_path = resolve_vdo_file((data.get('url') or '').strip())
    playlist = (data.get('playlist') or '').strip()
    if not file_path:
        return jsonify({'success': False, 'error': 'Choose an existing video file under one of the configured media roots'}), 400
    if not playlist:
        return jsonify({'success': False, 'error': 'Playlist required'}), 400

    video_id = f"local-{hashlib.sha256(os.path.normcase(file_path).encode('utf-8')).hexdigest()[:24]}"
    title = (data.get('title') or os.path.splitext(os.path.basename(file_path))[0]).strip()
    category = (data.get('category') or '').strip() or None
    tags = [tag.strip() for tag in (data.get('tags') or []) if isinstance(tag, str) and tag.strip()]
    conn = get_db_connection(db_path)
    try:
        if conn.execute("SELECT 1 FROM videos WHERE url = ? OR video_id = ?", (file_path, video_id)).fetchone():
            return jsonify({'success': False, 'error': 'This file is already in the local library'}), 409
        cursor = conn.execute("""
            INSERT INTO videos (video_id, url, title, artist, duration, playlist, category, is_new)
            VALUES (?, ?, ?, 'Local video', 0, ?, ?, 0)
        """, (video_id, file_path, title or os.path.basename(file_path), playlist, category))
        new_id = cursor.lastrowid
        for tag in tags:
            conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (tag,))
            tag_id = conn.execute("SELECT id FROM tags WHERE name = ?", (tag,)).fetchone()['id']
            conn.execute("INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)", (new_id, tag_id))
        conn.commit()
        return jsonify({'success': True, 'id': new_id, 'video_id': video_id})
    finally:
        conn.close()

@routes_mm.route('/mm/api/vdo/stream/<int:vid_id>')
@routes_mm.route('/mm/api/mov/stream/<int:vid_id>')
@routes_mm.route('/mm/api/x/stream/<int:vid_id>')
def api_vdo_stream(vid_id):
    db_path = _request_media_db_path()
    init_db(db_path)
    conn = get_db_connection(db_path)
    row = conn.execute("SELECT url FROM videos WHERE id = ?", (vid_id,)).fetchone()
    conn.close()
    file_path = resolve_vdo_file(row['url']) if row else None
    if not file_path:
        return 'File not found', 404
    return send_file(file_path, conditional=True, download_name=os.path.basename(file_path))

def _request_media_db_path():
    if request.path.startswith('/mm/api/vdo/'):
        return get_vdo_db_path()
    if request.path.startswith('/mm/api/mov/'):
        return get_mov_db_path()
    if request.path.startswith('/mm/api/x/'):
        return get_x_db_path()
    return None

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
@routes_mm.route('/mm/api/vdo/<int:vid_id>', methods=['DELETE'])
@routes_mm.route('/mm/api/mov/<int:vid_id>', methods=['DELETE'])
@routes_mm.route('/mm/api/x/<int:vid_id>', methods=['DELETE'])
def api_delete_video(vid_id):
    db_path = _request_media_db_path()
    init_db(db_path)
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM videos WHERE id = ?", (vid_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return jsonify({'success': deleted})

@routes_mm.route('/mm/api/video/<int:vid_id>/playlist', methods=['POST'])
@routes_mm.route('/mm/api/vdo/<int:vid_id>/playlist', methods=['POST'])
@routes_mm.route('/mm/api/mov/<int:vid_id>/playlist', methods=['POST'])
@routes_mm.route('/mm/api/x/<int:vid_id>/playlist', methods=['POST'])
def api_update_video_playlist(vid_id):
    db_path = _request_media_db_path()
    init_db(db_path)
    data = request.get_json() or {}
    new_playlist = data.get('playlist', '').strip()
    if not new_playlist:
        return jsonify({'success': False, 'error': 'Playlist name required'}), 400

    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("UPDATE videos SET playlist = ? WHERE id = ?", (new_playlist, vid_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'playlist': new_playlist})

@routes_mm.route('/mm/api/video/<int:vid_id>/category', methods=['POST'])
@routes_mm.route('/mm/api/vdo/<int:vid_id>/category', methods=['POST'])
@routes_mm.route('/mm/api/mov/<int:vid_id>/category', methods=['POST'])
@routes_mm.route('/mm/api/x/<int:vid_id>/category', methods=['POST'])
def api_update_video_category(vid_id):
    db_path = _request_media_db_path()
    init_db(db_path)
    data = request.get_json() or {}
    new_category = (data.get('category') or '').strip()

    conn = get_db_connection(db_path)
    conn.execute("UPDATE videos SET category = ? WHERE id = ?", (new_category or None, vid_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'category': new_category})

@routes_mm.route('/mm/api/video/<int:vid_id>/update_metadata', methods=['POST'])
@routes_mm.route('/mm/api/vdo/<int:vid_id>/update_metadata', methods=['POST'])
@routes_mm.route('/mm/api/mov/<int:vid_id>/update_metadata', methods=['POST'])
@routes_mm.route('/mm/api/x/<int:vid_id>/update_metadata', methods=['POST'])
def api_update_video_metadata(vid_id):
    db_path = _request_media_db_path()
    init_db(db_path)
    data = request.get_json() or {}
    title = data.get('title', '').strip()
    artist = data.get('artist', '').strip()
    duration = data.get('duration', 0)

    conn = get_db_connection(db_path)
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
@routes_mm.route('/mm/api/vdo/<int:vid_id>/tag', methods=['POST', 'DELETE'])
@routes_mm.route('/mm/api/mov/<int:vid_id>/tag', methods=['POST', 'DELETE'])
@routes_mm.route('/mm/api/x/<int:vid_id>/tag', methods=['POST', 'DELETE'])
def api_manage_video_tag(vid_id):
    db_path = _request_media_db_path()
    init_db(db_path)
    data = request.get_json() or {}
    tag_name = data.get('tag', '').strip()
    if not tag_name:
        return jsonify({'success': False, 'error': 'Tag name required'}), 400

    conn = get_db_connection(db_path)
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

@routes_mm.route('/mm/api/video/<int:vid_id>/chapters', methods=['POST', 'PUT'])
@routes_mm.route('/mm/api/vdo/<int:vid_id>/chapters', methods=['POST', 'PUT'])
@routes_mm.route('/mm/api/mov/<int:vid_id>/chapters', methods=['POST', 'PUT'])
@routes_mm.route('/mm/api/x/<int:vid_id>/chapters', methods=['POST', 'PUT'])
def api_video_chapters(vid_id):
    """Look up chapters once per video or save manually edited timestamps."""
    db_path = _request_media_db_path()
    is_local = db_path is not None
    init_db(db_path)
    conn = get_db_connection(db_path)
    try:
        row = conn.execute(
            "SELECT video_id, chapter, chapter_checked FROM videos WHERE id = ?", (vid_id,)
        ).fetchone()
        if not row:
            return jsonify({'success': False, 'error': 'Video not found'}), 404

        if request.method == 'PUT':
            data = request.get_json(silent=True) or {}
            chapter_text = normalize_chapter_timestamps(data.get('chapter', ''))
            conn.execute(
                "UPDATE videos SET chapter = ?, chapter_checked = 1 WHERE id = ?",
                (chapter_text, vid_id)
            )
            conn.commit()
            return jsonify({'success': True, 'chapter': chapter_text})

        if row['chapter'] or row['chapter_checked']:
            return jsonify({'success': True, 'chapter': row['chapter'] or ''})

        if is_local:
            conn.execute("UPDATE videos SET chapter_checked = 1 WHERE id = ?", (vid_id,))
            conn.commit()
            return jsonify({'success': True, 'chapter': ''})

        try:
            chapters = find_chapters(row['video_id'])
        except Exception as e:
            # not marked checked, so a temporary network/YouTube failure retries next play
            current_app.logger.warning(f"[chapters] fetch failed for {row['video_id']}: {e}")
            return jsonify({'success': False, 'error': 'Could not read video page'}), 502

        chapter_text = ' '.join(str(chapter['seconds']) for chapter in chapters)
        conn.execute("UPDATE videos SET chapter = ?, chapter_checked = 1 WHERE id = ?", (chapter_text, vid_id))
        conn.commit()
        return jsonify({'success': True, 'chapter': chapter_text})
    finally:
        conn.close()

def configure_routes_mm(app, socketio):
    app.register_blueprint(routes_mm)
    last_ended_revision = None
    remote_queue = {}

    @socketio.on('media_join')
    def media_join():
        socketio.emit('media_state', {
            'state': _display_state(_get_remote_state()),
            'command': 'sync'
        }, to=request.sid)

    @socketio.on('media_control')
    def media_control(data):
        data = data if isinstance(data, dict) else {}
        action = str(data.get('action') or '').strip().lower()
        state = _get_remote_state()
        database = str(data.get('database') or '').strip().lower() if action == 'load' else state['database_name']
        if database in {'x', 'mov'} and not _media_access_valid(database, data.get('x_token')):
            socketio.emit('media_error', {'error': 'Unlock this database with its PIN first.'}, to=request.sid)
            return

        if action == 'load':
            try:
                media_id = int(data.get('media_id'))
            except (TypeError, ValueError):
                socketio.emit('media_error', {'error': 'Choose a valid media item.'}, to=request.sid)
                return
            error = _load_remote_media(state, database, media_id)
            if error:
                socketio.emit('media_error', {'error': error}, to=request.sid)
                return
            remote_queue.clear()
            remote_queue.update(_queue_context(data.get('queue')))
        elif action in {'play', 'pause', 'seek', 'volume', 'audio_only'}:
            if not state['media_id']:
                socketio.emit('media_error', {'error': 'Select a video first.'}, to=request.sid)
                return
            if action == 'play':
                state['paused'] = 0
            elif action == 'pause':
                state['paused'] = 1
            elif action == 'audio_only':
                state['audio_only'] = int(bool(data.get('enabled')))
            elif action == 'volume':
                try:
                    volume = float(data.get('volume'))
                except (TypeError, ValueError):
                    socketio.emit('media_error', {'error': 'Volume must be a number.'}, to=request.sid)
                    return
                if not math.isfinite(volume):
                    socketio.emit('media_error', {'error': 'Volume must be finite.'}, to=request.sid)
                    return
                state['volume'] = min(100, max(0, volume))
            else:
                try:
                    position = float(data.get('position'))
                except (TypeError, ValueError):
                    socketio.emit('media_error', {'error': 'Seek position must be a number.'}, to=request.sid)
                    return
                if not math.isfinite(position):
                    socketio.emit('media_error', {'error': 'Seek position must be finite.'}, to=request.sid)
                    return
                state['position'] = max(0, position)
        else:
            socketio.emit('media_error', {'error': 'Unknown playback command.'}, to=request.sid)
            return

        _save_remote_state(state)
        socketio.emit('media_state', {'state': _display_state(state), 'command': action})

    @socketio.on('media_ended')
    def media_ended(data):
        nonlocal last_ended_revision
        data = data if isinstance(data, dict) else {}
        try:
            revision = int(data.get('revision', -1))
        except (TypeError, ValueError):
            return

        state = _get_remote_state()
        if revision != int(state['revision']) or not state['media_id']:
            return
        if last_ended_revision == revision:
            return

        last_ended_revision = revision
        # Advance on the server so it works without a remote open and never double-skips with several remotes.
        next_id = _next_queue_media_id(state['database_name'], state['media_id'], remote_queue)
        if next_id is None or _load_remote_media(state, state['database_name'], next_id):
            state['paused'] = 1
            _save_remote_state(state)
            socketio.emit('media_state', {'state': _display_state(state), 'command': 'pause'})
            return
        _save_remote_state(state)
        socketio.emit('media_state', {'state': _display_state(state), 'command': 'load'})

    @socketio.on('media_progress')
    def media_progress(data):
        data = data if isinstance(data, dict) else {}
        state = _get_remote_state()
        try:
            revision = int(data.get('revision', -1))
        except (TypeError, ValueError):
            return
        if revision != int(state['revision']) or not state['media_id']:
            return
        try:
            position = float(data.get('position'))
        except (TypeError, ValueError):
            return
        if not math.isfinite(position):
            return
        state['position'] = max(0, position)
        state['paused'] = int(bool(data.get('paused')))
        try:
            duration = float(data.get('duration') or 0)
        except (TypeError, ValueError):
            duration = 0
        if math.isfinite(duration) and duration > 0:
            state['duration'] = int(round(duration))
        _save_remote_state(state)
        socketio.emit('media_progress', {
            'position': state['position'],
            'duration': state['duration'],
            'paused': state['paused'],
            'revision': state['revision']
        })
