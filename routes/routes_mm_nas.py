import os
import sqlite3
from flask import Blueprint, url_for, render_template, request, jsonify, current_app, send_file, session, redirect

routes_mm_nas = Blueprint('routes_mm_nas', __name__)

VIDEO_EXTENSIONS = ('.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.ts')
PRIVATE_PIN = "9806"

def get_nas_db_path(is_private=False):
    db_dir = os.path.join(current_app.root_path, 'data', 'mm')
    os.makedirs(db_dir, exist_ok=True)
    filename = 'x_nas.db' if is_private else 'nas.db'
    return os.path.join(db_dir, filename)

def get_nas_db_connection(is_private=False):
    conn = sqlite3.connect(get_nas_db_path(is_private), timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    return conn
    
def init_nas_db(is_private=False):
    conn = get_nas_db_connection(is_private)
    cursor = conn.cursor()
    cursor.executescript("""
        CREATE TABLE IF NOT EXISTS nas_videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            folder TEXT DEFAULT 'Root',
            file_size INTEGER DEFAULT 0,
            playlist TEXT DEFAULT 'Local NAS',
            category TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS nas_tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        );
        CREATE TABLE IF NOT EXISTS nas_video_tags (
            video_id INTEGER,
            tag_id INTEGER,
            PRIMARY KEY (video_id, tag_id),
            FOREIGN KEY (video_id) REFERENCES nas_videos(id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES nas_tags(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_nas_playlist ON nas_videos(playlist);
        CREATE INDEX IF NOT EXISTS idx_nas_category ON nas_videos(category);
    """)
    try:
        cursor.execute("ALTER TABLE nas_videos ADD COLUMN category TEXT DEFAULT ''")
        conn.commit()
    except sqlite3.OperationalError:
        pass
    conn.close()

def get_video_tags(conn, video_id):
    cursor = conn.cursor()
    cursor.execute("""
        SELECT t.name FROM nas_tags t
        JOIN nas_video_tags vt ON t.id = vt.tag_id
        WHERE vt.video_id = ?
    """, (video_id,))
    return [row[0] for row in cursor.fetchall()]

def handle_nas_page(is_private=False):
    init_nas_db(is_private)
    conn = get_nas_db_connection(is_private)
    cursor = conn.cursor()

    cursor.execute("SELECT DISTINCT playlist FROM nas_videos ORDER BY playlist ASC")
    all_playlists = [row[0] for row in cursor.fetchall()]
    if not all_playlists:
        all_playlists = ['Local NAS']

    req_playlist = request.args.get('playlist', '').strip()
    selected_playlist = req_playlist if req_playlist in all_playlists else all_playlists[0]

    cursor.execute("SELECT DISTINCT category FROM nas_videos WHERE playlist = ? ORDER BY category ASC", (selected_playlist,))
    all_categories = [row[0] for row in cursor.fetchall() if row[0] is not None]

    req_category = request.args.get('category', '').strip()
    selected_category = req_category

    if selected_category:
        cursor.execute("""
            SELECT DISTINCT t.name FROM nas_tags t
            JOIN nas_video_tags vt ON t.id = vt.tag_id
            JOIN nas_videos v ON vt.video_id = v.id
            WHERE v.playlist = ? AND v.category = ?
            ORDER BY t.name ASC
        """, (selected_playlist, selected_category))
    else:
        cursor.execute("""
            SELECT DISTINCT t.name FROM nas_tags t
            JOIN nas_video_tags vt ON t.id = vt.tag_id
            JOIN nas_videos v ON vt.video_id = v.id
            WHERE v.playlist = ?
            ORDER BY t.name ASC
        """, (selected_playlist,))
    all_tags = [row[0] for row in cursor.fetchall()]

    req_tags_str = request.args.get('tags', '').strip()
    selected_tags = [t.strip() for t in req_tags_str.split(',') if t.strip()]

    page = max(1, request.args.get('page', 1, type=int))
    per_page = 15
    offset = (page - 1) * per_page

    base_query = "FROM nas_videos v WHERE v.playlist = ?"
    params = [selected_playlist]

    if selected_category:
        base_query += " AND v.category = ?"
        params.append(selected_category)

    if selected_tags:
        placeholders = ','.join(['?'] * len(selected_tags))
        count_tags = len(selected_tags)
        query_sql = f"""
            SELECT v.id, v.title, v.folder, v.file_path, v.playlist, v.category
            {base_query} AND v.id IN (
                SELECT vt.video_id FROM nas_video_tags vt
                JOIN nas_tags t ON vt.tag_id = t.id
                WHERE t.name IN ({placeholders})
                GROUP BY vt.video_id
                HAVING COUNT(DISTINCT t.name) = ?
            )
            ORDER BY v.id DESC LIMIT ? OFFSET ?
        """
        count_sql = f"""
            SELECT COUNT(v.id)
            {base_query} AND v.id IN (
                SELECT vt.video_id FROM nas_video_tags vt
                JOIN nas_tags t ON vt.tag_id = t.id
                WHERE t.name IN ({placeholders})
                GROUP BY vt.video_id
                HAVING COUNT(DISTINCT t.name) = ?
            )
        """
        cursor.execute(count_sql, params + selected_tags + [count_tags])
        total_videos = cursor.fetchone()[0]
        cursor.execute(query_sql, params + selected_tags + [count_tags, per_page, offset])
    else:
        cursor.execute(f"SELECT COUNT(*) {base_query}", params)
        total_videos = cursor.fetchone()[0]
        cursor.execute(f"""
            SELECT id, title, folder, file_path, playlist, category
            {base_query}
            ORDER BY id DESC LIMIT ? OFFSET ?
        """, params + [per_page, offset])

    videos_raw = cursor.fetchall()
    videos = []
    for row in videos_raw:
        v_dict = dict(row)
        v_dict['tags'] = get_video_tags(conn, v_dict['id'])
        videos.append(v_dict)

    conn.close()
    total_pages = max(1, (total_videos + per_page - 1) // per_page)

    return render_template('mm/nas.html',
                           videos=videos,
                           all_playlists=all_playlists,
                           all_categories=all_categories,
                           all_tags=all_tags,
                           selected_playlist=selected_playlist,
                           selected_category=selected_category,
                           selected_tags=selected_tags,
                           page=page,
                           total_pages=total_pages,
                           total_videos=total_videos,
                           is_private=is_private)

@routes_mm_nas.route('/mm/nas')
def mm_nas_public():
    return handle_nas_page(is_private=False)

@routes_mm_nas.route('/mm/nas/x')
def mm_nas_x():
    # If it's a fresh browser load (not an internal pagination/filter click with active token), require PIN
    # We use a session flag that expires or explicitly clear it if desired. 
    # To enforce PIN *every single time* someone navigates to /mm/nas/x from outside:
    if not session.get('nas_x_unlocked'):
        return render_template('mm/nas_login.html')
    
    # Optional: If you want it to lock every time you close/re-open the tab, 
    # comment out the line below. Keeping it allows pagination/filtering without re-typing PIN.
    return handle_nas_page(is_private=True)

@routes_mm_nas.route('/mm/api/nas/auth', methods=['POST'])
def api_nas_auth():
    data = request.get_json() or {}
    entered_pin = data.get('pin', '').strip()
    if entered_pin == PRIVATE_PIN:
        session['nas_x_unlocked'] = True
        return jsonify({'success': True})
    else:
        return jsonify({'success': False, 'error': 'Incorrect PIN'}), 401

@routes_mm_nas.route('/mm/api/nas/logout')
def nas_logout():
    session.pop('nas_x_unlocked', None)
    return redirect(url_for('routes_mm_nas.mm_nas_public'))

@routes_mm_nas.route('/mm/api/nas/update/<int:vid_id>', methods=['POST'])
def api_update_nas_video(vid_id):
    is_private = request.args.get('private', '0') == '1'
    if is_private and not session.get('nas_x_unlocked'):
        return jsonify({'success': False, 'error': 'Unauthorized'}), 403

    init_nas_db(is_private)
    data = request.get_json() or {}
    new_playlist = data.get('playlist', 'Local NAS').strip()
    new_category = data.get('category', '').strip()
    raw_tags = data.get('tags', [])

    if isinstance(raw_tags, str):
        tags = [t.strip() for t in raw_tags.split(',') if t.strip()]
    else:
        tags = [str(t).strip() for t in raw_tags if str(t).strip()]

    conn = get_nas_db_connection(is_private)
    try:
        conn.execute("UPDATE nas_videos SET playlist = ?, category = ? WHERE id = ?", (new_playlist, new_category, vid_id))
        conn.execute("DELETE FROM nas_video_tags WHERE video_id = ?", (vid_id,))
        for tag_name in tags:
            conn.execute("INSERT OR IGNORE INTO nas_tags (name) VALUES (?)", (tag_name,))
            tag_row = conn.execute("SELECT id FROM nas_tags WHERE name = ?", (tag_name,)).fetchone()
            if tag_row:
                tag_id = tag_row[0]
                conn.execute("INSERT OR IGNORE INTO nas_video_tags (video_id, tag_id) VALUES (?, ?)", (vid_id, tag_id))
        conn.commit()
        return jsonify({'success': True, 'tags': tags, 'playlist': new_playlist, 'category': new_category})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        conn.close()

@routes_mm_nas.route('/mm/api/nas/scan', methods=['POST'])
def api_scan_nas():
    is_private = request.args.get('private', '0') == '1'
    if is_private and not session.get('nas_x_unlocked'):
        return jsonify({'success': False, 'error': 'Unauthorized'}), 403

    init_nas_db(is_private)
    data = request.get_json() or {}
    scan_path = data.get('path', '').strip().strip('"\'')
    playlist_name = data.get('playlist', 'Local NAS').strip()
    category_name = data.get('category', '').strip()

    if not scan_path or not os.path.exists(scan_path):
        return jsonify({'success': False, 'error': f"Path not found: '{scan_path}'."}), 400

    added = 0
    conn = get_nas_db_connection(is_private)
    try:
        for root, dirs, files in os.walk(scan_path):
            for file in files:
                if file.lower().endswith(VIDEO_EXTENSIONS):
                    full_path = os.path.abspath(os.path.join(root, file))
                    title = os.path.splitext(file)[0]
                    folder = os.path.basename(root)
                    size = os.path.getsize(full_path)

                    existing = conn.execute("SELECT 1 FROM nas_videos WHERE file_path = ?", (full_path,)).fetchone()
                    if not existing:
                        conn.execute("""
                            INSERT INTO nas_videos (file_path, title, folder, file_size, playlist, category)
                            VALUES (?, ?, ?, ?, ?, ?)
                        """, (full_path, title, folder, size, playlist_name, category_name))
                        added += 1
        conn.commit()
        return jsonify({'success': True, 'added': added})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        conn.close()

@routes_mm_nas.route('/mm/api/nas/stream/<int:vid_id>')
def api_stream_nas_video(vid_id):
    is_private = request.args.get('private', '0') == '1'
    if is_private and not session.get('nas_x_unlocked'):
        return "Unauthorized", 403

    init_nas_db(is_private)
    conn = get_nas_db_connection(is_private)
    row = conn.execute("SELECT file_path FROM nas_videos WHERE id = ?", (vid_id,)).fetchone()
    conn.close()

    if not row or not os.path.exists(row['file_path']):
        return "File not found", 404

    return send_file(row['file_path'], conditional=True)

@routes_mm_nas.route('/mm/api/nas/video/<int:vid_id>', methods=['DELETE'])
def api_delete_nas_video(vid_id):
    is_private = request.args.get('private', '0') == '1'
    if is_private and not session.get('nas_x_unlocked'):
        return jsonify({'success': False, 'error': 'Unauthorized'}), 403

    init_nas_db(is_private)
    conn = get_nas_db_connection(is_private)
    conn.execute("DELETE FROM nas_videos WHERE id = ?", (vid_id,))
    conn.commit()
    conn.close()
    return jsonify({'success': True})

def configure_routes_mm_nas(app):
    app.register_blueprint(routes_mm_nas)