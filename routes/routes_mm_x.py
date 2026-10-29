import os
import sqlite3
from flask import Blueprint, url_for, render_template, request, jsonify, current_app

routes_mm_x = Blueprint('routes_mm_x', __name__)

def get_x_db_path():
    db_dir = os.path.join(current_app.root_path, 'data', 'mm')
    os.makedirs(db_dir, exist_ok=True)
    return os.path.join(db_dir, 'x.db')

def get_x_db_connection():
    conn = sqlite3.connect(get_x_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn

def init_x_db():
    conn = get_x_db_connection()
    cursor = conn.cursor()
    cursor.executescript("""
        CREATE TABLE IF NOT EXISTS videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            input_url TEXT UNIQUE NOT NULL,
            out_url TEXT NOT NULL,
            title TEXT DEFAULT 'Untitled Video',
            artist TEXT DEFAULT 'Unknown Artist',
            duration INTEGER DEFAULT 0,
            thumbnail_url TEXT,
            playlist TEXT,
            category TEXT,
            is_new INTEGER DEFAULT 1,
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

        CREATE INDEX IF NOT EXISTS idx_x_videos_playlist ON videos(playlist);
        CREATE INDEX IF NOT EXISTS idx_x_videos_created ON videos(id DESC);
    """)

    cursor.execute("PRAGMA table_info(videos)")
    cols = [row[1] for row in cursor.fetchall()]
    if 'playlist' not in cols:
        cursor.execute("ALTER TABLE videos ADD COLUMN playlist TEXT")
    if 'category' not in cols:
        cursor.execute("ALTER TABLE videos ADD COLUMN category TEXT")

    conn.commit()
    conn.close()


@routes_mm_x.route('/mm/x')
def mm_x():
    init_x_db()

    conn = get_x_db_connection()
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

    # Categories
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

    cursor.execute("""
        SELECT DISTINCT category FROM videos
        WHERE category IS NOT NULL AND TRIM(category) != ''
        ORDER BY category COLLATE NOCASE
    """)
    all_categories = [row[0] for row in cursor.fetchall()]

    # 2. Fetch tags belonging to this playlist/category
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

    return render_template('mm/x.html',
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


@routes_mm_x.route('/mm/api/x/video/add', methods=['POST'])
def api_add_x_video():
    init_x_db()
    data = request.get_json() or {}
    input_url = (data.get('input_url') or '').strip()
    out_url = (data.get('out_url') or '').strip()
    playlist = (data.get('playlist') or '').strip()

    if not input_url or not out_url:
        return jsonify({'success': False, 'error': 'input_url and out_url are required'}), 400
    if not playlist:
        return jsonify({'success': False, 'error': 'Playlist required'}), 400

    title = (data.get('title') or 'Untitled Video').strip()
    category = (data.get('category') or '').strip() or None
    tags = [t.strip() for t in (data.get('tags') or []) if isinstance(t, str) and t.strip()]

    conn = get_x_db_connection()
    try:
        if conn.execute("SELECT 1 FROM videos WHERE input_url = ?", (input_url,)).fetchone():
            return jsonify({'success': False, 'error': 'This video input URL already exists'}), 409

        cur = conn.execute("""
            INSERT INTO videos (input_url, out_url, title, playlist, category, is_new)
            VALUES (?, ?, ?, ?, ?, 1)
        """, (input_url, out_url, title, playlist, category))
        new_id = cur.lastrowid

        for tag in tags:
            conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (tag,))
            tag_id = conn.execute("SELECT id FROM tags WHERE name = ?", (tag,)).fetchone()['id']
            conn.execute("INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)", (new_id, tag_id))

        conn.commit()
        return jsonify({'success': True, 'id': new_id})
    finally:
        conn.close()


@routes_mm_x.route('/mm/api/x/video/<int:vid_id>', methods=['DELETE'])
def api_delete_x_video(vid_id):
    init_x_db()
    conn = get_x_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM videos WHERE id = ?", (vid_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return jsonify({'success': deleted})


@routes_mm_x.route('/mm/api/x/video/<int:vid_id>/playlist', methods=['POST'])
def api_update_x_video_playlist(vid_id):
    init_x_db()
    data = request.get_json() or {}
    new_playlist = data.get('playlist', '').strip()
    if not new_playlist:
        return jsonify({'success': False, 'error': 'Playlist name required'}), 400

    conn = get_x_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE videos SET playlist = ? WHERE id = ?", (new_playlist, vid_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'playlist': new_playlist})


@routes_mm_x.route('/mm/api/x/video/<int:vid_id>/category', methods=['POST'])
def api_update_x_video_category(vid_id):
    init_x_db()
    data = request.get_json() or {}
    new_category = (data.get('category') or '').strip()

    conn = get_x_db_connection()
    conn.execute("UPDATE videos SET category = ? WHERE id = ?", (new_category or None, vid_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'category': new_category})


@routes_mm_x.route('/mm/api/x/video/<int:vid_id>/update_metadata', methods=['POST'])
def api_update_x_video_metadata(vid_id):
    init_x_db()
    data = request.get_json() or {}
    title = data.get('title', '').strip()
    artist = data.get('artist', '').strip()
    duration = data.get('duration', 0)

    conn = get_x_db_connection()
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


@routes_mm_x.route('/mm/api/x/video/<int:vid_id>/tag', methods=['POST', 'DELETE'])
def api_manage_x_video_tag(vid_id):
    init_x_db()
    data = request.get_json() or {}
    tag_name = data.get('tag', '').strip()
    if not tag_name:
        return jsonify({'success': False, 'error': 'Tag name required'}), 400

    conn = get_x_db_connection()
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
    
@routes_mm_x.route('/mm/api/x/video/upload', methods=['POST'])
def api_upload_x_links():
    init_x_db()
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No file uploaded'}), 400
    
    file = request.files['file']
    if not file or file.filename == '':
        return jsonify({'success': False, 'error': 'Empty file filename'}), 400

    playlist = request.form.get('playlist', 'Default').strip()
    category = request.form.get('category', '').strip() or None

    added_count = 0
    duplicate_count = 0

    conn = get_x_db_connection()
    try:
        # Read lines from the uploaded text file
        lines = file.read().decode('utf-8', errors='ignore').splitlines()
        for line in lines:
            input_url = line.strip()
            # Skip empty lines or comments
            if not input_url or input_url.startswith('#'):
                continue
            
            # Check for duplicate input_url
            existing = conn.execute("SELECT 1 FROM videos WHERE input_url = ?", (input_url,)).fetchone()
            if existing:
                duplicate_count += 1
                continue

            # Insert new link (default out_url to input_url if not specified)
            conn.execute("""
                INSERT INTO videos (input_url, out_url, title, playlist, category, is_new)
                VALUES (?, ?, ?, ?, ?, 1)
            """, (input_url, input_url, f"Stream {input_url.split('/')[-1]}", playlist, category))
            added_count += 1

        conn.commit()
        return jsonify({
            'success': True, 
            'added': added_count, 
            'duplicates': duplicate_count
        })
    except Exception as e:
        conn.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        conn.close()

def configure_routes_mm_x(app):
    app.register_blueprint(routes_mm_x)