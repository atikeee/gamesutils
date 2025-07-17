from storage import *
from fun import *

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

    @app.route('/save_player_state/<player_id>', methods=['POST'])
    def save_player_state(player_id):
        """API endpoint to save a specific player's state."""
        try:
            player_state = request.json
            if player_state:
                if save_player_state_to_json(player_id, json.dumps(player_state)):
                    return jsonify({"status": "success", "message": f"Player {player_id} state saved successfully!"}), 200
                return jsonify({"status": "error", "message": f"Failed to save player {player_id} state to file."}), 500
            return jsonify({"status": "error", "message": "No player state provided."}), 400
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route('/load_player_state/<player_id>', methods=['GET'])
    def load_player_state(player_id):
        """API endpoint to load a specific player's state."""
        try:
            player_state_json = load_player_state_from_json(player_id)
            if player_state_json:
                return jsonify({"status": "success", "player_state": json.loads(player_state_json)}), 200
            return jsonify({"status": "info", "message": f"No saved state found for player {player_id}."}), 200
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

