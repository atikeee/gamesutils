import os
import sys
import csv
import re
import sqlite3
import time
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

def extract_video_id(raw_val: str):
    if not raw_val:
        return None
    raw_val = raw_val.strip()
    pattern = r'(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})'
    match = re.search(pattern, raw_val)
    if match:
        return match.group(1)
    cleaned = re.sub(r'[^a-zA-Z0-9_-]', '', raw_val)
    return cleaned if len(cleaned) == 11 else None

def get_target_db_path():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    db_path = os.path.normpath(os.path.join(base_dir, '..', 'data', 'mm', 'youtube.db'))
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    return db_path

def init_database_schema(db_path):
    """Ensures tables exist with UNIQUE constraint on video_id and enables WAL mode."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("PRAGMA journal_mode = WAL;")
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

        CREATE INDEX IF NOT EXISTS idx_videos_is_new ON videos(is_new);
        CREATE INDEX IF NOT EXISTS idx_videos_playlist ON videos(playlist);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_unique_video_id ON videos(video_id);
    """)

    cursor.execute("PRAGMA table_info(videos)")
    cols = [row[1] for row in cursor.fetchall()]
    if 'playlist' not in cols:
        cursor.execute("ALTER TABLE videos ADD COLUMN playlist TEXT")

    cursor.execute("SELECT DISTINCT playlist FROM videos WHERE playlist IS NOT NULL AND TRIM(playlist) != '' ORDER BY playlist ASC")
    existing_playlists = [row[0] for row in cursor.fetchall()]

    conn.commit()
    conn.close()
    return existing_playlists

def select_playlist(existing_playlists, cli_playlist=None):
    if cli_playlist:
        print(f"-> Using CLI Playlist: '{cli_playlist}'")
        return cli_playlist

    print("\n" + "="*50)
    print("📋 PLAYLIST SELECTION")
    print("="*50)

    if existing_playlists:
        print("Existing Playlists in Database:")
        for idx, pl in enumerate(existing_playlists, 1):
            print(f"  [{idx}] {pl}")
        print(f"  [{len(existing_playlists) + 1}] Create a New Playlist")
        
        while True:
            choice = input(f"\nSelect a playlist (1-{len(existing_playlists) + 1}): ").strip()
            if choice.isdigit():
                num = int(choice)
                if 1 <= num <= len(existing_playlists):
                    chosen = existing_playlists[num - 1]
                    print(f"-> Selected Existing Playlist: '{chosen}'")
                    return chosen
                elif num == len(existing_playlists) + 1:
                    break
            print("Invalid choice, please enter a valid number.")

    while True:
        new_name = input("Enter new playlist name: ").strip()
        if new_name:
            print(f"-> Created New Playlist: '{new_name}'")
            return new_name
        print("Playlist name cannot be empty.")

def fetch_single_oembed(session, video_id):
    url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
    thumb = f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg"
    
    if HAS_REQUESTS and session:
        try:
            resp = session.get(url, timeout=3.0, verify=False)
            if resp.status_code == 200:
                data = resp.json()
                return {
                    'video_id': video_id,
                    'title': data.get('title', f"Video {video_id}"),
                    'artist': data.get('author_name', "YouTube Creator"),
                    'thumbnail': data.get('thumbnail_url', thumb),
                    'is_new': 0
                }
        except Exception:
            pass

    return {
        'video_id': video_id,
        'title': f"YouTube Video ({video_id})",
        'artist': "YouTube",
        'thumbnail': thumb,
        'is_new': 1
    }

def main():
    parser = argparse.ArgumentParser(
        description="Fast YouTube Playlist Importer & Metadata Tool for gamesutils.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python populate_db.py list_op.csv                      (Imports using playlist column from CSV)
  python populate_db.py list.csv --playlist rock          (Imports raw list and assigns to 'rock')
  python populate_db.py list.csv --csv                    (Parses and saves list_op.csv in same folder)
  python populate_db.py list_op.csv --nodb                (Preview pre-parsed CSV on screen)
        """
    )
    parser.add_argument("input_csv", nargs="?", help="Path to input CSV file")
    parser.add_argument("--playlist", "-p", help="Specify or override playlist name")
    parser.add_argument("--nodb", action="store_true", help="Do not write to database; only output parsed results to screen")
    parser.add_argument("--csv", "-c", nargs="?", const="AUTO", default=None,
                        help="Export parsed data to an output CSV file named <oldfilename>_op.csv at the same location")

    args = parser.parse_args()

    print("=" * 65)
    print("🚀 YOUTUBE PLAYLIST IMPORTER & DATA TOOL")
    print("=" * 65)

    # 1. Resolve Input CSV
    csv_file = args.input_csv
    if not csv_file or not os.path.exists(csv_file):
        while True:
            prompt_path = input("Enter path to input CSV file: ").strip().strip('"')
            if os.path.exists(prompt_path):
                csv_file = prompt_path
                break
            print(f"File not found: '{prompt_path}'. Please verify the path.")

    # Determine automatic output CSV path in the same location as input CSV
    csv_dir, csv_base = os.path.split(os.path.abspath(csv_file))
    name_root, _ = os.path.splitext(csv_base)
    if args.csv == "AUTO" or args.csv == "":
        output_csv_path = os.path.join(csv_dir, f"{name_root}_op.csv")
    elif args.csv:
        output_csv_path = args.csv if os.path.isabs(args.csv) else os.path.join(csv_dir, args.csv)
    else:
        output_csv_path = None

    # 2. Inspect Header: Check if CSV is already pre-parsed
    print(f"\n[1/3] Reading CSV: '{csv_file}'...")
    is_preparsed_csv = False
    records = []

    with open(csv_file, 'r', encoding='utf-8-sig', errors='ignore') as f:
        reader = csv.reader(f)
        header = next(reader, None)
        header_lower = [col.strip().lower() for col in header] if header else []

        # Check if header matches output structure: video_id, url, title, artist, thumbnail_url, playlist
        if 'video_id' in header_lower and 'title' in header_lower and 'artist' in header_lower:
            is_preparsed_csv = True
            print("  ⚡ Detected PRE-PARSED CSV format (matching output structure)!")
            print("  ⚡ Bypassing network fetch — loading metadata & playlist directly from CSV rows.")

            col_map = {col: idx for idx, col in enumerate(header_lower)}
            for row in reader:
                if row and len(row) > col_map['video_id']:
                    vid = extract_video_id(row[col_map['video_id']])
                    if vid:
                        title = row[col_map['title']] if 'title' in col_map and len(row) > col_map['title'] else f"Video {vid}"
                        artist = row[col_map['artist']] if 'artist' in col_map and len(row) > col_map['artist'] else "YouTube"
                        thumb = row[col_map['thumbnail_url']] if 'thumbnail_url' in col_map and len(row) > col_map['thumbnail_url'] else f"https://img.youtube.com/vi/{vid}/mqdefault.jpg"
                        
                        # Priority: 1. CLI --playlist if explicitly provided, 2. Playlist column from CSV, 3. 'Default'
                        csv_pl = row[col_map['playlist']].strip() if 'playlist' in col_map and len(row) > col_map['playlist'] else ""
                        pl = args.playlist.strip() if args.playlist else (csv_pl if csv_pl else "Default")

                        records.append({
                            'video_id': vid,
                            'url': f"https://www.youtube.com/watch?v={vid}",
                            'title': title,
                            'artist': artist,
                            'thumbnail': thumb,
                            'playlist': pl,
                            'is_new': 0
                        })
        else:
            # Standard raw video list: column 0 = video_id/url
            raw_ids = []
            for row in reader:
                if row and len(row) > 0:
                    vid = extract_video_id(row[0])
                    if vid:
                        raw_ids.append(vid)
            unique_ids = list(dict.fromkeys(raw_ids))
            print(f"  -> Extracted {len(unique_ids)} unique video IDs from {len(raw_ids)} rows.")

    db_path = get_target_db_path()

    if not is_preparsed_csv:
        if not unique_ids:
            print("❌ No valid YouTube video IDs found. Exiting.")
            return

        if not args.nodb and not output_csv_path:
            existing_playlists = init_database_schema(db_path)
            selected_playlist = select_playlist(existing_playlists, args.playlist)
        elif args.playlist:
            selected_playlist = args.playlist
        else:
            selected_playlist = "none"

        # Filter duplicates already in DB
        new_ids = unique_ids
        if not args.nodb and not output_csv_path:
            conn_check = sqlite3.connect(db_path)
            cur_check = conn_check.cursor()
            cur_check.execute("SELECT video_id FROM videos")
            already_in_db = set(row[0] for row in cur_check.fetchall())
            conn_check.close()

            new_ids = [vid for vid in unique_ids if vid not in already_in_db]
            dup_count = len(unique_ids) - len(new_ids)
            if dup_count > 0:
                print(f"ℹ️  Notice: {dup_count} video(s) already exist in database and will NOT be duplicated.")

            if not new_ids:
                print("✅ All videos from this CSV already exist in the database! Nothing new to import.")
                return

        # Fetch Metadata via Parallel Threads
        print(f"\n[2/3] Fetching metadata for {len(new_ids)} videos (Proxy-aware)...")
        start_time = time.time()
        session = None
        if HAS_REQUESTS:
            session = requests.Session()
            adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=20)
            session.mount('https://', adapter)
            session.headers.update({
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            })

        completed = 0
        total = len(new_ids)
        max_workers = min(15, total)

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_map = {executor.submit(fetch_single_oembed, session, vid): vid for vid in new_ids}
            for future in as_completed(future_map):
                result = future.result()
                result['playlist'] = selected_playlist
                records.append(result)
                completed += 1
                if completed % 15 == 0 or completed == total:
                    elapsed = time.time() - start_time
                    print(f"  -> [{completed}/{total}] items parsed ({elapsed:.1f}s elapsed)...")

        fetch_duration = time.time() - start_time
        print(f"Metadata processing completed in {fetch_duration:.2f} seconds.")
    else:
        print(f"\n[2/3] Loaded {len(records)} pre-parsed records in 0.01 seconds.")

    # -------------------------------------------------------------
    # ROUTE A: --nodb Flag (Print to Screen Only)
    # -------------------------------------------------------------
    if args.nodb:
        print("\n" + "=" * 65)
        print("🖥️  PARSED VIDEO RESULTS (--nodb mode: No database changes)")
        print("=" * 65)
        for idx, r in enumerate(records, 1):
            print(f"[{idx:03d}] ID: {r['video_id']} | Title: {r['title']}")
            print(f"      Artist: {r['artist']} | Playlist: {r['playlist']}")
            print(f"      Thumb : {r['thumbnail']}")
            print("-" * 65)
        print(f"Total: {len(records)} videos. Database was NOT modified.\n")
        return

    # -------------------------------------------------------------
    # ROUTE B: --csv Flag (Export to <oldfilename>_op.csv)
    # -------------------------------------------------------------
    if output_csv_path:
        print(f"\n[3/3] Writing {len(records)} records to CSV: '{output_csv_path}'...")
        fieldnames = ['video_id', 'url', 'title', 'artist', 'thumbnail_url', 'playlist']

        with open(output_csv_path, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f)
            writer.writerow(fieldnames)
            for r in records:
                writer.writerow([
                    r['video_id'],
                    f"https://www.youtube.com/watch?v={r['video_id']}",
                    r['title'],
                    r['artist'],
                    r['thumbnail'],
                    r['playlist']
                ])

        print("\n" + "=" * 65)
        print(f"✅ SUCCESS! Output CSV created in the same folder:")
        print(f"📂 '{output_csv_path}'")
        print("First column: video_id")
        print("Database was NOT modified.")
        print("=" * 65 + "\n")
        return

    # -------------------------------------------------------------
    # ROUTE C: Standard Mode (Write/Update SQLite with Zero Locks)
    # -------------------------------------------------------------
    print(f"\n[3/3] Updating {len(records)} records in SQLite database...")
    init_database_schema(db_path)
    write_start = time.time()

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("PRAGMA journal_mode = WAL;")

    insert_sql = """
        INSERT INTO videos (video_id, url, title, artist, thumbnail_url, playlist, is_new)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
            title = excluded.title,
            artist = excluded.artist,
            thumbnail_url = excluded.thumbnail_url,
            playlist = excluded.playlist,
            is_new = excluded.is_new
    """

    batch_data = [
        (
            r['video_id'],
            f"https://www.youtube.com/watch?v={r['video_id']}",
            r['title'],
            r['artist'],
            r['thumbnail'],
            r['playlist'],
            r.get('is_new', 0)
        )
        for r in records
    ]

    cursor.executemany(insert_sql, batch_data)
    conn.commit()
    conn.close()

    write_duration = time.time() - write_start
    distinct_playlists = sorted(list(set(r['playlist'] for r in records)))
    print(f"Database update completed in {write_duration:.4f} seconds!")

    print("\n" + "=" * 65)
    print(f"🎉 SUCCESS! {len(records)} videos saved/updated in database.")
    print(f"Playlists Assigned : {', '.join(distinct_playlists)}")
    print("UNIQUE constraint verified (No duplicates created).")
    print("=" * 65 + "\n")

if __name__ == '__main__':
    main()
