from collections import defaultdict
import os


PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))


DASHBOARD_SECTIONS = {
    "cards": {"title": "Card Games", "order": 10},
    "board": {"title": "Board Games", "order": 20},
    "quiz": {"title": "Quiz & Puzzles", "order": 30},
    "tutoring": {"title": "Tutoring", "order": 35},
    "media": {"title": "Media", "order": 40},
    "tools": {"title": "Tools & Dev", "order": 50},
    "flights": {"title": "Flights", "order": 60},
}

DASHBOARD_ICONS = {
    "playing_cards": "🃏",
    "scorecard": "📋",
    "deck": "🎴",
    "spade": "♠️",
    "map": "🗺️",
    "island": "🏝️",
    "players": "🧑‍🤝‍🧑",
    "pencil": "✏️",
    "play": "▶️",
    "chart": "📊",
    "review": "🔍",
    "spy": "🕵️",
    "lock": "🔐",
    "puzzle": "🧩",
    "photo": "🖼️",
    "question": "❓",
    "brain": "🧠",
    "unlock": "🔓",
    "bell": "🔔",
    "clipboard": "📝",
    "music": "🎵",
    "headphones": "🎧",
    "settings": "⚙️",
    "link": "🔗",
    "code": "💻",
    "plane": "✈️",
    "calendar": "🗓️",
    "add": "➕",
    "radar": "📡",
    "launch": "🚀",
    "book": "📖",
    "stocks": "📈",
    "mail": "✉️",
    "calculator": "🧮",
    "target": "🎯",
}


def dashboard_tile(*, section, title, description, icon, order=100, values=None):
    """Mark a GET route for the dashboard; unmarked routes stay internal."""
    if section not in DASHBOARD_SECTIONS:
        raise ValueError(f"Unknown dashboard section: {section}")
    if icon not in DASHBOARD_ICONS:
        raise ValueError(
            f"Unknown dashboard icon {icon!r}; choose one of {', '.join(DASHBOARD_ICONS)}"
        )

    metadata = {
        "section": section,
        "title": title,
        "description": description,
        "icon": icon,
        "order": order,
        "values": dict(values or {}),
    }

    def decorate(view):
        view.__dashboard_tile__ = metadata
        return view

    return decorate


def dashboard_sections(app):
    items_by_section = defaultdict(list)
    module_order = {}

    for endpoint, view in app.view_functions.items():
        metadata = getattr(view, "__dashboard_tile__", None)
        if metadata is None:
            continue

        module = view.__module__
        if module not in module_order:
            module_order[module] = len(module_order)

        values = metadata["values"]
        required_values = set(values)
        route = next((
            rule for rule in app.url_map.iter_rules(endpoint)
            if "GET" in rule.methods and set(rule.arguments).issubset(required_values)
        ), None)
        if route is None:
            continue

        _, href = route.build(values, append_unknown=False)
        if not href:
            continue

        items_by_section[metadata["section"]].append({
            "href": href,
            "title": metadata["title"],
            "description": metadata["description"],
            "icon": DASHBOARD_ICONS[metadata["icon"]],
            "module_order": module_order[module],
            "order": metadata["order"],
        })

    sections = []
    for key, definition in sorted(
        DASHBOARD_SECTIONS.items(), key=lambda item: item[1]["order"]
    ):
        items = sorted(
            items_by_section.get(key, []),
            key=lambda item: (item["module_order"], item["order"], item["title"]),
        )
        if items:
            sections.append({
                "key": key,
                "title": definition["title"],
                "items": items,
            })

    return sections