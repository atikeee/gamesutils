from dashboard import PROJECT_ROOT, dashboard_tile
from flask import abort, jsonify, redirect, render_template, request, session, url_for
import hashlib
import hmac
import json
import os
import secrets
import string
import random

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
STARTING_HAND = ["wood"] * 4 + ["brick"] * 4 + ["sheep"] * 2 + ["hay"] * 2


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
    ordered_players = sorted(
        players,
        key=lambda player: (str(player.get('code', ''))[-5:].casefold(), player['seat']),
    )
    return [f"player{player['seat']}" for player in ordered_players]


def sync_catan_turn_order(state, players):
    previous_order = state.get('_turnOrder')
    if not isinstance(previous_order, list):
        previous_order = []
    turn_order = get_catan_turn_order(players)
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
        #board_json = load_latest_catan_board_state_from_json()

        return render_template("catan/catan_game.html", player_colors=get_catan_player_colors())

    @app.route('/catan/player/', methods=['GET', 'POST'], strict_slashes=False)
    @dashboard_tile(section="board", title="Catan Player", description="Register a player or open an existing player seat.", icon="players", order=30)
    def catan_player_lobby():
        error = None
        try:
            registry = load_catan_player_registry()
        except (OSError, ValueError, json.JSONDecodeError) as exception:
            return f"Could not load player slots: {exception}", 500

        if request.method == 'POST':
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
                            state['robber'] = {'q': 100, 'r': 100}
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

        players_by_seat = {player['seat']: player for player in registry['players']}
        seats = [
            {'seat': seat, 'name': players_by_seat.get(seat, {}).get('name')}
            for seat in range(1, 5)
        ]
        return render_template(
            'catan/catan_player_lobby.html',
            seats=seats,
            error=error,
        )

    @app.route('/catan/player/<player_code>', methods=['GET', 'POST'])
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

    @app.route('/catan/save_play_state', methods=['POST'])
    def save_play_state():
        """API endpoint to save a specific player's state."""
        try:
            play_state = request.json
            if play_state:
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
                if previous_turn_order != play_state['_turnOrder'] or previous_player != play_state['_currentTurnPlayerId']:
                    save_play_state_to_json(json.dumps(play_state))
                return jsonify({"status": "success", "play_state": play_state}), 200
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
        reset_state["robber"] = {"q": 100, "r": 100}
        reset_state["_undoStack"] = []
        reset_state["_turnOrder"] = []
        reset_state["_currentTurnPlayerId"] = None

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
            "message": "Game reset. Player seats were cleared; each player receives a 12-card starting hand when they join.",
        }), 200

    @socketio.on('dev_card_played')
    def handle_dev_card_played(data):
        """
        Receives a 'dev_card_played' event from a client and broadcasts it
        to all other clients, including the game board page.
        """
        card_type = data.get('cardType')
        player_name = data.get('playerName')
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
        print(f"SERVER DEBUG: Received 'card_pick_broadcast' event: {log} picked by {pid}")
        # Broadcast the played card information to all clients
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
            socketio.emit('game_action_log_broadcast', {'pid': pid, 'message': message})
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

        authorized_codes = set(session.get('catan_player_access', []))
        authenticated_player = next(
            (player for player in registry['players']
             if player['code'] in authorized_codes and f"player{player['seat']}" == current_player_id),
            None,
        )
        requested_player_id = (data or {}).get('player_id')
        if not authenticated_player or requested_player_id != current_player_id:
            socketio.emit('roll_rejected', {
                'message': 'It is not your turn to roll.',
                'current_player': current_player_id,
            }, to=request.sid)
            return

        current_index = turn_order.index(current_player_id)
        next_player_id = turn_order[(current_index + 1) % len(turn_order)]
        state['_undoStack'] = []
        state['_currentTurnPlayerId'] = next_player_id
        save_play_state_to_json(json.dumps(state))
        socketio.emit('undo_history_reset')
        dice = [random.randint(1, 6), random.randint(1, 6)]
        socketio.emit('roll_dice_broadcast', {
            'dice': dice,
            'current_player': current_player_id,
            'next_player': next_player_id,
        })
