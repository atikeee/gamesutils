import hashlib
import os
import re
import shutil
import urllib.parse
from pathlib import Path
from flask import Blueprint, current_app, jsonify, render_template, request, session
from routes.media_chapters import normalize_chapter_timestamps
from routes.media_downloads import download_folder, start_batch_download
from routes.mm_config import load_mm_config, mm_db_path, mm_path
from routes.routes_mm import _register_media_download, extract_video_id, get_db_connection, get_vdo_roots, init_db

routes_mm_download = Blueprint('routes_mm_download', __name__)

YOUTUBE_ID = re.compile(r'[A-Za-z0-9_-]{11}')
PLAYLIST_ID = re.compile(r'[A-Za-z0-9_-]{10,64}')
MEDIA_ID = re.compile(r'[A-Za-z0-9_.-]{1,64}')
UNAVAILABLE_TITLES = {'[Private video]', '[Deleted video]'}
TEXT_LIMITS = {'title': 300, 'artist': 200, 'album': 200, 'playlist': 120,
               'category': 120, 'tag_list': 500, 'chapter': 2000}
MAX_ROWS = 500
MAX_URL = 2000


def _download_sites():
    sites = load_mm_config().get('download_sites')
    return {name: site for name, site in sites.items() if isinstance(site, dict)} if isinstance(sites, dict) else {}


def _site_label(name):
    return str(_download_sites().get(name, {}).get('label') or name.title())


def _site_modes(name):
    site = _download_sites().get(name, {})
    return [kind for kind in ('audio', 'video') if isinstance(site.get(kind), dict)]


def _site_for(url):
    parsed = urllib.parse.urlsplit(url)
    host = (parsed.hostname or '').lower()
    if parsed.scheme not in {'http', 'https'} or not host:
        return None
    return next((name for name, site in _download_sites().items()
                 if host in {str(value).lower() for value in site.get('hosts') or []}), None)


def _source(url):
    url = url.strip()
    site = _site_for(url)
    if site != 'youtube':
        return (site, url) if site else None
    parsed = urllib.parse.urlsplit(url)
    playlist_id = next(iter(urllib.parse.parse_qs(parsed.query).get('list', [])), '')
    if PLAYLIST_ID.fullmatch(playlist_id):
        return site, f'https://www.youtube.com/playlist?list={playlist_id}'
    shorts = re.match(r'/shorts/([A-Za-z0-9_-]{11})', parsed.path)
    video_id = shorts.group(1) if shorts else extract_video_id(url)
    if video_id and YOUTUBE_ID.fullmatch(video_id):
        return site, f'https://www.youtube.com/watch?v={video_id}'
    return None


def _https(value):
    return isinstance(value, str) and len(value) <= MAX_URL and urllib.parse.urlsplit(value).scheme == 'https'


def _row(entry, playlist, site):
    if entry.get('title') in UNAVAILABLE_TITLES:
        return None
    media_id = str(entry.get('id') or '')
    if site == 'youtube':
        if not YOUTUBE_ID.fullmatch(media_id):
            return None
        url = f'https://www.youtube.com/watch?v={media_id}'
        thumbnail = f'https://img.youtube.com/vi/{media_id}/mqdefault.jpg'
    else:
        url = str(entry.get('webpage_url') or entry.get('url') or '')
        if len(url) > MAX_URL or _site_for(url) != site:
            return None
        if not MEDIA_ID.fullmatch(media_id):
            media_id = hashlib.sha256(url.encode('utf-8')).hexdigest()[:16]
        candidates = [entry.get('thumbnail')] + [item.get('url') for item in reversed(entry.get('thumbnails') or [])
                                                 if isinstance(item, dict)]
        thumbnail = next((value for value in candidates if _https(value)), '')
    chapters = entry.get('chapters') or []
    return {
        'site': site,
        'video_id': media_id,
        'url': url,
        'title': (entry.get('title') or 'Untitled Video')[:TEXT_LIMITS['title']],
        'artist': (entry.get('channel') or entry.get('uploader') or 'Unknown Artist')[:TEXT_LIMITS['artist']],
        'album': playlist,
        'duration': max(0, int(entry.get('duration') or 0)),
        'thumbnail_url': thumbnail,
        'playlist': playlist,
        'category': '',
        'tag_list': '',
        'chapter': normalize_chapter_timestamps(' '.join(
            str(int(chapter['start_time'])) for chapter in chapters if chapter.get('start_time') is not None)),
    }


def _clean_row(row):
    if not isinstance(row, dict) or not isinstance(row.get('url'), str) or len(row['url']) > MAX_URL:
        return None
    source = _source(row['url'])
    if not source:
        return None
    site, url = source
    if site == 'youtube':
        if '/watch?v=' not in url:
            return None
        media_id = url.rsplit('=', 1)[1]
        thumbnail = f'https://img.youtube.com/vi/{media_id}/mqdefault.jpg'
    else:
        media_id = row.get('video_id')
        if not isinstance(media_id, str) or not MEDIA_ID.fullmatch(media_id):
            return None
        thumbnail = row.get('thumbnail_url') if _https(row.get('thumbnail_url')) else ''
    record = {'site': site, 'video_id': media_id, 'source_url': url, 'thumbnail_url': thumbnail}
    for field, limit in TEXT_LIMITS.items():
        value = row.get(field, '')
        if not isinstance(value, str) or len(value) > limit:
            return None
        record[field] = value.strip()
    record['chapter'] = normalize_chapter_timestamps(record['chapter'])
    record['title'] = record['title'] or 'Untitled Video'
    record['artist'] = record['artist'] or 'Unknown Artist'
    record['playlist'] = record['playlist'] or _site_label(site)
    duration = row.get('duration', 0)
    record['duration'] = duration if type(duration) is int and duration >= 0 else 0
    return record


@routes_mm_download.route('/mm/download')
def mm_download():
    return render_template('mm/download.html', sites=[_site_label(name) for name in _download_sites()])


@routes_mm_download.route('/mm/api/download/process', methods=['POST'])
def api_download_process():
    data = request.get_json(silent=True)
    sites = ', '.join(_site_label(name) for name in _download_sites()) or 'none configured'
    if not isinstance(data, dict) or not isinstance(data.get('url'), str) or len(data['url']) > MAX_ROWS * (MAX_URL + 2):
        return jsonify({'success': False, 'error': f'Enter video or playlist links ({sites}).'}), 400
    lines = [(number, line.strip()) for number, line in enumerate(data['url'].splitlines(), 1) if line.strip()]
    if not lines or len(lines) > MAX_ROWS:
        return jsonify({'success': False, 'error': f'Enter between 1 and {MAX_ROWS} links, one per line.'}), 400
    sources = {}
    for number, value in lines:
        try:
            source = _source(value) if len(value) <= MAX_URL else None
        except ValueError:
            source = None
        if not source:
            return jsonify({'success': False, 'error': f'Line {number}: enter a valid video or playlist link ({sites}).'}), 400
        site, url = source
        if not _site_modes(site):
            return jsonify({'success': False, 'error': f'{_site_label(site)} has no audio or video download configured.'}), 400
        sources.setdefault(source, number)
    modes = [kind for kind in ('audio', 'video') if all(kind in _site_modes(site) for site, url in sources)]
    if not modes:
        return jsonify({'success': False, 'error': 'These links have no common audio or video download mode. Process them separately.'}), 400
    try:
        from yt_dlp import YoutubeDL
        from yt_dlp.utils import DownloadError
    except ImportError:
        return jsonify({'success': False, 'error': 'Install yt-dlp[default] from requirements.txt on the Flask server.'}), 503
    options = {'quiet': True, 'skip_download': True, 'socket_timeout': 20, 'retries': 1, 'noplaylist': True,
               'extract_flat': 'in_playlist', 'playlistend': MAX_ROWS, 'js_runtimes': {'node': {}}}
    combined_rows = {}
    try:
        with YoutubeDL(options) as extractor:
            for (site, url), number in sources.items():
                info = extractor.extract_info(url, download=False)
                if info.get('_type') in {'playlist', 'multi_video'}:
                    kind = 'playlist'
                    playlist = (info.get('title') or _site_label(site))[:TEXT_LIMITS['playlist']]
                    entries = list(info.get('entries') or [])
                else:
                    kind, playlist, entries = 'video', _site_label(site), [info]
                for entry in entries[:MAX_ROWS]:
                    row = _row(entry, playlist, site) if isinstance(entry, dict) else None
                    if row:
                        combined_rows.setdefault(row['url'], row)
                if len(combined_rows) > MAX_ROWS:
                    return jsonify({'success': False, 'error': f'Too many videos. Process at most {MAX_ROWS} rows at a time.'}), 400
    except DownloadError as error:
        return jsonify({'success': False, 'error': f"Line {number}: {str(error).replace('ERROR: ', '')[:300]}"}), 400
    rows = list(combined_rows.values())
    if not rows:
        return jsonify({'success': False, 'error': 'No downloadable videos were found.'}), 404
    labels = ', '.join(dict.fromkeys(_site_label(site) for site, url in sources))
    return jsonify({'success': True, 'source': kind if len(sources) == 1 else 'batch', 'site': labels, 'modes': modes,
                    'playlist': playlist if len(sources) == 1 else '', 'rows': rows})


@routes_mm_download.route('/mm/api/download/add', methods=['POST'])
def api_download_add():
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get('rows'), list):
        return jsonify({'success': False, 'error': 'Invalid add links request.'}), 400
    if not data['rows'] or len(data['rows']) > MAX_ROWS:
        return jsonify({'success': False, 'error': f'Choose between 1 and {MAX_ROWS} rows.'}), 400
    records = []
    results = []
    for index, row in enumerate(data['rows']):
        try:
            source = _source(row['url']) if isinstance(row, dict) and isinstance(row.get('url'), str) and len(row['url']) <= MAX_URL else None
        except ValueError:
            source = None
        if not source:
            return jsonify({'success': False, 'error': f'Row {index + 1} has an invalid URL.'}), 400
        if source[0] != 'youtube':
            results.append({'status': 'skipped', 'message': 'Skipped: not a YouTube link.'})
            continue
        record = _clean_row(row)
        if record is None:
            return jsonify({'success': False, 'error': f'Row {index + 1} contains invalid values.'}), 400
        records.append((index, record))
        results.append(None)
    if not records:
        return jsonify({'success': False, 'error': 'Select at least one YouTube link to add.'}), 400

    init_db()
    conn = get_db_connection()
    added = 0
    existing = 0
    try:
        for index, record in records:
            cursor = conn.execute("""
                INSERT OR IGNORE INTO videos (video_id, url, title, artist, duration, thumbnail_url,
                                              chapter, chapter_checked, playlist, category, is_new)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            """, (record['video_id'], record['source_url'], record['title'], record['artist'],
                  record['duration'], record['thumbnail_url'], record['chapter'], int(bool(record['chapter'])),
                  record['playlist'], record['category'] or None))
            if not cursor.rowcount:
                existing += 1
                results[index] = {'status': 'complete', 'message': 'Already in YouTube database.'}
                continue
            media_id = cursor.lastrowid
            for tag in dict.fromkeys(value.strip() for value in record['tag_list'].split(',') if value.strip()):
                conn.execute('INSERT OR IGNORE INTO tags (name) VALUES (?)', (tag,))
                tag_id = conn.execute('SELECT id FROM tags WHERE name = ?', (tag,)).fetchone()['id']
                conn.execute('INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)', (media_id, tag_id))
            added += 1
            results[index] = {'status': 'complete', 'message': 'Added to YouTube database.'}
        conn.commit()
    finally:
        conn.close()
    return jsonify({'success': True, 'added': added, 'existing': existing,
                    'skipped': len(results) - len(records), 'items': results})


@routes_mm_download.route('/mm/api/download/start', methods=['POST'])
def api_download_start():
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get('audio'), bool) or not isinstance(data.get('rows'), list):
        return jsonify({'success': False, 'error': 'Invalid download request.'}), 400
    if not data['rows'] or len(data['rows']) > MAX_ROWS:
        return jsonify({'success': False, 'error': f'Choose between 1 and {MAX_ROWS} rows.'}), 400
    records = [_clean_row(row) for row in data['rows']]
    if any(record is None for record in records):
        return jsonify({'success': False, 'error': 'One or more rows contain invalid values.'}), 400
    if len({record['source_url'] for record in records}) != len(records):
        return jsonify({'success': False, 'error': 'Each video can only appear once.'}), 400
    kind = 'audio' if data['audio'] else 'video'
    blocked = sorted({_site_label(record['site']) for record in records if kind not in _site_modes(record['site'])})
    if blocked:
        return jsonify({'success': False, 'error': f"{', '.join(blocked)} does not allow {kind} downloads."}), 400
    try:
        import yt_dlp  # noqa: F401
    except ImportError:
        return jsonify({'success': False, 'error': 'Install yt-dlp[default] from requirements.txt on the Flask server.'}), 503
    if any(not shutil.which(tool) for tool in ('ffmpeg', 'ffprobe', 'node')):
        return jsonify({'success': False, 'error': 'Install FFmpeg and Node.js 20+ on the Flask server.'}), 503
    sites = _download_sites()
    try:
        vdo_roots = [Path(value) for value in get_vdo_roots()] if kind == 'video' else []
        items = []
        for record in records:
            target = sites[record['site']][kind]
            record['database_path'] = mm_db_path(target['database'])
            destination = download_folder(mm_path(target['root']), record['playlist'], record['category'])
            if kind == 'video' and not any(destination.is_relative_to(root) for root in vdo_roots):
                return jsonify({'success': False, 'error': 'The video download root must be inside one of the configured local-media roots.'}), 400
            items.append((record, destination))
    except (KeyError, TypeError, ValueError, OSError):
        return jsonify({'success': False, 'error': 'Check download_sites and paths in mm_config.json.'}), 400
    app = current_app._get_current_object()
    owner = session.get('download_owner') or os.urandom(24).hex()
    session['download_owner'] = owner

    def completed(record, path, info):
        with app.app_context():
            _register_media_download(record, kind, path, info, record['database_path'])

    try:
        job_id = start_batch_download(owner, items, kind, completed)
    except RuntimeError as error:
        return jsonify({'success': False, 'error': str(error)}), 429
    return jsonify({'success': True, 'job_id': job_id}), 202


def configure_routes_mm_download(app):
    app.register_blueprint(routes_mm_download)
