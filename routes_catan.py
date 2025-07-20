from storage import *
from fun import *

JSON_BOARD_STATE_FILE = "catan_board_state.json"
JSON_PLAY_STATE_FILE = "catan_play_state.json"

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
    # --- Catan Board Routes ---
    @app.route('/catan_board')
    def catan_board():
        """Renders the Catan board builder page using a template file."""
        return render_template('catan.html')

    @app.route('/save_board', methods=['POST'])
    def save_board():
        """API endpoint to save the Catan board state."""
        try:
            board_state = request.json
            if board_state:
                if save_catan_board_state_to_json(json.dumps(board_state)): # Save as JSON string
                    return jsonify({"status": "success", "message": "Board state saved successfully!"}), 200
                return jsonify({"status": "error", "message": "Failed to save board state to file."}), 500
            return jsonify({"status": "error", "message": "No board state provided."}), 400
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route('/load_board', methods=['GET'])
    def load_board():
        """API endpoint to load the latest Catan board state."""
        try:
            board_state_json = load_latest_catan_board_state_from_json()
            if board_state_json:
                return jsonify({"status": "success", "board_state": json.loads(board_state_json)}), 200
            return jsonify({"status": "info", "message": "No saved board state found."}), 200
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/catan_game")
    def catan_game():
        #board_json = load_latest_catan_board_state_from_json()
        
        return render_template("catan_game.html")

    @app.route('/catan_player/<player_id>')
    def catan_player(player_id):
        """Renders a specific player's Catan game page."""
        return render_template('catan_player.html', player_id=player_id)

    @app.route('/save_play_state', methods=['POST'])
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

    @app.route('/load_play_state', methods=['GET'])
    def load_play_state():
        """API endpoint to load a specific player's state."""
        try:
            play_state_json = load_play_state_from_json()
            if play_state_json:
                return jsonify({"status": "success", "play_state": json.loads(play_state_json)}), 200
            return jsonify({"status": "info", "message": f"No saved state found for player ."}), 200
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500


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
        
    @socketio.on('card_pick_log')
    def handle_card_pick_log(data):
        pid = data.get('pid')
        log = data.get('log')
        print(f"SERVER DEBUG: Received 'card_pick_broadcast' event: {log} picked by {pid}")
        # Broadcast the played card information to all clients
        socketio.emit('card_pick_log_broadcast', {'pid': pid, 'log': log})
        
