from dashboard import PROJECT_ROOT, dashboard_tile
from flask import abort, jsonify, redirect, render_template, request, session, url_for
import hashlib
import hmac
import json
import os
import secrets
import string
import random
import re
import math
from functools import wraps
from collections import Counter
from threading import Lock

CATAN2_DATA_DIR = os.path.join(PROJECT_ROOT, "data", "catan2")
JSON_BOARD_STATE_FILE = os.path.join(CATAN2_DATA_DIR, "catan_board_state.json")
JSON_PLAY_STATE_FILE = os.path.join(CATAN2_DATA_DIR, "catan_play_state.json")
JSON_ACTIVITY_LOG_FILE = os.path.join(CATAN2_DATA_DIR, "catan_activity_log.json")
PLAYER_REGISTRY_FILE = os.path.join(CATAN2_DATA_DIR, "catan_player_registry.json")
ACTIVITY_LOG_LOCK = Lock()
SETUP_LOCK = Lock()
PLAYER_COLOR_OPTIONS = [
    {"name": "Red", "value": "#D64545"},
    {"name": "Black", "value": "#000000"},
    {"name": "Green", "value": "#218C63"},
    {"name": "Yellow", "value": "#F1C40F"},
    {"name": "Purple", "value": "#8B5FBF"},
    {"name": "Teal", "value": "#168E9A"},
]
DEFAULT_PLAYER_COLORS = [option["value"] for option in PLAYER_COLOR_OPTIONS[:4]]
STARTING_HAND = []


def catan2_setup_sequence(turn_order):
    return [
        {'player': player_id, 'piece': piece, 'stage': stage}
        for stage, players in (('house', turn_order), ('city', turn_order[::-1]))
        for player_id in players
        for piece in (stage, 'road')
    ]


def catan2_setup_action(state):
    if state.get('_turnPhase') != 'setup':
        return None
    steps = catan2_setup_sequence(state.get('_turnOrder') or [])
    index = state.get('_setupIndex', 0)
    return steps[index] if type(index) is int and 0 <= index < len(steps) else None


def catan2_setup_locked(handler):
    @wraps(handler)
    def locked(*args, **kwargs):
        with SETUP_LOCK:
            return handler(*args, **kwargs)
    return locked


def catan2_board_geometry(board):
    junctions, edges = {}, {}
    for tile in board.get('boardTiles', []):
        center_x = 120 * tile['q']
        center_y = 80 * math.sqrt(3) * (tile['r'] + tile['q'] / 2)
        vertices = []
        for corner in range(6):
            angle = math.pi * corner / 3
            vertex = {'x': center_x + 80 * math.cos(angle), 'y': center_y + 80 * math.sin(angle)}
            vertex['id'] = f"{round(vertex['x'])},{round(vertex['y'])}"
            junctions.setdefault(vertex['id'], vertex)
            vertices.append(vertex)
        for first, second in zip(vertices, vertices[1:] + vertices[:1]):
            edge_id = '-'.join(sorted((first['id'], second['id'])))
            edges.setdefault(edge_id, {'id': edge_id, 'x1': first['x'], 'y1': first['y'],
                                      'x2': second['x'], 'y2': second['y'],
                                      'junctions': [first['id'], second['id']]})
    return junctions, edges


def short_player_name(name):
    return str(name or '').strip()[:5]


def normalize_catan2_names(value):
    changed = False
    if isinstance(value, dict):
        for key, item in value.items():
            if isinstance(item, str) and (key in ('playerName', 'previousOwnerName', 'player_name', 'target_name')
                                          or key == 'player' and not re.fullmatch(r'player\d+', item)):
                short = short_player_name(item)
                if short != item:
                    value[key] = short
                    changed = True
            elif isinstance(item, (dict, list)):
                changed = normalize_catan2_names(item) or changed
    elif isinstance(value, list):
        for item in value:
            changed = normalize_catan2_names(item) or changed
    return changed


def visual_activity_details(message, details=None):
    result = {}
    details = details if isinstance(details, dict) else {}
    resources = ('wood', 'brick', 'rock', 'sheep', 'hay', 'paper', 'cloth', 'coin')
    cards = details.get('cards')
    if isinstance(cards, dict):
        result['cards'] = {card: count for card, count in cards.items()
                           if card in resources and type(count) is int and 0 < count <= 999}
    else:
        result['cards'] = {card.lower(): int(count) for count, card in re.findall(
            r'(\d+)\s+(wood|brick|rock|sheep|hay|paper|cloth|coin)\b', message, re.I)}
    action = details.get('action')
    if action in ('picked', 'dropped', 'gave', 'stole', 'received', 'built', 'placed', 'upgraded', 'activated', 'removed', 'moved', 'played', 'progress_draw', 'progress_drop', 'progress_replace'):
        result['action'] = action
    else:
        lower = message.lower()
        verbs = [('upgraded', ('upgraded', 'leveled up', 'level up')), ('built', ('built',)),
                 ('placed', ('placed',)), ('activated', ('activated',)), ('removed', ('removed',)),
                 ('moved', ('moved',)), ('picked', ('picked', 'drew')), ('dropped', ('dropped',)),
                 ('gave', ('gave',)), ('stole', ('stole',)), ('played', ('played',))]
        for verb, prefixes in verbs:
            if any(re.search(r'\b' + re.escape(prefix) + r'\b', lower) for prefix in prefixes):
                result['action'] = verb
                break
    piece = details.get('piece')
    if piece not in ('house', 'city', 'road', 'wall', 'knight', 'robber', 'merchant'):
        piece = next((name for name in ('knight', 'city', 'wall', 'house', 'road', 'robber', 'merchant')
                      if re.search(r'\b' + name + r'\b', message, re.I)), None)
    if piece:
        result['piece'] = piece
    card = details.get('card')
    if isinstance(card, str) and card in PROGRESS_CARD_TYPES:
        result['card'] = card
    elif result.get('action') == 'played':
        candidate = message.removeprefix('played ').strip().replace(' ', '_')
        if candidate in PROGRESS_CARD_TYPES:
            result['card'] = candidate
        else:
            played = next((name for name in sorted(PROGRESS_CARD_TYPES, key=len, reverse=True)
                           if message.lower().startswith('played ' + name) or message.lower().startswith('played ' + name.replace('_', ' '))), None)
            if played:
                result['card'] = played
    elif result.get('action') == 'dropped' and not result['cards']:
        result['action'] = 'progress_drop'
    target = details.get('target_name')
    if isinstance(target, str):
        result['target_name'] = short_player_name(target)
    elif result.get('action') in ('gave', 'stole'):
        match = re.search(r'\b(?:to|from)\s+(.+)$', message)
        if match:
            result['target_name'] = short_player_name(match.group(1))
    sources = details.get('sources')
    if isinstance(sources, list):
        result['sources'] = [short_player_name(name) for name in sources if isinstance(name, str) and name.strip()]
    deck = details.get('deck')
    if deck in ('politics', 'trade', 'science'):
        result['deck'] = deck
    return result


def normalize_legacy_hand_resources(play_state):
    changed = False
    for player_id, player in play_state.items():
        if not player_id.startswith('player') or not isinstance(player, dict):
            continue
        hand = player.get('hand')
        if not isinstance(hand, list):
            continue
        for index, resource in enumerate(hand):
            if resource == 'ore':
                hand[index] = 'rock'
                changed = True
    return changed


def append_catan2_activity(play_state, player_id, message, kind='action', **details):
    player = play_state.get(player_id)
    if not isinstance(player, dict) or not isinstance(message, str) or not message.strip():
        return
    entries = play_state.get('activityLog')
    if not isinstance(entries, list):
        entries = []
    entries.append({
        'pid': player_id,
        'player': str(player.get('playerName') or player_id).strip()[:5],
        'message': message.strip(),
        'kind': kind,
        **visual_activity_details(message, details),
    })
    play_state['activityLog'] = entries


def load_catan2_activity_log(play_state=None):
    if os.path.exists(JSON_ACTIVITY_LOG_FILE):
        with open(JSON_ACTIVITY_LOG_FILE, 'r', encoding='utf-8') as activity_file:
            entries = json.load(activity_file)
        if not isinstance(entries, list):
            raise ValueError('Invalid Catan 2 activity log.')
    else:
        entries = (play_state or {}).get('activityLog')
        entries = entries if isinstance(entries, list) else []
    normalize_catan2_names(entries)
    for entry in entries:
        entry.update(visual_activity_details(entry.get('message', ''), entry))
    return entries


def save_catan2_activity_log(entries):
    os.makedirs(CATAN2_DATA_DIR, exist_ok=True)
    temporary_file = JSON_ACTIVITY_LOG_FILE + '.tmp'
    with open(temporary_file, 'w', encoding='utf-8') as activity_file:
        json.dump(entries, activity_file)
    os.replace(temporary_file, JSON_ACTIVITY_LOG_FILE)


def record_catan2_activity(play_state, player_id, message, kind='action', **details):
    with ACTIVITY_LOG_LOCK:
        play_state['activityLog'] = load_catan2_activity_log(play_state)
        append_catan2_activity(play_state, player_id, message, kind, **details)
        save_catan2_activity_log(play_state['activityLog'])
        return play_state['activityLog']


def merge_catan2_award_log(saved_entries, incoming_entries):
    saved = saved_entries if isinstance(saved_entries, list) else []
    incoming = incoming_entries if isinstance(incoming_entries, list) else []
    common = 0
    while common < min(len(saved), len(incoming)) and saved[common] == incoming[common]:
        common += 1
    return saved + incoming[common:]
CITIES_AND_KNIGHTS_EVENT_DIE = (
    "green_city",
    "yellow_city",
    "blue_city",
    "black_ship",
    "black_ship",
    "black_ship",
)
six = 6
three = 3
two = 2
one = 1
PROGRESS_CARD_DECKS = {
    "trade": {
        "merchant": {"quantity": six, "note": "Choose a hex to place the Merchant. Only one Merchant can be on the board, and its current owner gains 1 victory point."},
        "harbor": {"quantity": two, "note": "Commercial Harbor: Up to two opponents with more victory points each exchange one resource they choose for one commodity you choose."},
        "merchant_fleet": {"quantity": two, "note": "Choose one resource or commodity; for the rest of your turn, trade it with the bank at 2:1."},
        "master_merchant": {"quantity": two, "note": "Choose an opponent with more victory points, inspect their hand, and take two cards."},
        "trade_monopoly": {"quantity": two, "note": "Choose paper, coin, or cloth. Each opponent gives you one of that commodity if they have it."},
        "resource_monopoly": {"quantity": two, "note": "Choose wood, brick, sheep, grain, or rock. Each opponent gives you up to two of that resource."},
    },
    "politics": {
        "bishop": {"quantity": two, "note": "Move the robber to a hex, then take one random resource or commodity from each opponent with a settlement or city beside it."},
        "diplomat": {"quantity": two, "note": "Remove an open road. Return an opponent's road to their supply; you may relocate your own road for free."},
        "warlord": {"quantity": two, "note": "Activate all of your knights without paying grain."},
        "wedding": {"quantity": two, "note": "Each opponent with more victory points gives you two resource or commodity cards of their choice."},
        "intrigue": {"quantity": two, "note": "Displace an opponent's knight beside one of your roads or intersections. If it has no legal destination, return it to supply."},
        "saboteur": {"quantity": two, "note": "Opponents with at least as many victory points as you discard half their resource and commodity hand, rounded down."},
        "spy": {"quantity": three, "note": "Choose an opponent and take one of their Progress Cards, but not a Victory Point card."},
        "deserter": {"quantity": two, "note": "An opponent removes one of their knights; then place one of your available knights of the same strength for free. Take a hay if opponent has an active knight."},
        "constitution": {"quantity": one, "note": "Worth 1 victory point as soon as you draw it."},
    },
    "science": {
        "alchemist": {"quantity": two, "note": "Play before rolling the number dice. Choose both results, then roll the event die normally."},
        "crane": {"quantity": two, "note": "Upgrade with 1 less commodity card. Get a free commodity and use it."},
        "mining": {"quantity": two, "note": "Gain two rock from the bank for each adjacent mountain hex that produces for one of your settlements or cities."},
        "irrigation": {"quantity": two, "note": "Gain two grain from the bank for each adjacent field hex that produces for one of your settlements or cities."},
        "printer": {"quantity": one, "note": "Worth 1 victory point as soon as you draw it."},
        "inventor": {"quantity": two, "note": "Swap two number tokens, except tokens showing 2, 6, 8, or 12."},
        "engineer": {"quantity": one, "note": "Build one city wall for free. get 2 free brick and use for wall"},
        "medicine": {"quantity": two, "note": "Upgrade a settlement to a city for two rock and one grain. get 1 rock and 1 grain for city"},
        "smith": {"quantity": two, "note": "Promote up to two of your knights by one level each, within your improvement limit."},
        "road_building": {"quantity": two, "note": "Place up to two roads for free this turn, following normal building rules."},
    },
}
PROGRESS_CARD_TYPES = {
    card_type for card_counts in PROGRESS_CARD_DECKS.values() for card_type in card_counts
} | {"victory_point"}
PROGRESS_CARD_NOTES = {
    card_type: card_details["note"]
    for card_counts in PROGRESS_CARD_DECKS.values()
    for card_type, card_details in card_counts.items()
}
PROGRESS_CARD_NOTES["victory_point"] = "Legacy Victory Point card; worth 1 point. New draws use the named Printer or Constitution card."


def new_progress_card_decks():
    decks = {}
    for category, card_counts in PROGRESS_CARD_DECKS.items():
        cards = [card for card, details in card_counts.items() for _ in range(details["quantity"])]
        random.shuffle(cards)
        decks[category] = cards
    return decks


def normalize_progress_card_decks(decks):
    if not isinstance(decks, dict):
        decks = {}
    normalized = {}
    legacy_card_names = {
        "politics": {"victory_point": "constitution"},
        "science": {"victory_point": "printer"},
    }
    for category, card_counts in PROGRESS_CARD_DECKS.items():
        cards = decks.get(category)
        aliases = legacy_card_names.get(category, {})
        if isinstance(cards, list) and all(card in card_counts or card in aliases for card in cards):
            normalized[category] = [aliases.get(card, card) for card in cards]
        else:
            normalized[category] = [card for card, details in card_counts.items() for _ in range(details["quantity"])]
            random.shuffle(normalized[category])
    return normalized


def progress_card_deck_name(card):
    return next((category for category, cards in PROGRESS_CARD_DECKS.items() if card in cards), None)


# Decks are drawn with pop(), so index 0 is the bottom of the stack.
def return_progress_cards_to_decks(decks, cards):
    for card in cards:
        category = progress_card_deck_name(card)
        if category:
            decks[category].insert(0, card)


def take_progress_cards_from_decks(decks, cards):
    for card in cards:
        category = progress_card_deck_name(card)
        if category and card in decks[category]:
            decks[category].remove(card)


def count_held_progress_cards(state):
    return Counter(
        card
        for player_id, player_state in state.items()
        if player_id.startswith('player') and isinstance(player_state, dict)
        for card in (player_state.get('citiesAndKnights') or {}).get('progressCards') or []
        if isinstance(card, str)
    )


def default_cities_and_knights_state():
    return {
        "improvements": {"trade": 0, "politics": 0, "science": 0},
        "knights": {"basic": 0, "strong": 0, "mighty": 0},
        "progressCards": [],
        "pendingProgressReplacement": False,
        "pendingDiscardedProgressCard": None,
        "cityWalls": 0,
        "metropolis": None,
    }


def move_barbarian_ship(state, direction):
    try:
        position = max(0, min(7, int(state.get('barbarianShipPosition') or 0)))
    except (TypeError, ValueError):
        position = 0
    new_position = (position + (1 if direction == 'forward' else -1)) % 8
    state['barbarianShipPosition'] = new_position
    if new_position == 7:
        for player_id, player_state in state.items():
            if player_id.startswith('player') and isinstance(player_state, dict):
                for structure in player_state.get('structures', []):
                    if structure.get('type') == 'knight':
                        structure['active'] = False


def load_catan_player_registry():
    if not os.path.exists(PLAYER_REGISTRY_FILE):
        return {"players": []}
    with open(PLAYER_REGISTRY_FILE, 'r', encoding='utf-8') as registry_file:
        registry = json.load(registry_file)
    if not isinstance(registry, dict) or not isinstance(registry.get('players'), list):
        raise ValueError('Invalid Catan player registry.')
    if any(player.get('name') != short_player_name(player.get('name')) for player in registry['players']):
        for player in registry['players']:
            player['name'] = short_player_name(player.get('name'))
        save_catan_player_registry(registry)
    return registry


def save_catan_player_registry(registry):
    for player in registry['players']:
        player['name'] = short_player_name(player.get('name'))
    os.makedirs(CATAN2_DATA_DIR, exist_ok=True)
    temporary_path = f"{PLAYER_REGISTRY_FILE}.tmp"
    with open(temporary_path, 'w', encoding='utf-8') as registry_file:
        json.dump(registry, registry_file)
    os.replace(temporary_path, PLAYER_REGISTRY_FILE)


def is_inactive_player_name(name):
    value = str(name or '').strip().casefold()
    return not value or value.startswith('player') or value == 'playe'


def all_active_players_have_colors(players):
    return all(player.get('color') for player in players if not is_inactive_player_name(player.get('name')))


def get_catan_turn_order(players):
    ordered_players = sorted(
        (player for player in players if not is_inactive_player_name(player.get('name'))),
        key=lambda player: (str(player.get('code', ''))[-5:].casefold(), player['seat']),
    )
    return [f"player{player['seat']}" for player in ordered_players]


def sync_catan_turn_order(state, players):
    previous_order = state.get('_turnOrder')
    if not isinstance(previous_order, list):
        previous_order = []
    turn_order = get_catan_turn_order(players)
    # Keep the randomized order chosen at game start while the same players remain.
    if state.get('_gameStarted') is True and sorted(previous_order) == sorted(turn_order):
        turn_order = previous_order
    current_player = state.get('_currentTurnPlayerId')

    if not turn_order:
        current_player = None
    elif current_player not in turn_order or (
        previous_order != turn_order
        and (not previous_order or current_player == previous_order[0])
    ):
        current_player = turn_order[0]

    if current_player != state.get('_currentTurnPlayerId'):
        state['_turnRolled'] = False
    state['_turnOrder'] = turn_order
    state['_currentTurnPlayerId'] = current_player


def get_catan_player_colors():
    try:
        players = load_catan_player_registry()["players"]
    except (OSError, ValueError, json.JSONDecodeError):
        players = []
    colors = {
        f"player{seat}": DEFAULT_PLAYER_COLORS[seat - 1]
        for seat in range(1, 5)
    }
    valid_colors = {option["value"] for option in PLAYER_COLOR_OPTIONS}
    for player in players:
        if is_inactive_player_name(player.get('name')):
            continue
        color = player.get("color")
        if color in valid_colors:
            colors[f"player{player['seat']}"] = color
    return colors


def hash_player_passphrase(passphrase, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', passphrase.encode('utf-8'), salt, 260000)
    return salt.hex(), digest.hex()


def verify_player_passphrase(passphrase, salt_hex, digest_hex):
    try:
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
    except (TypeError, ValueError):
        return False
    actual = hashlib.pbkdf2_hmac('sha256', passphrase.encode('utf-8'), salt, 260000)
    return hmac.compare_digest(actual, expected)

# --- Catan Board JSON File Functions ---
def save_catan_board_state_to_json(board_state_json):
    """Saves the current Catan board state to a JSON file."""
    try:
        os.makedirs(CATAN2_DATA_DIR, exist_ok=True)
        with open(JSON_BOARD_STATE_FILE, 'w', encoding='utf-8') as f:
            f.write(board_state_json)
        return True
    except Exception as e:
        print(f"Error saving Catan board state to JSON file: {e}")
        return False

def load_latest_catan_board_state_from_json():
    """Loads the latest Catan board state from a JSON file."""
    if not os.path.exists(JSON_BOARD_STATE_FILE):
        return None
    try:
        with open(JSON_BOARD_STATE_FILE, 'r', encoding='utf-8') as f:
            content = f.read()
            if content:
                return content
            return None
    except Exception as e:
        print(f"Error loading Catan board state from JSON file: {e}")
        return None


def save_play_state_to_json(player_state_json):
    """Saves a player's current state to a JSON file."""

    try:
        state = json.loads(player_state_json)
        normalize_catan2_names(state)
        player_state_json = json.dumps(state)
        os.makedirs(CATAN2_DATA_DIR, exist_ok=True)
        with open(JSON_PLAY_STATE_FILE, 'w', encoding='utf-8') as f:
            f.write(player_state_json)
        return True
    except Exception as e:
        print(f"Error saving play state to JSON file: {e}")
        return False

def load_play_state_from_json():
    """Loads a player's state from a JSON file."""
    if not os.path.exists(JSON_PLAY_STATE_FILE):
        return None
    try:
        with open(JSON_PLAY_STATE_FILE, 'r', encoding='utf-8') as f:
            content = f.read()
            if content:
                return content
            return None
    except Exception as e:
        print(f"Error loading play state from JSON file: {e}")
        return None


def place_robber_on_desert(state):
    robber = state.get('robber')
    if isinstance(robber, dict) and robber.get('q') != 100 and robber.get('r') != 100:
        return False
    try:
        board_state = json.loads(load_latest_catan_board_state_from_json() or '{}')
    except (TypeError, ValueError):
        return False
    tiles = board_state.get('boardTiles') if isinstance(board_state, dict) else None
    desert = next((tile for tile in tiles or [] if isinstance(tile, dict) and tile.get('type') == 'desert'), None)
    if not desert:
        return False
    state['robber'] = {'q': desert.get('q'), 'r': desert.get('r'), 'type': 'desert', 'number': None}
    return True


def configure_routes_catan2(app, socketio):
    def board_editing_allowed():
        try:
            return not load_catan_player_registry()['players']
        except (OSError, ValueError, json.JSONDecodeError):
            return False

    # --- Catan Board Routes ---
    @app.route('/catan2/save_board', methods=['POST'])
    def catan2_save_board():
        """API endpoint to save the Catan board state."""
        if not board_editing_allowed():
            return jsonify({"status": "error", "message": "Reset the game before editing the board."}), 409
        try:
            board_state = request.json
            if board_state:
                if save_catan_board_state_to_json(json.dumps(board_state)): # Save as JSON string
                    socketio.emit('catan2_update')
                    return jsonify({"status": "success", "message": "Board state saved successfully!"}), 200
                return jsonify({"status": "error", "message": "Failed to save board state to file."}), 500
            return jsonify({"status": "error", "message": "No board state provided."}), 400
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route('/catan2/load_board', methods=['GET'])
    def catan2_load_board():
        """API endpoint to load the latest Catan board state."""
        try:
            board_state_json = load_latest_catan_board_state_from_json()
            if board_state_json:
                return jsonify({"status": "success", "board_state": json.loads(board_state_json), "editable": board_editing_allowed()}), 200
            return jsonify({"status": "info", "message": "No saved board state found.", "editable": board_editing_allowed()}), 200
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/catan/2/game")
    @dashboard_tile(section="board", title="Cities & Knights Game", description="Open the independent Cities & Knights game.", icon="island", order=50)
    def catan2_game():
        #board_json = load_latest_catan_board_state_from_json()

        return render_template("catan2/catan_game.html", player_colors=get_catan_player_colors())

    @app.route('/catan/2/player', methods=['GET', 'POST'], strict_slashes=False)
    @dashboard_tile(section="board", title="Cities & Knights Player", description="Register or open an independent player seat.", icon="players", order=60)
    def catan2_player_lobby():
        error = None
        try:
            registry = load_catan_player_registry()
        except (OSError, ValueError, json.JSONDecodeError) as exception:
            return f"Could not load player slots: {exception}", 500

        try:
            game_started = json.loads(load_play_state_from_json() or '{}').get('_gameStarted') is True
        except (OSError, ValueError, json.JSONDecodeError) as exception:
            return f"Could not load game state: {exception}", 500

        if request.method == 'POST':
            name = short_player_name(request.form.get('name'))
            passphrase = request.form.get('passphrase') or ''
            if is_inactive_player_name(request.form.get('name')):
                error = 'Choose a player name that does not start with Player.'
            elif not name or len(name) > 40 or not passphrase:
                error = 'Enter a player name and passphrase.'
            else:
                existing_player = next(
                    (player for player in registry['players'] if not is_inactive_player_name(player.get('name')) and player['name'].strip().casefold() == name.casefold()),
                    None,
                )
                if existing_player:
                    if verify_player_passphrase(passphrase, existing_player['passphrase_salt'], existing_player['passphrase_hash']):
                        authorized_codes = set(session.get('catan2_player_access', []))
                        authorized_codes.add(existing_player['code'])
                        session['catan2_player_access'] = list(authorized_codes)
                        return redirect(url_for('catan2_player', player_code=existing_player['code']))
                    error = 'That name is already registered. Enter its passphrase to open the player link.'
                elif game_started:
                    error = 'The game has already started. New players cannot join.'
                elif sum(not is_inactive_player_name(player.get('name')) for player in registry['players']) >= 4:
                    error = 'All four player seats are filled. Use your registered name and passphrase to open your link.'
                else:
                    occupied_seats = {player['seat'] for player in registry['players'] if not is_inactive_player_name(player.get('name'))}
                    seat = next(number for number in range(1, 5) if number not in occupied_seats)
                    alphabet = string.ascii_uppercase + string.digits
                    existing_codes = {player['code'] for player in registry['players']}
                    code = ''.join(secrets.choice(alphabet) for _ in range(5))
                    while code in existing_codes:
                        code = ''.join(secrets.choice(alphabet) for _ in range(5))
                    salt, passphrase_hash = hash_player_passphrase(passphrase)
                    player = {
                        'seat': seat,
                        'name': name,
                        'code': code,
                        'passphrase_salt': salt,
                        'passphrase_hash': passphrase_hash,
                    }
                    registry['players'].append(player)
                    try:
                        saved_state = load_play_state_from_json()
                        if saved_state:
                            state = json.loads(saved_state)
                        else:
                            state = {
                                f'player{player_seat}': {
                                    'playerName': f'Player {player_seat}',
                                    'hand': STARTING_HAND.copy(),
                                    'roads': [],
                                    'structures': [],
                                    'history': [],
                                    'longestroad': 0,
                                    'longestroadmanual': 0,
                                    'largestarmy': 0,
                                    'largestarmymanual': 0,
                                    'knightplayed': 0,
                                    'victory_point': 0,
                                    'score': 0,
                                }
                                for player_seat in range(1, 5)
                            }
                            state['robber'] = {'q': 100, 'r': 100}
                            state['_undoStack'] = []
                            state['_gameStarted'] = False
                        for registered_player in registry['players']:
                            if is_inactive_player_name(registered_player.get('name')):
                                continue
                            player_state = state.setdefault(f"player{registered_player['seat']}", {})
                            player_state['playerName'] = registered_player['name']
                            player_state.setdefault('hand', STARTING_HAND.copy())
                            player_state.setdefault('citiesAndKnights', default_cities_and_knights_state())
                        state['progressCardDecks'] = normalize_progress_card_decks(state.get('progressCardDecks'))
                        place_robber_on_desert(state)
                        sync_catan_turn_order(state, registry['players'])
                        save_play_state_to_json(json.dumps(state))
                        save_catan_player_registry(registry)
                        socketio.emit('catan2_board_edit_state', {'editable': False})
                        socketio.emit('catan2_update')
                        authorized_codes = set(session.get('catan2_player_access', []))
                        authorized_codes.add(code)
                        session['catan2_player_access'] = list(authorized_codes)
                        return redirect(url_for('catan2_player', player_code=code))
                    except (OSError, ValueError, json.JSONDecodeError) as exception:
                        registry['players'].remove(player)
                        error = f"Could not create the player seat: {exception}"

        players_by_seat = {player['seat']: player for player in registry['players'] if not is_inactive_player_name(player.get('name'))}
        seats = [
            {'seat': seat, 'name': players_by_seat.get(seat, {}).get('name'), 'code': players_by_seat.get(seat, {}).get('code')}
            for seat in range(1, 5)
        ]
        return render_template(
            'catan2/catan_player_lobby.html',
            seats=seats,
            game_started=game_started,
            error=error,
        )

    @app.route('/catan/2/player/<player_code>', methods=['GET', 'POST'])
    def catan2_player(player_code):
        if len(player_code) != 5 or any(character not in string.ascii_uppercase + string.digits for character in player_code):
            abort(404)
        try:
            registry = load_catan_player_registry()
        except (OSError, ValueError, json.JSONDecodeError):
            abort(404)
        player = next((item for item in registry['players'] if item['code'] == player_code), None)
        if player is None or is_inactive_player_name(player.get('name')):
            abort(404)

        authorized_codes = set(session.get('catan2_player_access', []))
        error = None
        if request.args.get('verify') == '1':
            if request.method == 'POST':
                passphrase = request.form.get('passphrase') or ''
                if verify_player_passphrase(passphrase, player['passphrase_salt'], player['passphrase_hash']):
                    authorized_codes.add(player_code)
                    session['catan2_player_access'] = list(authorized_codes)
                    if request.accept_mimetypes.best == 'application/json':
                        return jsonify({'url': url_for('catan2_player', player_code=player_code)})
                    return redirect(url_for('catan2_player', player_code=player_code))
                error = 'Incorrect passphrase.'
                if request.accept_mimetypes.best == 'application/json':
                    return jsonify({'error': error}), 401
            return render_template('catan2/catan_player_access.html', player_name=player['name'], error=error), 401 if error else 200
        if request.method == 'POST':
            if player_code not in authorized_codes:
                passphrase = request.form.get('passphrase') or ''
                if verify_player_passphrase(passphrase, player['passphrase_salt'], player['passphrase_hash']):
                    authorized_codes.add(player_code)
                    session['catan2_player_access'] = list(authorized_codes)
                    return redirect(url_for('catan2_player', player_code=player_code))
                error = 'Incorrect passphrase.'
            elif player.get('color'):
                error = 'Your color has already been chosen and cannot be changed.'
            else:
                selected_color = request.form.get('color')
                valid_colors = {option['value'] for option in PLAYER_COLOR_OPTIONS}
                if selected_color not in valid_colors:
                    error = 'Choose one of the available colors.'
                elif any(
                    item.get('color') == selected_color
                    for item in registry['players']
                    if item['code'] != player_code
                ):
                    error = 'That color was just claimed. Choose another available color.'
                else:
                    player['color'] = selected_color
                    try:
                        save_catan_player_registry(registry)
                        socketio.emit('catan2_update')
                        return redirect(url_for('catan2_player', player_code=player_code))
                    except OSError as exception:
                        player.pop('color', None)
                        error = f'Could not save your color: {exception}'

        if player_code not in authorized_codes:
            status = 401 if error else 200
            return render_template('catan2/catan_player_access.html', player_name=player['name'], error=error), status

        return render_template(
            'catan2/catan_player.html',
            player_id=player['seat'],
            player_name=player['name'],
            player_color=player.get('color'),
            color_options=[
                {
                    **option,
                    'available': not any(
                        item.get('color') == option['value']
                        for item in registry['players']
                        if item['code'] != player_code
                    ),
                }
                for option in PLAYER_COLOR_OPTIONS
            ],
            player_colors=get_catan_player_colors(),
            progress_card_notes=PROGRESS_CARD_NOTES,
            error=error,
        )

    @app.route('/catan2/correct_robber', methods=['POST'])
    @catan2_setup_locked
    def catan2_correct_robber():
        position = request.get_json(silent=True)
        if not isinstance(position, dict) or any(type(position.get(axis)) is not int for axis in ('q', 'r')):
            return jsonify(status='error', message='Invalid robber position.'), 400
        board = json.loads(load_latest_catan_board_state_from_json() or '{}')
        if not any(tile.get('q') == position['q'] and tile.get('r') == position['r']
                   for tile in board.get('boardTiles', [])):
            return jsonify(status='error', message='Choose a tile on the board.'), 400
        state = json.loads(load_play_state_from_json() or '{}')
        state['robber'] = {'q': position['q'], 'r': position['r']}
        if not save_play_state_to_json(json.dumps(state)):
            return jsonify(status='error', message='Failed to save robber position.'), 500
        socketio.emit('catan2_update')
        return jsonify(status='success')

    @app.route('/catan2/save_play_state', methods=['POST'])
    @catan2_setup_locked
    def catan2_save_play_state():
        """API endpoint to save a specific player's state."""
        try:
            play_state = request.json
            if play_state:
                try:
                    saved_state = json.loads(load_play_state_from_json() or "{}")
                except (TypeError, ValueError):
                    saved_state = {}
                if saved_state.get('_turnPhase') == 'setup':
                    return jsonify(status='error', message='Complete setup using the required free placement.'), 409
                pending_discards = dict(saved_state.get('_pendingDiscards') or {})
                if pending_discards and (
                    play_state.get('robber') != saved_state.get('robber')
                    or play_state.get('_robberMoveAvailable') is False
                ):
                    return jsonify(status='error', message='Wait for all required players to drop cards before moving the robber.'), 409
                play_state['_pendingDiscards'] = pending_discards
                play_state['progressCardDecks'] = normalize_progress_card_decks(
                    play_state.get('progressCardDecks', saved_state.get('progressCardDecks'))
                )
                play_state['activityLog'] = load_catan2_activity_log(saved_state)
                play_state['vpAwardLog'] = merge_catan2_award_log(saved_state.get('vpAwardLog'), play_state.get('vpAwardLog'))
                # Turn progression is server-owned; ignore stale client copies.
                for turn_key in ('_turnOrder', '_currentTurnPlayerId', '_turnRolled', '_alchemistDice', '_gameStarted', '_turnPhase', '_setupQueue', '_setupIndex', '_setupUndoOpen', '_inventorSelection'):
                    if turn_key in saved_state:
                        play_state[turn_key] = saved_state[turn_key]
                    else:
                        play_state.pop(turn_key, None)
                normalize_legacy_hand_resources(play_state)
                play_state.pop('_colorsReady', None)
                for player_id, player_state in play_state.items():
                    if not player_id.startswith('player') or not isinstance(player_state, dict):
                        continue
                    player_state.pop('devCards', None)
                    cities_and_knights = player_state.get('citiesAndKnights') or default_cities_and_knights_state()
                    progress_cards = cities_and_knights.get('progressCards', [])
                    if not isinstance(progress_cards, list) or len(progress_cards) > 5:
                        return jsonify({"status": "error", "message": "A player can hold at most five progress cards."}), 400
                    if any(
                        not isinstance(card, str)
                        or (card not in PROGRESS_CARD_TYPES and card != "progress")
                        for card in progress_cards
                    ):
                        return jsonify({"status": "error", "message": "Invalid progress card."}), 400
                    cities_and_knights['progressCards'] = progress_cards[:]
                    player_state['citiesAndKnights'] = cities_and_knights
                # Cards that left every hand were played or dropped; undo brings them back out of the deck.
                held_before = count_held_progress_cards(saved_state)
                held_after = count_held_progress_cards(play_state)
                return_progress_cards_to_decks(play_state['progressCardDecks'], list((held_before - held_after).elements()))
                take_progress_cards_from_decks(play_state['progressCardDecks'], list((held_after - held_before).elements()))
                if save_play_state_to_json(json.dumps(play_state)):
                    socketio.emit('catan2_update')
                    return jsonify({"status": "success", "message": f"Player  state saved successfully!"}), 200
                return jsonify({"status": "error", "message": f"Failed to save player  state to file."}), 500
            return jsonify({"status": "error", "message": "No player state provided."}), 400
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route('/catan2/discard_cards', methods=['POST'])
    @catan2_setup_locked
    def catan2_discard_cards():
        data = request.get_json(silent=True) or {}
        player_id = data.get('player_id')
        registry = load_catan_player_registry()
        player = next((item for item in registry['players'] if f"player{item['seat']}" == player_id), None)
        if not player or player['code'] not in set(session.get('catan2_player_access', [])):
            return jsonify(status='error', message='Player access required.'), 403
        state = json.loads(load_play_state_from_json() or '{}')
        if player_id not in (state.get('_pendingDiscards') or {}):
            return jsonify(status='error', message='You have no pending seven discard.'), 409
        cards = data.get('cards')
        if not isinstance(cards, list) or not cards or any(
            card not in ('wood', 'brick', 'sheep', 'hay', 'rock', 'paper', 'cloth', 'coin') for card in cards
        ):
            return jsonify(status='error', message='Select at least one resource or commodity card to drop.'), 400
        hand = state[player_id].get('hand', [])
        if Counter(cards) - Counter(hand):
            return jsonify(status='error', message='Selected cards are no longer in your hand.'), 409
        for card in cards:
            hand.remove(card)
        state['_pendingDiscards'].pop(player_id)
        if not save_play_state_to_json(json.dumps(state)):
            return jsonify(status='error', message='Could not save your discard.'), 500
        socketio.emit('catan2_update')
        return jsonify(status='success')

    @app.route('/catan2/progress_card/draw', methods=['POST'])
    def catan2_draw_progress_card():
        payload = request.get_json(silent=True) or {}
        player_id = payload.get('player_id')
        deck_name = payload.get('deck')
        if deck_name not in PROGRESS_CARD_DECKS:
            return jsonify({"status": "error", "message": "Choose a valid progress card deck."}), 400

        try:
            registry = load_catan_player_registry()
            player = next((item for item in registry['players'] if f"player{item['seat']}" == player_id), None)
        except (OSError, ValueError, json.JSONDecodeError):
            player = None
        if not player or player['code'] not in set(session.get('catan2_player_access', [])):
            return jsonify({"status": "error", "message": "Join this Catan 2 player seat first."}), 403

        try:
            play_state = json.loads(load_play_state_from_json() or "{}")
        except (TypeError, ValueError):
            return jsonify({"status": "error", "message": "Could not load Catan 2 game state."}), 500
        player_state = play_state.get(player_id)
        if play_state.get('_turnPhase') == 'setup':
            return jsonify(status='error', message='Finish setup before drawing progress cards.'), 409
        if not isinstance(player_state, dict):
            return jsonify({"status": "error", "message": "Player state not found."}), 404

        cities_and_knights = player_state.setdefault('citiesAndKnights', default_cities_and_knights_state())
        progress_cards = cities_and_knights.setdefault('progressCards', [])
        if len(progress_cards) >= 5:
            return jsonify({"status": "error", "message": "Discard a progress card before drawing another."}), 409
        replaced_card = cities_and_knights.get('pendingProgressReplacement') is True
        discarded_card = cities_and_knights.get('pendingDiscardedProgressCard')

        decks = normalize_progress_card_decks(play_state.get('progressCardDecks'))
        deck = decks[deck_name]
        if not deck:
            return jsonify({"status": "error", "message": f"The {deck_name} progress card deck is empty."}), 409

        drawn_card = deck.pop()
        progress_cards.append(drawn_card)
        cities_and_knights['progressCards'] = progress_cards
        cities_and_knights['pendingProgressReplacement'] = False
        cities_and_knights['pendingDiscardedProgressCard'] = None
        player_state['citiesAndKnights'] = cities_and_knights
        play_state['progressCardDecks'] = decks
        if drawn_card in ('constitution', 'printer'):
            award_log = play_state.get('vpAwardLog') if isinstance(play_state.get('vpAwardLog'), list) else []
            award_log.append({
                'type': 'progress_vp',
                'card': drawn_card,
                'playerName': player_state.get('playerName') or player_id,
            })
            play_state['vpAwardLog'] = award_log
        deck_label = deck_name.capitalize()
        message = f"dropped a progress card; took {deck_label}" if replaced_card else f"drew {deck_label}"
        record_catan2_activity(play_state, player_id, message, 'pick',
                      action='progress_replace' if replaced_card else 'progress_draw', deck=deck_name)
        if not save_play_state_to_json(json.dumps(play_state)):
            return jsonify({"status": "error", "message": "Could not save the progress card draw."}), 500

        socketio.emit('catan2_card_pick_log_broadcast', {
            'pid': player_id,
            'log': 'Progress Card',
            'deck': deck_name,
        })
        socketio.emit('catan2_update')
        return jsonify({"status": "success", "card": drawn_card, "remaining": len(deck)})

    def is_authorized_seat(player_id):
        try:
            registry = load_catan_player_registry()
            if json.loads(load_play_state_from_json() or '{}').get('_turnPhase') == 'setup':
                return False
        except (OSError, ValueError, json.JSONDecodeError):
            return False
        authorized_codes = set(session.get('catan2_player_access', []))
        return any(
            f"player{player['seat']}" == player_id and player['code'] in authorized_codes
            for player in registry['players']
        )

    def get_player_progress_cards(state, player_id):
        player_state = state.get(player_id)
        if not isinstance(player_state, dict):
            return None
        cities_and_knights = player_state.setdefault('citiesAndKnights', default_cities_and_knights_state())
        progress_cards = cities_and_knights.setdefault('progressCards', [])
        return progress_cards if isinstance(progress_cards, list) else None

    def finish_server_progress_card(state, player_id, card, message, undo_entry=None, target=None, activity_details=None):
        state['_setupUndoOpen'] = False
        state['progressCardDecks'] = normalize_progress_card_decks(state.get('progressCardDecks'))
        return_progress_cards_to_decks(state['progressCardDecks'], [card])
        if undo_entry is not None:
            undo_stack = state.get('_undoStack') if isinstance(state.get('_undoStack'), list) else []
            state['_undoStack'] = (undo_stack + [{'serverUndo': card, 'player': player_id, **undo_entry}])[-3:]
        if not save_play_state_to_json(json.dumps(state)):
            return jsonify({"status": "error", "message": "Could not save the game state."}), 500
        entries = record_catan2_activity(state, player_id, f"played {card}", action='played', card=card)
        if message:
            entries = record_catan2_activity(state, player_id, message, **(activity_details or {}))
        socketio.emit('catan2_activity_log_broadcast', {'entries': entries})
        socketio.emit('catan2_progress_card_played_broadcast', {'pid': player_id, 'card': card, 'target': target})
        socketio.emit('catan2_update')
        return jsonify({"status": "success"})

    @app.route('/catan2/progress_card/resource_monopoly', methods=['POST'])
    @app.route('/catan2/progress_card/trade_monopoly', methods=['POST'])
    @catan2_setup_locked
    def catan2_play_trade_monopoly():
        payload = request.get_json(silent=True) or {}
        player_id = payload.get('player_id')
        is_resource_monopoly = request.path.endswith('/resource_monopoly')
        card_name = 'resource_monopoly' if is_resource_monopoly else 'trade_monopoly'
        display_name = 'Resource Monopoly' if is_resource_monopoly else 'Trade Monopoly'
        commodity = payload.get('resource' if is_resource_monopoly else 'commodity')
        allowed_cards = ('wood', 'brick', 'rock', 'sheep', 'hay') if is_resource_monopoly else ('paper', 'coin', 'cloth')
        if commodity not in allowed_cards:
            return jsonify({'status': 'error', 'message': 'Choose ' + ', '.join(allowed_cards) + '.'}), 400
        state, is_current_player = load_turn_state_for_request(player_id)
        if not is_current_player or state.get('_gameStarted') is False or state.get('_turnPhase') == 'setup':
            return jsonify({'status': 'error', 'message': f'Play {display_name} during your play turn.'}), 403
        progress_cards = get_player_progress_cards(state, player_id)
        if not progress_cards or card_name not in progress_cards:
            return jsonify({'status': 'error', 'message': f'You do not have a {display_name} card.'}), 409

        snapshot = json.loads(json.dumps(state))
        snapshot.pop('_undoStack', None)
        player = state[player_id]
        sources = []
        received_count = 0
        for opponent_id in state.get('_turnOrder', []):
            if opponent_id == player_id:
                continue
            opponent = state.get(opponent_id, {})
            hand = opponent.get('hand') or []
            take_count = min(2 if is_resource_monopoly else 1, hand.count(commodity))
            if take_count:
                for transfer_index in range(take_count):
                    hand.remove(commodity)
                    player.setdefault('hand', []).append(commodity)
                received_count += take_count
                sources.append(short_player_name(opponent.get('playerName') or opponent_id))
        progress_cards.remove(card_name)
        undo_stack = state.get('_undoStack') if isinstance(state.get('_undoStack'), list) else []
        state['_undoStack'] = (undo_stack + [{'state': snapshot}])[-3:]
        message = f"got {received_count} {commodity}" + (f" from {', '.join(sources)}" if sources else '')
        return finish_server_progress_card(
            state, player_id, card_name, message, target=commodity,
            activity_details={'action': 'received', 'cards': {commodity: received_count}, 'sources': sources},
        )

    @app.route('/catan2/progress_card/alchemist', methods=['POST'])
    def catan2_play_alchemist():
        payload = request.get_json(silent=True) or {}
        player_id = payload.get('player_id')
        try:
            dice = [int(payload.get('red')), int(payload.get('yellow'))]
        except (TypeError, ValueError):
            dice = []
        if len(dice) != 2 or any(value < 1 or value > 6 for value in dice):
            return jsonify({"status": "error", "message": "Choose a red and a yellow number from 1 to 6."}), 400

        state, is_current_player = load_turn_state_for_request(player_id)
        if not is_current_player:
            return jsonify({"status": "error", "message": "Alchemist can only be played on your turn."}), 403
        if state.get('_turnRolled') is True:
            return jsonify({"status": "error", "message": "Alchemist must be played before rolling the dice."}), 409
        progress_cards = get_player_progress_cards(state, player_id)
        if not progress_cards or 'alchemist' not in progress_cards:
            return jsonify({"status": "error", "message": "You do not have an Alchemist card."}), 409

        progress_cards.remove('alchemist')
        state['_alchemistDice'] = {'player': player_id, 'dice': dice}
        return finish_server_progress_card(state, player_id, 'alchemist', None, {}, f"{dice[0]} + {dice[1]}")

    @app.route('/catan2/progress_card/inventor', methods=['POST'])
    @catan2_setup_locked
    def catan2_play_inventor():
        payload = request.get_json(silent=True) or {}
        player_id = payload.get('player_id')
        state, is_current_player = load_turn_state_for_request(player_id)
        if not is_current_player or state.get('_turnPhase') == 'setup' or state.get('_gameStarted') is False:
            return jsonify(status='error', message='Play Inventor on your own turn after setup.'), 403
        action = payload.get('action', 'swap')
        selection = state.get('_inventorSelection')
        if action == 'play':
            if selection:
                return jsonify(status='error', message='Finish or undo the current Inventor card first.'), 409
            progress_cards = get_player_progress_cards(state, player_id)
            if not progress_cards or 'inventor' not in progress_cards:
                return jsonify(status='error', message='You do not have an Inventor card.'), 409
            progress_cards.remove('inventor')
            state['_inventorSelection'] = {'player': player_id, 'first': None}
            return finish_server_progress_card(state, player_id, 'inventor', None, {'step': 'play'})
        if action not in ('select', 'swap'):
            return jsonify(status='error', message='Invalid Inventor action.'), 400
        if not isinstance(selection, dict) or selection.get('player') != player_id:
            return jsonify(status='error', message='Play an Inventor card first.'), 409
        try:
            coordinates = [(int(tile['q']), int(tile['r'])) for tile in payload.get('tiles')]
        except (KeyError, TypeError, ValueError):
            coordinates = []
        expected_count = 1 if action == 'select' else 2
        if len(coordinates) != expected_count or len(set(coordinates)) != expected_count:
            return jsonify({"status": "error", "message": "Choose two different number tokens."}), 400

        try:
            board_state = json.loads(load_latest_catan_board_state_from_json() or '{}')
        except (TypeError, ValueError):
            return jsonify({"status": "error", "message": "Could not load the game."}), 500
        board_tiles = board_state.get('boardTiles') if isinstance(board_state, dict) else None
        tiles = [
            next((tile for tile in board_tiles or [] if (tile.get('q'), tile.get('r')) == coordinate), None)
            for coordinate in coordinates
        ]
        if any(tile is None or not isinstance(tile.get('number'), int) for tile in tiles):
            return jsonify({"status": "error", "message": "Both hexes must have number tokens."}), 400
        if any(tile['number'] in (2, 6, 8, 12) for tile in tiles):
            return jsonify({"status": "error", "message": "2, 6, 8 and 12 cannot be swapped."}), 400
        undo_entry = {'serverUndo': 'inventor', 'player': player_id, 'step': action}
        previous_board_json = None
        if action == 'select':
            if selection.get('first') is not None:
                return jsonify(status='error', message='Choose the second number, or undo the first selection.'), 409
            selection['first'] = {'q': coordinates[0][0], 'r': coordinates[0][1]}
        else:
            first = selection.get('first')
            if not isinstance(first, dict) or coordinates[0] != (first.get('q'), first.get('r')):
                return jsonify(status='error', message='Select the first number before swapping.'), 409
            previous_board_json = json.dumps(board_state)
            first_number, second_number = tiles[0]['number'], tiles[1]['number']
            undo_entry.update(tiles=[list(coordinate) for coordinate in coordinates], numbers=[first_number, second_number])
            tiles[0]['number'], tiles[1]['number'] = second_number, first_number
            if not save_catan_board_state_to_json(json.dumps(board_state)):
                return jsonify(status='error', message='Could not save the board.'), 500
            state.pop('_inventorSelection', None)
        state['_undoStack'] = (state.get('_undoStack', []) + [undo_entry])[-3:]
        if not save_play_state_to_json(json.dumps(state)):
            if previous_board_json is not None:
                save_catan_board_state_to_json(previous_board_json)
            return jsonify(status='error', message='Could not save the game state.'), 500
        if action == 'swap':
            entries = record_catan2_activity(state, player_id, f"swapped number tokens {first_number} and {second_number} with Inventor")
            socketio.emit('catan2_activity_log_broadcast', {'entries': entries})
        socketio.emit('catan2_update')
        return jsonify(status='success')

    @app.route('/catan2/progress_card/undo', methods=['POST'])
    @catan2_setup_locked
    def catan2_undo_server_progress_card():
        player_id = (request.get_json(silent=True) or {}).get('player_id')
        state, is_current_player = load_turn_state_for_request(player_id)
        if not is_current_player:
            return jsonify(status='error', message='Undo progress cards on your own turn.'), 403
        undo_stack = state.get('_undoStack') if isinstance(state.get('_undoStack'), list) else []
        entry = undo_stack[-1] if undo_stack else None
        if not isinstance(entry, dict) or entry.get('player') != player_id or entry.get('serverUndo') not in ('inventor', 'alchemist'):
            return jsonify({"status": "error", "message": "Nothing to undo."}), 409
        progress_cards = get_player_progress_cards(state, player_id)
        card = entry['serverUndo']
        step = entry.get('step')
        returns_card = card != 'inventor' or step in (None, 'play')
        if progress_cards is None or (returns_card and len(progress_cards) >= 5):
            return jsonify({"status": "error", "message": "Your progress card hand is full."}), 409

        previous_board_json = None
        if card == 'inventor' and step == 'play':
            state.pop('_inventorSelection', None)
        elif card == 'inventor' and step == 'select':
            state['_inventorSelection'] = {'player': player_id, 'first': None}
        elif card == 'inventor':
            try:
                board_state = json.loads(load_latest_catan_board_state_from_json() or '{}')
                coordinates = [tuple(coordinate) for coordinate in entry.get('tiles', [])]
            except (TypeError, ValueError):
                return jsonify({"status": "error", "message": "Could not load the board."}), 500
            tiles = [
                next((tile for tile in board_state.get('boardTiles') or [] if (tile.get('q'), tile.get('r')) == coordinate), None)
                for coordinate in coordinates
            ]
            if len(tiles) != 2 or any(tile is None for tile in tiles):
                return jsonify({"status": "error", "message": "Could not find the swapped numbers."}), 409
            previous_board_json = json.dumps(board_state)
            numbers = entry.get('numbers') or [tiles[1]['number'], tiles[0]['number']]
            tiles[0]['number'], tiles[1]['number'] = numbers
            if not save_catan_board_state_to_json(json.dumps(board_state)):
                return jsonify({"status": "error", "message": "Could not save the board."}), 500
            if step == 'swap':
                state['_inventorSelection'] = {'player': player_id, 'first': {'q': coordinates[0][0], 'r': coordinates[0][1]}}
        else:
            alchemist = state.get('_alchemistDice')
            if state.get('_turnRolled') is True or not isinstance(alchemist, dict) or alchemist.get('player') != player_id:
                return jsonify({"status": "error", "message": "The Alchemist roll was already used."}), 409
            state.pop('_alchemistDice', None)

        undo_stack.pop()
        state['_undoStack'] = undo_stack
        if returns_card:
            progress_cards.append(card)
            state['progressCardDecks'] = normalize_progress_card_decks(state.get('progressCardDecks'))
            take_progress_cards_from_decks(state['progressCardDecks'], [card])
        if not save_play_state_to_json(json.dumps(state)):
            if previous_board_json is not None:
                save_catan_board_state_to_json(previous_board_json)
            return jsonify({"status": "error", "message": "Could not save the game state."}), 500
        entries = record_catan2_activity(state, player_id, f"undid {card.title()}")
        socketio.emit('catan2_activity_log_broadcast', {'entries': entries})
        socketio.emit('catan2_update')
        return jsonify({"status": "success"})

    @app.route('/catan2/load_play_state', methods=['GET'])
    def catan2_load_play_state():
        """API endpoint to load a specific player's state."""
        try:
            play_state_json = load_play_state_from_json()
            if play_state_json:
                play_state = json.loads(play_state_json)
                names_changed = normalize_catan2_names(play_state)
                play_state['activityLog'] = load_catan2_activity_log(play_state)
                decks_before = play_state.get('progressCardDecks')
                play_state['progressCardDecks'] = normalize_progress_card_decks(decks_before)
                needs_save = names_changed or play_state['progressCardDecks'] != decks_before
                if normalize_legacy_hand_resources(play_state):
                    needs_save = True
                for player_id, player_state in play_state.items():
                    if not player_id.startswith('player') or not isinstance(player_state, dict):
                        continue
                    if 'devCards' in player_state:
                        player_state.pop('devCards')
                        needs_save = True
                    current = player_state.get('citiesAndKnights', {})
                    defaults = default_cities_and_knights_state()
                    if isinstance(current, dict):
                        defaults['improvements'].update(current.get('improvements') or {})
                        defaults['knights'].update(current.get('knights') or {})
                        progress_cards = current.get('progressCards')
                        if isinstance(progress_cards, list):
                            defaults['progressCards'] = [
                                card for card in progress_cards[:5]
                                if isinstance(card, str) and (card in PROGRESS_CARD_TYPES or card == 'progress')
                            ]
                        defaults['cityWalls'] = current.get('cityWalls', 0)
                        defaults['metropolis'] = current.get('metropolis')
                        defaults['pendingProgressReplacement'] = current.get('pendingProgressReplacement') is True
                        discarded_card = current.get('pendingDiscardedProgressCard')
                        defaults['pendingDiscardedProgressCard'] = discarded_card if isinstance(discarded_card, str) else None
                    player_state['citiesAndKnights'] = defaults
                registry = load_catan_player_registry()
                # Board is locked once players join, so the desert position is final.
                if registry['players'] and place_robber_on_desert(play_state):
                    needs_save = True
                previous_turn_order = play_state.get('_turnOrder')
                previous_player = play_state.get('_currentTurnPlayerId')
                sync_catan_turn_order(play_state, registry['players'])
                if needs_save or previous_turn_order != play_state['_turnOrder'] or previous_player != play_state['_currentTurnPlayerId']:
                    save_play_state_to_json(json.dumps(play_state))
                return jsonify({
                    "status": "success",
                    "play_state": play_state,
                    "colors_ready": all_active_players_have_colors(registry['players']),
                    "player_colors": get_catan_player_colors(),
                }), 200
            return jsonify({"status": "info", "message": f"No saved state found for player ."}), 200
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route('/catan2/reset_game')
    def catan2_reset_game():
        reset_state = {
            f"player{player_number}": {
                "playerName": f"Player {player_number}",
                "hand": STARTING_HAND.copy(),
                "roads": [],
                "structures": [],
                "history": [],
                "longestroad": 0,
                "longestroadmanual": 0,
                "largestarmy": 0,
                "largestarmymanual": 0,
                "knightplayed": 0,
                "victory_point": 0,
                "score": 0,
                "citiesAndKnights": default_cities_and_knights_state(),
            }
            for player_number in range(1, 5)
        }
        reset_state["robber"] = {"q": 100, "r": 100}
        reset_state["merchant"] = {"q": 100, "r": 100, "owner": None}
        reset_state["progressCardDecks"] = new_progress_card_decks()
        reset_state["activityLog"] = []
        reset_state["vpAwardLog"] = []
        reset_state["_undoStack"] = []
        reset_state["_turnOrder"] = []
        reset_state["_currentTurnPlayerId"] = None
        reset_state["_turnRolled"] = False
        reset_state["_gameStarted"] = False
        reset_state["_turnPhase"] = None
        reset_state["_setupQueue"] = []
        reset_state["_setupIndex"] = 0
        reset_state["_robberMoveAvailable"] = False
        reset_state["_robberMovePlayerId"] = None

        if not save_play_state_to_json(json.dumps(reset_state)):
            return jsonify({"status": "error", "message": "Failed to reset game state."}), 500

        with ACTIVITY_LOG_LOCK:
            save_catan2_activity_log([])

        try:
            save_catan_player_registry({"players": []})
            session.pop('catan2_player_access', None)
        except OSError as e:
            return jsonify({"status": "error", "message": f"Game reset, but player seats could not be cleared: {e}"}), 500

        socketio.emit('catan2_undo_history_reset')
        socketio.emit('catan2_board_edit_state', {'editable': True})
        socketio.emit('catan2_update')
        return jsonify({
            "status": "success",
            "message": "Game reset. Player seats were cleared; players start with no resource cards.",
        }), 200

    @socketio.on('catan2_score_update')
    def catan2_handle_score_update():
        """Broadcast score refreshes across all Catan 2 clients."""
        print("SERVER DEBUG: Received 'score_update_broadcast'")
        socketio.emit('catan2_score_update_broadcast')
        
    
    @socketio.on('catan2_card_pick_log')
    def catan2_handle_card_pick_log(data):
        pid = data.get('pid')
        log = data.get('log')
        print(f"SERVER DEBUG: Received 'card_pick_broadcast' event: {log} picked by {pid}")
        try:
            state = json.loads(load_play_state_from_json() or '{}')
            resources = data.get('resources') or {}
            resource_order = ('wood', 'brick', 'rock', 'sheep', 'hay', 'paper', 'cloth', 'coin')
            summary = ', '.join(f"{resources[resource]} {resource.capitalize()}" for resource in resource_order if resources.get(resource))
            message = f"picked {summary}" if log == 'resource-pick' and summary else f"picked {log}"
            entries = record_catan2_activity(state, pid, message, 'pick', action='picked', cards=resources)
            socketio.emit('catan2_activity_log_broadcast', {'entries': entries})
        except (TypeError, ValueError, OSError) as error:
            print(f"Could not save Catan 2 activity: {error}")
        # Broadcast the played card information to all clients
        socketio.emit('catan2_card_pick_log_broadcast', {
            'pid': pid,
            'log': log,
            'resources': data.get('resources'),
            'count': data.get('count')
        })

    @socketio.on('catan2_game_action_log')
    def catan2_handle_game_action_log(data):
        pid = data.get('pid')
        message = data.get('message')
        if pid and message:
            try:
                state = json.loads(load_play_state_from_json() or '{}')
                if message.startswith('played '):
                    return
                target = state.get(data.get('target'), {}).get('playerName')
                details = {**data, 'target_name': target} if target else data
                entries = record_catan2_activity(state, pid, message, **visual_activity_details(message, details))
                socketio.emit('catan2_activity_log_broadcast', {'entries': entries})
            except (TypeError, ValueError, OSError) as error:
                print(f"Could not save Catan 2 activity: {error}")
            socketio.emit('catan2_game_action_log_broadcast', {'pid': pid, 'message': message})

    @socketio.on('catan2_progress_card_played')
    def catan2_handle_progress_card_played(data):
        pid = (data or {}).get('pid')
        card = (data or {}).get('card')
        target = (data or {}).get('target')
        target = target.strip()[:40] if isinstance(target, str) and target.strip() else None
        if pid in {f'player{seat}' for seat in range(1, 5)} and card in PROGRESS_CARD_TYPES:
            state = json.loads(load_play_state_from_json() or '{}')
            entries = record_catan2_activity(state, pid, f'played {card}', action='played', card=card)
            socketio.emit('catan2_activity_log_broadcast', {'entries': entries})
            socketio.emit('catan2_progress_card_played_broadcast', {'pid': pid, 'card': card, 'target': target})
    #@socketio.on('catan_gen_update')
    #def handle_catan_gen_update(info):
    #    pid = info.get('pid')
    #    dat = info.get('dat')
    #    socketio.emit(catan_gen_update_broadcast,{'pid':pid,'dat':dat})
        
    def load_turn_state_for_request(player_id):
        try:
            registry = load_catan_player_registry()
        except (OSError, ValueError, json.JSONDecodeError):
            registry = {"players": []}
        try:
            state = json.loads(load_play_state_from_json() or '{}')
        except (TypeError, ValueError):
            state = {}
        sync_catan_turn_order(state, registry['players'])
        current_player_id = state['_currentTurnPlayerId']
        authorized_codes = set(session.get('catan2_player_access', []))
        is_current_player = player_id == current_player_id and any(
            player['code'] in authorized_codes and f"player{player['seat']}" == current_player_id
            for player in registry['players']
        )
        return state, is_current_player

    @app.route('/catan2/start_game', methods=['POST'])
    @catan2_setup_locked
    def catan2_start_game():
        try:
            registry = load_catan_player_registry()
            state = json.loads(load_play_state_from_json() or '{}')
        except (OSError, ValueError, json.JSONDecodeError):
            return jsonify({"status": "error", "message": "Could not load the game."}), 500
        authorized_codes = set(session.get('catan2_player_access', []))
        if not any(player['code'] in authorized_codes for player in registry['players']):
            return jsonify({"status": "error", "message": "Sign in as a player to start the game."}), 403
        if state.get('_gameStarted') is not False:
            return jsonify({"status": "error", "message": "The game has already started."}), 409
        turn_order = get_catan_turn_order(registry['players'])
        if not turn_order:
            return jsonify({"status": "error", "message": "No players have joined yet."}), 409

        taken_colors = {player.get('color') for player in registry['players'] if player.get('color')}
        free_colors = [option['value'] for option in PLAYER_COLOR_OPTIONS if option['value'] not in taken_colors]
        random.shuffle(free_colors)
        for player in registry['players']:
            if not player.get('color') and free_colors:
                player['color'] = free_colors.pop()

        random.shuffle(turn_order)
        state['_turnOrder'] = turn_order
        state['_currentTurnPlayerId'] = turn_order[0]
        state['_setupQueue'] = (turn_order + turn_order[-2::-1])[1:]
        state['_turnPhase'] = 'setup'
        state['_setupIndex'] = 0
        state['_setupUndoOpen'] = True
        state['_turnRolled'] = True
        state['_gameStarted'] = True
        state['_undoStack'] = []
        for player_id, player_state in state.items():
            if player_id.startswith('player') and isinstance(player_state, dict):
                player_state['hand'] = []
                player_state['roads'] = []
                player_state['structures'] = []
                player_state['score'] = 0
                player_state['longestroad'] = 0
                player_state['largestarmy'] = 0
        try:
            save_catan_player_registry(registry)
        except OSError:
            return jsonify({"status": "error", "message": "Could not save player colors."}), 500
        if not save_play_state_to_json(json.dumps(state)):
            return jsonify({"status": "error", "message": "Could not start the game."}), 500
        names = [short_player_name(state.get(player_id, {}).get('playerName') or player_id) for player_id in turn_order]
        entries = record_catan2_activity(state, turn_order[0], f"starts the game. Order: {' > '.join(names)}")
        socketio.emit('catan2_activity_log_broadcast', {'entries': entries})
        socketio.emit('catan2_undo_history_reset')
        socketio.emit('catan2_update')
        return jsonify({"status": "success", "order": names})

    @app.route('/catan2/setup_undo', methods=['POST'])
    @catan2_setup_locked
    def catan2_setup_undo():
        payload = request.get_json(silent=True) or {}
        player_id = payload.get('player_id')
        registry = load_catan_player_registry()
        authorized_codes = set(session.get('catan2_player_access', []))
        if not any(f"player{player['seat']}" == player_id and player['code'] in authorized_codes
                   for player in registry['players']):
            return jsonify(status='error', message='Join this Catan 2 player seat first.'), 403
        state, _ = load_turn_state_for_request(player_id)
        index = state.get('_setupIndex', 0)
        if state.get('_turnPhase') != 'setup' and not state.get('_setupUndoOpen'):
            return jsonify(status='error', message='Setup undo is no longer available.'), 409
        if type(index) is not int or index <= 0 or payload.get('setup_index') != index:
            return jsonify(status='error', message='No setup action to undo, or the setup has changed.'), 409
        step = catan2_setup_action({**state, '_turnPhase': 'setup', '_setupIndex': index - 1})
        if not step or step['player'] != player_id:
            return jsonify(status='error', message='The latest setup action must be undone by its owner first.'), 409
        player = state[player_id]
        pieces = player.get('roads' if step['piece'] == 'road' else 'structures', [])
        if not pieces or (step['piece'] != 'road' and pieces[-1].get('type') != step['piece']):
            return jsonify(status='error', message='The setup placement could not be found.'), 409
        pieces.pop()
        player['score'] = sum(2 if piece.get('type') == 'city' else 1
                              for piece in player.get('structures', []))
        state['_setupIndex'] = index - 1
        state['_turnPhase'] = 'setup'
        state['_currentTurnPlayerId'] = player_id
        state['_turnRolled'] = True
        state['_setupUndoOpen'] = True
        state['_undoStack'] = []
        if not save_play_state_to_json(json.dumps(state)):
            return jsonify(status='error', message='Could not save the setup undo.'), 500
        entries = record_catan2_activity(state, player_id, f"undid a free {step['piece']}",
                                         action='removed', piece=step['piece'])
        socketio.emit('catan2_activity_log_broadcast', {'entries': entries})
        socketio.emit('catan2_update')
        return jsonify(status='success')

    @app.route('/catan2/setup_piece', methods=['POST'])
    @catan2_setup_locked
    def catan2_setup_piece():
        payload = request.get_json(silent=True) or {}
        player_id = payload.get('player_id')
        state, is_current_player = load_turn_state_for_request(player_id)
        step = catan2_setup_action(state)
        if not is_current_player or state.get('_gameStarted') is not True:
            return jsonify(status='error', message='It is not your setup turn.'), 403
        if not step or step['player'] != player_id or payload.get('piece') != step['piece']:
            return jsonify(status='error', message='Place the required setup piece first.'), 409
        try:
            board = json.loads(load_latest_catan_board_state_from_json() or '{}')
            junctions, edges = catan2_board_geometry(board)
        except (ValueError, KeyError, TypeError):
            return jsonify(status='error', message='Could not load the board.'), 500
        player = state[player_id]
        structures = player.setdefault('structures', [])
        roads = player.setdefault('roads', [])
        players = [value for key, value in state.items() if key.startswith('player') and isinstance(value, dict)]
        occupied = {structure.get('junction', {}).get('id') for owner in players for structure in owner.get('structures', [])}
        if step['piece'] == 'road':
            edge = edges.get(payload.get('edge_id'))
            latest = structures[-1].get('junction', {}).get('id') if structures else None
            if not edge or latest not in edge['junctions']:
                return jsonify(status='error', message='Place the road beside your new house or city.'), 409
            if any(road.get('edge', {}).get('id') == edge['id'] for owner in players for road in owner.get('roads', [])):
                return jsonify(status='error', message='A road already occupies that edge.'), 409
            roads.append({'edge': {key: value for key, value in edge.items() if key != 'junctions'}, 'owner': player_id})
        else:
            junction_id = payload.get('junction_id')
            junction = junctions.get(junction_id)
            if not junction or junction_id in occupied:
                return jsonify(status='error', message='Choose an empty intersection.'), 409
            if any(junction_id in edge['junctions'] and any(other in occupied for other in edge['junctions'] if other != junction_id) for edge in edges.values()):
                return jsonify(status='error', message='Keep one empty intersection between settlements.'), 409
            structures.append({'type': step['piece'], 'junction': junction, 'owner': player_id})
        player['score'] = sum(2 if structure['type'] == 'city' else 1 for structure in structures)
        state['_setupIndex'] = state.get('_setupIndex', 0) + 1
        state['_setupUndoOpen'] = True
        following = catan2_setup_action(state)
        if following:
            state['_currentTurnPlayerId'] = following['player']
        else:
            state['_turnPhase'] = 'play'
            state['_currentTurnPlayerId'] = state['_turnOrder'][0]
            state['_turnRolled'] = False
            state['_setupQueue'] = []
        state['_undoStack'] = []
        if not save_play_state_to_json(json.dumps(state)):
            return jsonify(status='error', message='Could not save the setup placement.'), 500
        entries = record_catan2_activity(state, player_id, f"placed a free {step['piece']}", action='placed', piece=step['piece'])
        socketio.emit('catan2_activity_log_broadcast', {'entries': entries})
        socketio.emit('catan2_update')
        return jsonify(status='success', phase=state['_turnPhase'], current_player=state['_currentTurnPlayerId'])

    @socketio.on('catan2_roll_dice')
    @catan2_setup_locked
    def catan2_handle_roll_dice(data=None):
        state, is_current_player = load_turn_state_for_request((data or {}).get('player_id'))
        current_player_id = state['_currentTurnPlayerId']
        if state.get('_gameStarted') is False:
            socketio.emit('catan2_roll_rejected', {
                'message': 'The game has not started yet.',
                'current_player': current_player_id,
                'turn_rolled': state.get('_turnRolled') is True,
            }, to=request.sid)
            return
        if not is_current_player:
            socketio.emit('catan2_roll_rejected', {
                'message': 'It is not your turn to roll.',
                'current_player': current_player_id,
                'turn_rolled': state.get('_turnRolled') is True,
            }, to=request.sid)
            return
        if state.get('_turnRolled') is True:
            socketio.emit('catan2_roll_rejected', {
                'message': 'You already rolled. Tap the tick to end your turn.',
                'current_player': current_player_id,
                'turn_rolled': True,
            }, to=request.sid)
            return
        try:
            colors_ready = all_active_players_have_colors(load_catan_player_registry()['players'])
        except (OSError, ValueError, json.JSONDecodeError):
            colors_ready = False
        if not colors_ready:
            socketio.emit('catan2_roll_rejected', {
                'message': 'Waiting for every player to choose a color.',
                'current_player': current_player_id,
                'turn_rolled': False,
            }, to=request.sid)
            return

        state['_undoStack'] = [entry for entry in state.get('_undoStack', [])
                       if entry.get('serverUndo') == 'inventor' and entry.get('player') == current_player_id]
        state['_turnRolled'] = True
        state['_setupUndoOpen'] = False
        alchemist = state.pop('_alchemistDice', None)
        alchemist_dice = alchemist.get('dice') if isinstance(alchemist, dict) and alchemist.get('player') == current_player_id else None
        alchemist_used = (
            isinstance(alchemist_dice, list) and len(alchemist_dice) == 2
            and all(isinstance(value, int) and 1 <= value <= 6 for value in alchemist_dice)
        )
        dice = list(alchemist_dice) if alchemist_used else [random.randint(1, 6), random.randint(1, 6)]
        robber_move_available = sum(dice) == 7
        state['_pendingDiscards'] = {
            player_id: True for player_id in state['_turnOrder']
            if len(state.get(player_id, {}).get('hand', [])) >= 8
        } if robber_move_available else {}
        state['_robberMoveAvailable'] = robber_move_available
        state['_robberMovePlayerId'] = current_player_id if robber_move_available else None
        event_die = random.choice(CITIES_AND_KNIGHTS_EVENT_DIE)
        state['lastDiceRoll'] = {'dice': dice, 'event_die': event_die, 'player': current_player_id,
                     'player_name': short_player_name(state.get(current_player_id, {}).get('playerName'))}
        if event_die == 'black_ship':
            move_barbarian_ship(state, 'forward')
        save_play_state_to_json(json.dumps(state))
        socketio.emit('catan2_undo_history_reset')
        if event_die == 'black_ship' or robber_move_available or state.get('_undoStack'):
            socketio.emit('catan2_update')
        socketio.emit('catan2_roll_dice_broadcast', {
            'dice': dice,
            'event_die': event_die,
            'current_player': current_player_id,
            'alchemist': alchemist_used,
            'player_name': state['lastDiceRoll']['player_name'],
            'robber_move_available': robber_move_available,
            'robber_move_player': state['_robberMovePlayerId'],
            'pending_discards': state['_pendingDiscards'],
        })

    @socketio.on('catan2_end_turn')
    def catan2_handle_end_turn(data=None):
        state, is_current_player = load_turn_state_for_request((data or {}).get('player_id'))
        current_player_id = state['_currentTurnPlayerId']
        if state.get('_pendingDiscards'):
            socketio.emit('catan2_end_turn_rejected', {
                'message': 'Wait for all required players to drop cards before ending your turn.',
                'current_player': current_player_id, 'turn_rolled': state.get('_turnRolled') is True,
            }, to=request.sid)
            return
        if state.get('_turnPhase') == 'setup':
            socketio.emit('catan2_end_turn_rejected', {
                'message': 'Complete your free house or city and its connected road.',
                'current_player': current_player_id, 'turn_rolled': True,
            }, to=request.sid)
            return
        if not is_current_player or state.get('_turnRolled') is not True:
            socketio.emit('catan2_end_turn_rejected', {
                'message': 'Roll the dice before ending your turn.' if is_current_player else 'It is not your turn.',
                'current_player': current_player_id,
                'turn_rolled': state.get('_turnRolled') is True,
            }, to=request.sid)
            return

        turn_order = state['_turnOrder']
        setup_queue = [player_id for player_id in state.get('_setupQueue') or [] if player_id in turn_order]
        if state.get('_turnPhase') == 'setup' and setup_queue:
            next_player_id = setup_queue.pop(0)
            state['_setupQueue'] = setup_queue
            state['_turnRolled'] = True
        else:
            if state.get('_turnPhase') == 'setup':
                state['_turnPhase'] = 'normal'
                state['_setupQueue'] = []
                next_player_id = turn_order[0]
            else:
                next_player_id = turn_order[(turn_order.index(current_player_id) + 1) % len(turn_order)]
            state['_turnRolled'] = False
        state['_currentTurnPlayerId'] = next_player_id
        for structure in state.get(next_player_id, {}).get('structures', []):
            if structure.get('type') == 'knight':
                structure.pop('activatedThisTurn', None)
        state['_robberMoveAvailable'] = False
        state['_robberMovePlayerId'] = None
        state['_freeRoads'] = 0
        state['_freeRoadsPlayerId'] = None
        state['_undoStack'] = []
        state['_pendingDiscards'] = {}
        state.pop('_alchemistDice', None)
        state.pop('_inventorSelection', None)
        save_play_state_to_json(json.dumps(state))
        socketio.emit('catan2_turn_ended_broadcast', {
            'previous_player': current_player_id,
            'current_player': next_player_id,
            'turn_rolled': state['_turnRolled'],
            'phase': state.get('_turnPhase'),
        })
        socketio.emit('catan2_update')
