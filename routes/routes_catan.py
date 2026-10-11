from dashboard import PROJECT_ROOT, dashboard_tile
from flask import abort, jsonify, redirect, render_template, request, session, url_for
from collections import Counter
from functools import wraps
import hashlib
import hmac
import json
import os
import secrets
import string
import random
from threading import RLock

CATAN_DATA_DIR = os.path.join(PROJECT_ROOT, "data", "catan")
JSON_BOARD_STATE_FILE = os.path.join(CATAN_DATA_DIR, "catan_board_state.json")
JSON_PLAY_STATE_FILE = os.path.join(CATAN_DATA_DIR, "catan_play_state.json")
PLAYER_REGISTRY_FILE = os.path.join(CATAN_DATA_DIR, "catan_player_registry.json")
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
CATAN_REGISTRY_LOCK = RLock()


def catan_registry_locked(handler):
    @wraps(handler)
    def locked_handler(*args, **kwargs):
        with CATAN_REGISTRY_LOCK:
            return handler(*args, **kwargs)
    return locked_handler
#DEV_CARD_COUNTS = {'knight': 14, 'victory_point': 5, 'road_building': 2, 'year_of_plenty': 2, 'monopoly': 2}
DEV_CARD_COUNTS = {'knight': 1, 'victory_point': 1, 'road_building': 1, 'year_of_plenty': 2, 'monopoly': 2}


def ensure_catan_dev_deck(state):
    if isinstance(state.get('_devDeck'), list):
        return False
    used = Counter()
    for seat in range(1, 5):
        player = state.get(f'player{seat}', {})
        used.update(card for card in player.get('devCards', []) if card in DEV_CARD_COUNTS)
        used['victory_point'] += int(player.get('victory_point', 0))
    for entry in state.get('_activityLog', []):
        if entry.get('action') == 'played' and entry.get('cardType') in DEV_CARD_COUNTS and entry['cardType'] != 'victory_point':
            used[entry['cardType']] += 1
    deck = [card for card, count in DEV_CARD_COUNTS.items() for _ in range(max(0, count - used[card]))]
    purchases = sum(entry.get('action') == 'bought' or entry.get('message') == 'bought a Development Card'
                    for entry in state.get('_activityLog', []))
    while len(deck) > sum(DEV_CARD_COUNTS.values()) - max(sum(used.values()), purchases):
        deck.pop()
    random.shuffle(deck)
    state['_devDeck'] = deck
    state['_devDeckInitialized'] = True
    return True


def load_catan_player_registry():
    if not os.path.exists(PLAYER_REGISTRY_FILE):
        return {"players": []}
    with open(PLAYER_REGISTRY_FILE, 'r', encoding='utf-8') as registry_file:
        registry = json.load(registry_file)
    if not isinstance(registry, dict) or not isinstance(registry.get('players'), list):
        raise ValueError('Invalid Catan player registry.')
    return registry


def save_catan_player_registry(registry):
    temporary_path = f"{PLAYER_REGISTRY_FILE}.tmp"
    with open(temporary_path, 'w', encoding='utf-8') as registry_file:
        json.dump(registry, registry_file)
    os.replace(temporary_path, PLAYER_REGISTRY_FILE)


def get_catan_turn_order(players):
    ordered_players = sorted(players, key=lambda player: (player['code'][-5:].casefold(), player['seat']))
    return [f"player{player['seat']}" for player in ordered_players]


def sync_catan_turn_order(state, players):
    previous_order = state.get('_turnOrder')
    if not isinstance(previous_order, list):
        previous_order = []
    seat_order = [f"player{player['seat']}" for player in sorted(players, key=lambda player: player['seat'])]
    turn_order = (previous_order if state.get('_started') and len(previous_order) == len(seat_order)
                  and set(previous_order) == set(seat_order) else
                  get_catan_turn_order(players) if state.get('_started') else seat_order)
    current_player = state.get('_currentTurnPlayerId')

    if not turn_order:
        current_player = None
    elif current_player not in turn_order or (
        previous_order != turn_order
        and (not previous_order or current_player == previous_order[0])
    ):
        current_player = turn_order[0]

    state['_turnOrder'] = turn_order
    state['_currentTurnPlayerId'] = current_player
    if '_phase' not in state:
        state['_phase'] = 'MAIN_PHASE' if any(state.get(player_id, {}).get('structures') for player_id in turn_order) else 'START_PHASE'
        state['_setupIndex'] = 0
    if state['_phase'] == 'START_PHASE' and turn_order:
        draft = turn_order + turn_order[::-1]
        state['_currentTurnPlayerId'] = draft[min(state.get('_setupIndex', 0), len(draft) - 1)]


def catan_authenticated_seat(registry, requested):
    return next((player for player in registry['players']
                 if f"player{player['seat']}" == requested
                 and player['code'] in session.get('catan_player_access', [])), None)


def advance_catan_setup(state):
    order = state.get('_turnOrder', [])
    if not order or state.get('_phase') != 'START_PHASE':
        return
    draft = order + order[::-1]
    index = state.get('_setupIndex', 0)
    player_id = draft[index]
    placed = draft[:index].count(player_id)
    player = state[player_id]
    if len(player.get('structures', [])) <= placed or len(player.get('roads', [])) <= placed:
        return
    index += 1
    state['_setupIndex'] = index
    if index == len(draft):
        state['_phase'] = 'MAIN_PHASE'
        state['_currentTurnPlayerId'] = order[0]
    else:
        state['_currentTurnPlayerId'] = draft[index]


def update_catan_scores(state):
    seat_ids = [f'player{seat}' for seat in range(1, 5) if f'player{seat}' in state]
    holder = next((player_id for player_id in seat_ids if state[player_id].get('largestarmy')), None)
    highest = max((state[player_id].get('knightplayed', 0) for player_id in seat_ids), default=0)
    if highest < 3:
        holder = None
    elif holder is None or state[holder].get('knightplayed', 0) < highest:
        leaders = [player_id for player_id in seat_ids if state[player_id].get('knightplayed', 0) == highest]
        holder = leaders[0] if len(leaders) == 1 else None
    for player_id in seat_ids:
        player = state[player_id]
        player['largestarmy'] = int(player_id == holder)
        points = {}
        for structure in player.get('structures', []):
            junction = structure.get('junction', {}).get('id')
            points[junction] = max(points.get(junction, 0), 2 if structure.get('type') == 'city' else 1)
        player['score'] = sum(points.values()) + int(player.get('victory_point', 0)) + 2 * (int(bool(player.get('longestroad'))) + player['largestarmy'])


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


def catan_desert_position():
    try:
        board = json.loads(load_latest_catan_board_state_from_json() or '{}')
        desert = next(tile for tile in board.get('boardTiles', []) if tile.get('type') == 'desert')
        return {'q': desert['q'], 'r': desert['r']}
    except (StopIteration, ValueError, TypeError):
        return {'q': 0, 'r': 0}


def save_play_state_to_json(player_state_json):
    """Saves a player's current state to a JSON file."""

    try:
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


def configure_routes_catan(app,socketio):
    def board_editing_allowed():
        try:
            return not load_catan_player_registry()['players']
        except (OSError, ValueError, json.JSONDecodeError):
            return False

    # --- Catan Board Routes ---
    @app.route('/catan/board')
    @dashboard_tile(section="board", title="Catan Board", description="Build and randomize a Catan hex board.", icon="map", order=10)
    def catan_board():
        """Renders the Catan board builder page using a template file."""
        return render_template(
            'catan/catan.html',
            board_editable=board_editing_allowed(),
            player_colors=get_catan_player_colors(),
        )

    @app.route('/catan/save_board', methods=['POST'])
    def save_board():
        """API endpoint to save the Catan board state."""
        if not board_editing_allowed():
            return jsonify({"status": "error", "message": "Reset the game before editing the board."}), 409
        try:
            board_state = request.json
            if board_state:
                if save_catan_board_state_to_json(json.dumps(board_state)): # Save as JSON string
                    return jsonify({"status": "success", "message": "Board state saved successfully!"}), 200
                return jsonify({"status": "error", "message": "Failed to save board state to file."}), 500
            return jsonify({"status": "error", "message": "No board state provided."}), 400
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route('/catan/load_board', methods=['GET'])
    def load_board():
        """API endpoint to load the latest Catan board state."""
        try:
            board_state_json = load_latest_catan_board_state_from_json()
            if board_state_json:
                return jsonify({"status": "success", "board_state": json.loads(board_state_json), "editable": board_editing_allowed()}), 200
            return jsonify({"status": "info", "message": "No saved board state found.", "editable": board_editing_allowed()}), 200
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/catan/game")
    @dashboard_tile(section="board", title="Catan Game", description="Open the shared Catan game view.", icon="island", order=20)
    def catan_game():
        state = json.loads(load_play_state_from_json() or '{}')
        return render_template("catan/catan_game.html", player_colors=get_catan_player_colors(), game_started=state.get('_started', False))

    @app.route('/catan/start_game', methods=['POST'])
    @catan_registry_locked
    def start_catan_game():
        registry = load_catan_player_registry()
        state = json.loads(load_play_state_from_json() or '{}')
        if not registry['players']:
            return jsonify({'status': 'error', 'message': 'Register at least one player before starting.'}), 409
        if state.get('_started'):
            return jsonify({'status': 'success'})
        available = [option['value'] for option in PLAYER_COLOR_OPTIONS
                     if option['value'] not in {player.get('color') for player in registry['players']}]
        random.shuffle(available)
        for player in registry['players']:
            if not player.get('color'):
                player['color'] = available.pop()
        state['_turnOrder'] = get_catan_turn_order(registry['players'])
        state['_currentTurnPlayerId'] = state['_turnOrder'][0]
        state['_setupIndex'] = 0
        state['_phase'] = 'START_PHASE'
        state['_started'] = True
        if not save_play_state_to_json(json.dumps(state)):
            return jsonify({'status': 'error', 'message': 'Could not start the game.'}), 500
        save_catan_player_registry(registry)
        socketio.emit('catan_update')
        return jsonify({'status': 'success'})

    @app.route('/catan/player/', methods=['GET', 'POST'], strict_slashes=False)
    @dashboard_tile(section="board", title="Catan Player", description="Register a player or open an existing player seat.", icon="players", order=30)
    @catan_registry_locked
    def catan_player_lobby():
        error = None
        try:
            registry = load_catan_player_registry()
        except (OSError, ValueError, json.JSONDecodeError) as exception:
            return f"Could not load player slots: {exception}", 500

        if request.method == 'POST':
            state = json.loads(load_play_state_from_json() or '{}')
            name = (request.form.get('name') or '').strip()
            passphrase = request.form.get('passphrase') or ''
            if not name or len(name) > 40 or not passphrase:
                error = 'Enter a player name and passphrase. Names may be up to 40 characters.'
            else:
                existing_player = next(
                    (player for player in registry['players'] if player['name'].strip().casefold() == name.casefold()),
                    None,
                )
                if existing_player:
                    if verify_player_passphrase(passphrase, existing_player['passphrase_salt'], existing_player['passphrase_hash']):
                        authorized_codes = set(session.get('catan_player_access', []))
                        authorized_codes.add(existing_player['code'])
                        session['catan_player_access'] = list(authorized_codes)
                        return redirect(url_for('catan_player', player_code=existing_player['code']))
                    error = 'That name is already registered. Enter its passphrase to open the player link.'
                elif state.get('_started'):
                    error = 'The game has started. New players cannot join.'
                elif len(registry['players']) >= 4:
                    error = 'All four player seats are filled. Use your registered name and passphrase to open your link.'
                else:
                    occupied_seats = {player['seat'] for player in registry['players']}
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
                                    'devCards': [],
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
                            state['robber'] = catan_desert_position()
                            state['_undoStack'] = []
                        for registered_player in registry['players']:
                            player_state = state.setdefault(f"player{registered_player['seat']}", {})
                            player_state['playerName'] = registered_player['name']
                            player_state.setdefault('hand', STARTING_HAND.copy())
                        sync_catan_turn_order(state, registry['players'])
                        save_play_state_to_json(json.dumps(state))
                        save_catan_player_registry(registry)
                        socketio.emit('board_edit_state', {'editable': False})
                        socketio.emit('catan_update')
                        authorized_codes = set(session.get('catan_player_access', []))
                        authorized_codes.add(code)
                        session['catan_player_access'] = list(authorized_codes)
                        return redirect(url_for('catan_player', player_code=code))
                    except (OSError, ValueError, json.JSONDecodeError) as exception:
                        registry['players'].remove(player)
                        error = f"Could not create the player seat: {exception}"

        state = json.loads(load_play_state_from_json() or '{}')
        players_by_seat = {player['seat']: player for player in registry['players']}
        seats = [
            {'seat': seat, 'name': players_by_seat.get(seat, {}).get('name'), 'color': players_by_seat.get(seat, {}).get('color')}
            for seat in range(1, 5)
        ]
        return render_template(
            'catan/catan_player_lobby.html',
            seats=seats,
            error=error,
            game_started=state.get('_started', False),
        )

    @app.route('/catan/player/<player_code>', methods=['GET', 'POST'])
    @catan_registry_locked
    def catan_player(player_code):
        if len(player_code) != 5 or any(character not in string.ascii_uppercase + string.digits for character in player_code):
            abort(404)
        try:
            registry = load_catan_player_registry()
        except (OSError, ValueError, json.JSONDecodeError):
            abort(404)
        player = next((item for item in registry['players'] if item['code'] == player_code), None)
        if player is None:
            abort(404)

        authorized_codes = set(session.get('catan_player_access', []))
        error = None
        if request.method == 'POST':
            if player_code not in authorized_codes:
                passphrase = request.form.get('passphrase') or ''
                if verify_player_passphrase(passphrase, player['passphrase_salt'], player['passphrase_hash']):
                    authorized_codes.add(player_code)
                    session['catan_player_access'] = list(authorized_codes)
                    return redirect(url_for('catan_player', player_code=player_code))
                error = 'Incorrect passphrase.'
            elif player.get('color'):
                error = 'Your color has already been chosen and cannot be changed.'
            elif json.loads(load_play_state_from_json() or '{}').get('_started'):
                error = 'Colors are locked after the game starts.'
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
                        socketio.emit('catan_update')
                        return redirect(url_for('catan_player', player_code=player_code))
                    except OSError as exception:
                        player.pop('color', None)
                        error = f'Could not save your color: {exception}'

        if player_code not in authorized_codes:
            status = 401 if error else 200
            return render_template('catan/catan_player_access.html', player_name=player['name'], error=error), status

        return render_template(
            'catan/catan_player.html',
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
            error=error,
        )

    @app.route('/catan/card_action', methods=['POST'])
    def catan_card_action():
        data = request.get_json(silent=True) or {}
        registry = load_catan_player_registry()
        state = json.loads(load_play_state_from_json() or '{}')
        sync_catan_turn_order(state, registry['players'])
        player_id = data.get('player_id')
        cards = data.get('cards')
        target_id = data.get('target_id')
        pickup = data.get('action') == 'pickup'
        if not catan_authenticated_seat(registry, player_id):
            return jsonify({'status': 'error', 'message': 'Player access required.'}), 403
        if not isinstance(cards, list) or not cards or any(card not in ('wood', 'brick', 'sheep', 'hay', 'rock') for card in cards):
            return jsonify({'status': 'error', 'message': 'Select resource cards first.'}), 400
        if target_id is not None and (target_id == player_id or target_id not in state['_turnOrder']):
            return jsonify({'status': 'error', 'message': 'Choose another active player.'}), 400
        hand = state[player_id]['hand']
        if not pickup and Counter(cards) - Counter(hand):
            return jsonify({'status': 'error', 'message': 'Selected cards are no longer in your hand. Reload and try again.'}), 409
        if pickup:
            if target_id is not None:
                return jsonify({'status': 'error', 'message': 'Cannot pick up cards for another player.'}), 400
            hand.extend(cards)
        else:
            for card in cards:
                hand.remove(card)
        if not pickup and target_id is not None:
            state[target_id]['hand'].extend(cards)
        seven_discard = not pickup and target_id is None and player_id in state.get('_pendingDiscards', {})
        if not pickup and target_id is None and player_id in state.get('_pendingDiscards', {}):
            state['_pendingDiscards'].pop(player_id)
        activity = state.setdefault('_activityLog', [])
        activity.append({
            'pid': player_id,
            'action': 'picked' if pickup else 'gave' if target_id else 'dropped',
            'cards': dict(Counter(cards)),
            'target': target_id,
            'seven': seven_discard,
        })
        state['_activityLog'] = activity[-100:]
        if not save_play_state_to_json(json.dumps(state)):
            return jsonify({'status': 'error', 'message': 'Could not save cards.'}), 500
        socketio.emit('catan_update')
        return jsonify({'status': 'success', 'hand_count': len(hand)})

    @app.route('/catan/buy_dev_card', methods=['POST'])
    def buy_catan_dev_card():
        registry = load_catan_player_registry()
        state = json.loads(load_play_state_from_json() or '{}')
        sync_catan_turn_order(state, registry['players'])
        player_id = (request.get_json(silent=True) or {}).get('player_id')
        if not catan_authenticated_seat(registry, player_id) or not state.get('_started') or state.get('_currentTurnPlayerId') != player_id or state.get('_phase') != 'MAIN_PHASE':
            return jsonify({'status': 'error', 'message': 'Buy Development Cards on your turn.'}), 403
        ensure_catan_dev_deck(state)
        if not state['_devDeck']:
            return jsonify({'status': 'error', 'message': 'No Development Cards remain.'}), 409
        player = state[player_id]
        if any(Counter(player['hand'])[resource] < 1 for resource in ('rock', 'sheep', 'hay')):
            return jsonify({'status': 'error', 'message': 'A Development Card costs one rock, one sheep, and one hay.'}), 409
        card = state['_devDeck'].pop()
        for resource in ('rock', 'sheep', 'hay'):
            player['hand'].remove(resource)
        if card == 'victory_point':
            player['victory_point'] = int(player.get('victory_point', 0)) + 1
        else:
            player.setdefault('devCards', []).append(card)
        state['_undoStack'] = []
        update_catan_scores(state)
        activity = state.setdefault('_activityLog', [])
        activity.append({'pid': player_id, 'message': 'bought a Development Card', 'action': 'bought'})
        if card == 'victory_point':
            activity.append({'pid': player_id, 'message': 'played a Development Card', 'action': 'played', 'cardType': 'victory_point'})
        state['_activityLog'] = activity[-100:]
        if not save_play_state_to_json(json.dumps(state)):
            return jsonify({'status': 'error', 'message': 'Could not save the Development Card purchase.'}), 500
        socketio.emit('undo_history_reset')
        socketio.emit('catan_update')
        return jsonify({'status': 'success', 'cardType': card, 'remaining': len(state['_devDeck'])})

    @app.route('/catan/save_play_state', methods=['POST'])
    def save_play_state():
        """API endpoint to save a specific player's state."""
        try:
            play_state = request.json
            if play_state:
                previous = json.loads(load_play_state_from_json() or '{}')
                registry = load_catan_player_registry()
                sync_catan_turn_order(previous, registry['players'])
                actor = previous.get('_currentTurnPlayerId')
                seat_ids = [f"player{player['seat']}" for player in registry['players']]
                authorized_ids = [player_id for player_id in seat_ids if catan_authenticated_seat(registry, player_id)]
                changed = [player_id for player_id in seat_ids if play_state.get(player_id) != previous.get(player_id)]
                if not authorized_ids:
                    return jsonify({'status': 'error', 'message': 'Unauthorized game action.'}), 403
                if not previous.get('_started') and (
                    play_state.get('robber') != previous.get('robber')
                    or any(play_state.get(player_id, {}).get(field) != previous.get(player_id, {}).get(field)
                           for player_id in seat_ids for field in ('roads', 'structures', 'devCards', 'knightplayed', 'victory_point'))
                ):
                    return jsonify({'status': 'error', 'message': 'Start the game before placing pieces or playing cards.'}), 409
                for player_id in changed:
                    if player_id not in authorized_ids and player_id != actor:
                        before = previous[player_id]
                        after = play_state[player_id]
                        if any(after.get(field) != before.get(field) for field in ('roads', 'structures', 'devCards', 'knightplayed', 'victory_point', 'longestroad', 'largestarmy')):
                            return jsonify({'status': 'error', 'message': 'Cannot change another player’s pieces or cards.'}), 403
                if actor not in authorized_ids:
                    if previous.get('_phase') == 'START_PHASE' or play_state.get('robber') != previous.get('robber') or play_state.get(actor) != previous.get(actor):
                        return jsonify({'status': 'error', 'message': 'Not your turn.'}), 403
                    for player_id in authorized_ids:
                        before = previous[player_id]
                        after = play_state[player_id]
                        if any(after.get(field) != before.get(field) for field in ('roads', 'structures', 'devCards', 'knightplayed', 'victory_point', 'longestroad', 'largestarmy')):
                            return jsonify({'status': 'error', 'message': 'Not your turn to build or play cards.'}), 403
                if previous.get('_phase') == 'START_PHASE':
                    player = play_state.get(actor, {})
                    before = previous.get(actor, {})
                    new_houses = len(player.get('structures', [])) - len(before.get('structures', []))
                    new_roads = len(player.get('roads', [])) - len(before.get('roads', []))
                    if new_houses < 0 or new_roads < 0 or new_houses > 1 or new_roads > 1:
                        return jsonify({'status': 'error', 'message': 'Place one free settlement and road during setup.'}), 409
                pending = dict(previous.get('_pendingDiscards', {}))
                for field in ('_started', '_phase', '_setupIndex', '_turnOrder', '_currentTurnPlayerId', '_rolled', '_lastRoll', '_devDeck'):
                    if field in previous:
                        play_state[field] = previous[field]
                play_state['_activityLog'] = previous.get('_activityLog', [])
                play_state['_devDeckInitialized'] = previous.get('_devDeckInitialized', False) or play_state.get('_devDeckInitialized', False)
                play_state['_pendingDiscards'] = pending
                if previous.get('_robberPending'):
                    play_state['_robberPending'] = not (actor in authorized_ids and play_state.get('_robberPending') is False)
                if actor in authorized_ids:
                    advance_catan_setup(play_state)
                update_catan_scores(play_state)
                if save_play_state_to_json(json.dumps(play_state)):
                    socketio.emit('catan_update')
                    return jsonify({"status": "success", "message": f"Player  state saved successfully!"}), 200
                return jsonify({"status": "error", "message": f"Failed to save player  state to file."}), 500
            return jsonify({"status": "error", "message": "No player state provided."}), 400
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route('/catan/load_play_state', methods=['GET'])
    def load_play_state():
        """API endpoint to load a specific player's state."""
        try:
            play_state_json = load_play_state_from_json()
            if play_state_json:
                play_state = json.loads(play_state_json)
                registry = load_catan_player_registry()
                previous_turn_order = play_state.get('_turnOrder')
                previous_player = play_state.get('_currentTurnPlayerId')
                sync_catan_turn_order(play_state, registry['players'])
                deck_restored = ensure_catan_dev_deck(play_state)
                if deck_restored or previous_turn_order != play_state['_turnOrder'] or previous_player != play_state['_currentTurnPlayerId']:
                    save_play_state_to_json(json.dumps(play_state))
                return jsonify({"status": "success", "play_state": play_state, "player_colors": get_catan_player_colors(),
                                "claimed_colors": [player['color'] for player in registry['players'] if player.get('color')]}), 200
            return jsonify({"status": "info", "message": f"No saved state found for player ."}), 200
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route('/catan/reset_game')
    def reset_game():
        reset_state = {
            f"player{player_number}": {
                "playerName": f"Player {player_number}",
                "hand": STARTING_HAND.copy(),
                "devCards": [],
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
            }
            for player_number in range(1, 5)
        }
        reset_state["robber"] = catan_desert_position()
        reset_state["_undoStack"] = []
        reset_state["_turnOrder"] = []
        reset_state["_currentTurnPlayerId"] = None
        reset_state["_started"] = False
        reset_state["_phase"] = "START_PHASE"
        reset_state["_setupIndex"] = 0

        if not save_play_state_to_json(json.dumps(reset_state)):
            return jsonify({"status": "error", "message": "Failed to reset game state."}), 500

        try:
            save_catan_player_registry({"players": []})
            session.pop('catan_player_access', None)
        except OSError as e:
            return jsonify({"status": "error", "message": f"Game reset, but player seats could not be cleared: {e}"}), 500

        socketio.emit('undo_history_reset')
        socketio.emit('board_edit_state', {'editable': True})
        socketio.emit('catan_update')
        return jsonify({
            "status": "success",
            "message": "Game reset. Player seats were cleared; new players start with no resource cards.",
        }), 200

    @app.route('/catan/longest_road', methods=['POST'])
    def assign_longest_road():
        state = json.loads(load_play_state_from_json() or '{}')
        if not state.get('_started'):
            return jsonify({'status': 'error', 'message': 'Start the game before assigning Longest Road.'}), 409
        player_id = (request.json or {}).get('player_id')
        if player_id not in state.get('_turnOrder', []) or state[player_id].get('playerName', '').strip().lower().startswith('player'):
            return jsonify({'status': 'error', 'message': 'Choose an active player.'}), 400
        for seat_id in ('player1', 'player2', 'player3', 'player4'):
            state[seat_id]['longestroad'] = int(seat_id == player_id)
            state[seat_id]['longestroadmanual'] = int(seat_id == player_id)
        update_catan_scores(state)
        save_play_state_to_json(json.dumps(state))
        socketio.emit('catan_update')
        return jsonify({'status': 'success'})

    def append_activity(player_id, message, **details):
        state = json.loads(load_play_state_from_json() or '{}')
        if player_id not in state.get('_turnOrder', []):
            return
        entries = state.setdefault('_activityLog', [])
        entries.append({'pid': player_id, 'message': message, **details})
        state['_activityLog'] = entries[-100:]
        save_play_state_to_json(json.dumps(state))
        socketio.emit('catan_update')

    @socketio.on('dev_card_played')
    def handle_dev_card_played(data):
        """
        Receives a 'dev_card_played' event from a client and broadcasts it
        to all other clients, including the game board page.
        """
        card_type = data.get('cardType')
        player_name = data.get('playerName')
        if card_type in ('knight', 'victory_point', 'road_building', 'year_of_plenty', 'monopoly'):
            append_activity(data.get('pid'), 'played a Development Card', action='played', cardType=card_type)
        print(f"SERVER DEBUG: Received 'dev_card_played' event: {card_type} played by {player_name}")
        # Broadcast the played card information to all clients
        socketio.emit('dev_card_played_broadcast', {'cardType': card_type, 'playerName': player_name})
        print("SERVER DEBUG: 'dev_card_played_broadcast' emitted from server.")
    
    @socketio.on('score_update')
    def handle_score_update():
        """
        Receives a 'dev_card_played' event from a client and broadcasts it
        to all other clients, including the game board page.
        """

        # Broadcast the played card information to all clients
        print(f"SERVER DEBUG: Received 'score_update_broadcast' ")
        socketio.emit('score_update_broadcast')
        
    
    @socketio.on('card_pick_log')
    def handle_card_pick_log(data):
        pid = data.get('pid')
        log = data.get('log')
        if log not in ('Dev Card', 'resource-pick'):
            return
        print(f"SERVER DEBUG: Received 'card_pick_broadcast' event: {log} picked by {pid}")
        # Broadcast the played card information to all clients
        if log == 'Dev Card':
            append_activity(pid, 'bought a Development Card', action='bought')
        socketio.emit('card_pick_log_broadcast', {
            'pid': pid,
            'log': log,
            'resources': data.get('resources'),
            'count': data.get('count')
        })

    @socketio.on('game_action_log')
    def handle_game_action_log(data):
        pid = data.get('pid')
        message = data.get('message')
        if pid and message:
            return
    #@socketio.on('catan_gen_update')
    #def handle_catan_gen_update(info):
    #    pid = info.get('pid')
    #    dat = info.get('dat')
    #    socketio.emit(catan_gen_update_broadcast,{'pid':pid,'dat':dat})
        
    @socketio.on('roll_dice')
    def handle_roll_dice(data=None):
        try:
            registry = load_catan_player_registry()
        except (OSError, ValueError, json.JSONDecodeError):
            registry = {"players": []}

        saved_state = load_play_state_from_json()
        try:
            state = json.loads(saved_state) if saved_state else {}
        except (TypeError, ValueError):
            state = {}

        sync_catan_turn_order(state, registry['players'])
        turn_order = state['_turnOrder']
        current_player_id = state['_currentTurnPlayerId']

        authenticated_player = catan_authenticated_seat(registry, current_player_id)
        requested_player_id = (data or {}).get('player_id')
        if not authenticated_player or requested_player_id != current_player_id:
            socketio.emit('roll_rejected', {
                'message': 'It is not your turn to roll.',
                'current_player': current_player_id,
            }, to=request.sid)
            return

        if not state.get('_started') or state.get('_phase') == 'START_PHASE' or state.get('_rolled'):
            socketio.emit('roll_rejected', {'message': 'Dice are not available now.'}, to=request.sid)
            return
        state['_undoStack'] = []
        state['_rolled'] = True
        dice = [random.randint(1, 6), random.randint(1, 6)]
        state['_lastRoll'] = {'dice': dice, 'player': current_player_id}
        if sum(dice) == 7:
            state['_pendingDiscards'] = {player_id: len(state[player_id].get('hand', [])) // 2
                                           for player_id in turn_order if len(state[player_id].get('hand', [])) > 7}
            state['_robberPending'] = True
            activity = state.setdefault('_activityLog', [])
            activity.append({'pid': current_player_id, 'action': 'seven', 'counts': dict(state['_pendingDiscards'])})
            state['_activityLog'] = activity[-100:]
        save_play_state_to_json(json.dumps(state))
        socketio.emit('undo_history_reset')
        socketio.emit('roll_dice_broadcast', {
            'dice': dice,
            'current_player': current_player_id,
        })
        socketio.emit('catan_update')

    @socketio.on('end_catan_turn')
    def end_catan_turn(data):
        state = json.loads(load_play_state_from_json() or '{}')
        registry = load_catan_player_registry()
        sync_catan_turn_order(state, registry['players'])
        actor = state.get('_currentTurnPlayerId')
        if not catan_authenticated_seat(registry, (data or {}).get('player_id')) or actor != (data or {}).get('player_id'):
            return
        if not state.get('_started') or state.get('_phase') != 'MAIN_PHASE' or not state.get('_rolled'):
            socketio.emit('roll_rejected', {'message': 'Roll before ending your turn.'}, to=request.sid)
            return
        order = state['_turnOrder']
        state['_currentTurnPlayerId'] = order[(order.index(actor) + 1) % len(order)]
        state['_rolled'] = False
        state['_robberPending'] = False
        state['_pendingDiscards'] = {}
        state['_freeRoads'] = 0
        state['_undoStack'] = []
        save_play_state_to_json(json.dumps(state))
        socketio.emit('catan_update')
