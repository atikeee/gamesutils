from fun import *
import os
import yaml

LAUNCHER_YAML = "links.yaml"

FALLBACK_COLORS = [
    '#58a6ff', '#3fb950', '#f78166', '#ffa657',
    '#d2a8ff', '#79c0ff', '#ff7b72', '#56d364',
    '#e3b341', '#f0883e', '#bc8cff', '#63e6be',
]

_cache = {}


def _get_groups():
    # ── locate the yaml file ──────────────────────────────────────
    # Try next to app.py first, then relative to this file
    candidates = [
        LAUNCHER_YAML,
        os.path.join(os.path.dirname(__file__), LAUNCHER_YAML),
    ]
    yaml_path = None
    for c in candidates:
        if os.path.exists(c):
            yaml_path = c
            break

    if yaml_path is None:
        print(f"[launcher] ERROR: links.yaml not found. Tried: {candidates}")
        return []

    try:
        mtime = os.path.getmtime(yaml_path)
    except OSError:
        return []

    if _cache.get('mtime') == mtime:
        return _cache['groups']

    try:
        with open(yaml_path, 'r', encoding='utf-8') as f:
            raw = yaml.safe_load(f)
    except Exception as e:
        print(f"[launcher] YAML parse error: {e}")
        return []

    if not isinstance(raw, dict):
        print(f"[launcher] ERROR: links.yaml top level is {type(raw)}, expected a dict/mapping")
        return []

    groups = []
    for i, (group_name, data) in enumerate(raw.items()):
        if not isinstance(data, dict):
            print(f"[launcher] Skipping group '{group_name}': value is {type(data)}")
            continue

        icon  = str(data.get('icon')  or '🔗')
        color = str(data.get('color') or FALLBACK_COLORS[i % len(FALLBACK_COLORS)])

        # If color lost its quotes in YAML it arrives as None — use fallback
        if not color.startswith('#'):
            color = FALLBACK_COLORS[i % len(FALLBACK_COLORS)]

        raw_links = data.get('links') or {}
        if not isinstance(raw_links, dict):
            raw_links = {}

        links = []
        for n, u in raw_links.items():
            name = str(n) if n is not None else ''
            url  = str(u) if u is not None else ''
            if name and url:
                links.append({"name": name, "url": url})

        groups.append({
            "name":  str(group_name),
            "icon":  icon,
            "color": color,
            "links": links,
        })

    print(f"[launcher] Loaded {len(groups)} groups, "
          f"{sum(len(g['links']) for g in groups)} total links from {yaml_path}")

    _cache['mtime']  = mtime
    _cache['groups'] = groups
    return groups


def configure_routes_launcher(app, socketio):

    @app.route("/launcher")
    def launcher():
        groups = _get_groups()
        return render_template("launcher.html", groups=groups)