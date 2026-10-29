#!/usr/bin/env python3
"""
populate_db_mp3.py
==================
Command-line utility for scanning audio files, exporting to CSV for manual editing,
and importing from CSV directly into SQLite mp3.db.
"""

import argparse
import csv
import os
import sqlite3
import sys
from pathlib import Path
from typing import Dict, List, Optional

SUPPORTED_EXTENSIONS = {".mp3", ".m4a", ".flac", ".wav", ".ogg"}
DEFAULT_DB = Path(__file__).resolve().parent.parent / "mp3.db"


def init_db(conn: sqlite3.Connection):
    """Ensures database schema matches the required structure."""
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
    # Check if category column exists, add if missing
    cursor.execute("PRAGMA table_info(tracks);")
    columns = [row for row in cursor.fetchall()]
    if "category" not in columns:
        cursor.execute("ALTER TABLE tracks ADD COLUMN category TEXT DEFAULT NULL;")
    conn.commit()


def scan_directory(dir_path: Path, playlist: str, category: Optional[str] = None) -> List[Dict]:
    """Recursively scans a directory for music files and builds record dictionaries."""
    records = []
    for root, _, files in os.walk(dir_path):
        for f in sorted(files):
            ext = os.path.splitext(f).lower()
            if ext in SUPPORTED_EXTENSIONS:
                full_path = str(Path(root) / f).replace("\\", "/")
                name_without_ext = os.path.splitext(f)[0]
                
                # Default parsing: Artist - Title or Title
                if " - " in name_without_ext:
                    artist, title = name_without_ext.split(" - ", 1)
                else:
                    artist, title = "Unknown Artist", name_without_ext

                records.append({
                    "path": full_path,
                    "title": title.strip(),
                    "artist": artist.strip(),
                    "album": Path(root).name,
                    "category": category.strip() if category else None,
                    "playlist": playlist.strip(),
                    "tag_list": "",
                })
    return records


def export_to_csv(records: List[Dict], csv_file: Path):
    """Saves scanned records to CSV for manual review and editing."""
    fieldnames = ["path", "title", "artist", "album", "category", "playlist", "tag_list"]
    with open(csv_file, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(records)
    print(f"[SUCCESS] Exported {len(records)} track(s) to: {csv_file}")


def import_csv_to_db(csv_file: Path, db_path: Path):
    """Imports or updates tracks from CSV into SQLite database."""
    conn = sqlite3.connect(db_path)
    init_db(conn)
    cursor = conn.cursor()

    count = 0
    with open(csv_file, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            path = row.get("path", "").strip()
            playlist = row.get("playlist", "").strip()
            if not path or not playlist:
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
                row.get("title", "").strip(),
                row.get("artist", "").strip(),
                row.get("album", "").strip(),
                row.get("category", "").strip() or None,
                playlist,
                row.get("tag_list", "").strip(),
            ))
            count += 1

    conn.commit()
    conn.close()
    print(f"[SUCCESS] Imported / updated {count} track(s) into database: {db_path}")


def main():
    parser = argparse.ArgumentParser(description="Populate and manage MP3 database via CLI or CSV.")
    parser.add_argument("--scan", help="Directory path to scan for audio files")
    parser.add_argument("--playlist", default="Default", help="Target playlist name (required)")
    parser.add_argument("--category", default=None, help="Optional category name")
    parser.add_argument("--to-csv", help="Output CSV file path to export scanned records")
    parser.add_argument("--from-csv", help="Input CSV file path to load into SQLite database")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="SQLite database path")

    args = parser.parse_args()
    db_file = Path(args.db).resolve()

    if args.from_csv:
        import_csv_to_db(Path(args.from_csv).resolve(), db_file)
    elif args.scan:
        scan_dir = Path(args.scan).resolve()
        if not scan_dir.is_dir():
            print(f"[ERROR] Directory not found: {scan_dir}")
            sys.exit(1)

        records = scan_directory(scan_dir, playlist=args.playlist, category=args.category)
        if args.to_csv:
            export_to_csv(records, Path(args.to_csv).resolve())
        else:
            # Direct scan to DB
            temp_csv = Path("temp_sync.csv")
            export_to_csv(records, temp_csv)
            import_csv_to_db(temp_csv, db_file)
            temp_csv.unlink(missing_ok=True)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
