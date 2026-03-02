from fun import *
import os
import re
import time
from html import escape

BOOKMARKS_FILE = "bookmark_2_html.txt"

# ── In-memory cache ─────────────────────────────────────────────
# Stores: {'mtime': float, 'structure': dict}
# Re-parsed only when file modification time changes → instant loads
_cache = {}

def _get_structure():
    """Return parsed structure, re-parsing only if file changed."""
    try:
        mtime = os.path.getmtime(BOOKMARKS_FILE)
    except FileNotFoundError:
        return {}

    if _cache.get('mtime') == mtime:
        return _cache['structure']          # cache hit — no disk read

    structure = _parse_bookmark_file(BOOKMARKS_FILE)
    _cache['mtime'] = mtime
    _cache['structure'] = structure
    return structure


def _parse_bookmark_file(path):
    """Parse the indent-based bookmark text file into a nested dict."""
    with open(path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    structure = {}          # OrderedDict behaviour since Python 3.7+
    current_topic = None
    current_subtopic = None

    for line in lines:
        stripped = line.rstrip('\n')
        if not stripped.strip():
            continue
        if stripped.strip().startswith('#'):
            continue
        indent = len(line) - len(line.lstrip(' '))

        if indent == 0:
            current_topic = stripped.strip()
            structure[current_topic] = {}
            current_subtopic = None
        elif indent == 4:
            current_subtopic = stripped.strip()
            if current_topic is not None:
                structure[current_topic][current_subtopic] = []
        elif indent == 8:
            if current_topic is None or current_subtopic is None:
                continue
            parts = re.split(r'[\t,]', stripped.strip(), maxsplit=1)
            if len(parts) == 2:
                text, url = parts[0].strip(), parts[1].strip()
                structure[current_topic][current_subtopic].append((text, url))

    return structure


def configure_routes_links(app, socketio):

    # ── VIEW PAGE ────────────────────────────────────────────────
    @app.route("/links")
    def links():
        structure = _get_structure()
        return render_template("links.html", structure=structure)

    # ── EDITOR: GET (show editor) ────────────────────────────────
    @app.route("/links/edit", methods=["GET"])
    def links_edit():
        try:
            with open(BOOKMARKS_FILE, 'r', encoding='utf-8') as f:
                content = f.read()
        except FileNotFoundError:
            content = ""
        return render_template("links_edit.html", content=content)

    # ── EDITOR: POST (save file) ─────────────────────────────────
    @app.route("/links/edit", methods=["POST"])
    def links_edit_save():
        content = request.form.get("content", "")
        content = content.strip('\r\n') + '\n'
        try:
            with open(BOOKMARKS_FILE, 'w', encoding='utf-8') as f:
                f.write(content)
            # Bust cache immediately so /links picks up changes
            _cache.clear()
            return jsonify({"status": "success", "message": "Saved ✓"})
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── API: raw txt content (for editor fetch) ──────────────────
    @app.route("/links/raw")
    def links_raw():
        try:
            with open(BOOKMARKS_FILE, 'r', encoding='utf-8') as f:
                content = f.read()
            return jsonify({"status": "success", "content": content})
        except FileNotFoundError:
            return jsonify({"status": "error", "content": ""})