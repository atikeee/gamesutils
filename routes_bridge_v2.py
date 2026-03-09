from flask import render_template, request, jsonify, make_response
from flask_socketio import join_room, emit
from bridge_logic_v2 import BridgeManager
from flask import session, redirect, url_for

# Initialize the manager
bridge_manager = BridgeManager()

def configure_routes_bridge_v2(app, socketio):
    
    @app.route("/bridge_v2")
    def bridge_v2_index():
        # Main landing page to select Room 1-10
        return render_template("bridge_v2_lobby.html")

    @app.route("/bridge_v2/join", methods=["POST"])
    def bridge_v2_join():
        data = request.json
        room_id = data.get("room_id")
        direction = data.get("direction") # N, E, S, or W
        name = data.get("name")
        passcode = data.get("passcode") # None for first timers

        result = bridge_manager.join_room(room_id, direction, name, passcode)
        return jsonify(result)



    @socketio.on('admin_reset')
    def handle_reset(data):
        # Admin authentication logic would go here
        if data.get("password") == "your_long_phrase_here":
            bridge_manager.reset_room(data['room_id'])
            emit('room_was_reset', room=f"bridge_room_{data['room_id']}")
    @app.route("/bridge_v2/game/<room_id>/<direction>")
    def bridge_v2_game_page(room_id, direction):
        # This renders the actual game board
        return render_template("bridge_v2_game.html", room_id=room_id, direction=direction)

    @app.route("/bridge_v2/check_seats/<room_id>")
    def check_seats(room_id):
        # Helper to tell the frontend which seats are already taken
        room = bridge_manager.rooms.get(str(room_id))
        if not room:
            return jsonify({})
        # Return a dict like {"N": True, "E": False...} where True means occupied
        status = {k: (v is not None) for k, v in room["players"].items()}
        return jsonify(status)            

    @app.route("/bridge_v2/admin", methods=["GET", "POST"])
    def bridge_admin():
        if request.method == "POST":
            pw = request.form.get("password")
            if bridge_manager.verify_admin(pw):
                session['bridge_admin'] = True
                return redirect(url_for('bridge_admin'))
            return "Invalid Password", 403
        
        if not session.get('bridge_admin'):
            return '''
                <form method="post" style="background:#0d1117; color:white; padding:50px; height:100vh;">
                    <h2>Admin Access</h2>
                    <input type="password" name="password" placeholder="Enter Admin Phrase" style="padding:10px; width:300px;">
                    <button type="submit">Login</button>
                </form>
            '''
        
        return render_template("bridge_v2_admin.html", rooms=bridge_manager.rooms)

    @app.route("/bridge_v2/admin/reset/<room_id>", methods=["POST"])
    def admin_reset_room(room_id):
        if not session.get('bridge_admin'):
            return jsonify({"status": "error", "message": "Unauthorized"}), 401
        
        if bridge_manager.reset_room(room_id):
            # Tell all players in this room to kick back to lobby
            socketio.emit('room_reset_broadcast', room=f"bridge_room_{room_id}")
            return jsonify({"status": "success"})
        return jsonify({"status": "error"}), 400  
        
    @socketio.on('request_deal')
    def handle_deal(data):
        room_id = data['room_id']
        # 1. Deal cards
        game_data = bridge_manager.deal_cards(room_id)
        # 2. Broadcast the new state (with hands) to everyone in the room
        emit('game_state_update', {"game": game_data}, room=f"bridge_room_{room_id}")        


    
    


    @socketio.on('join_bridge_room')
    def handle_socket_join(data):
        room_id = str(data['room_id'])
        join_room(f"bridge_room_{room_id}")
        
        room = bridge_manager.rooms.get(room_id)
        if room:
            # Send current state to everyone when someone joins or refreshes
            emit('game_state_update', {
                "game": room['game'], 
                "players": room['players']
            }, room=f"bridge_room_{room_id}")

    @socketio.on('request_deal')
    def handle_request_deal(data):
        room_id = str(data['room_id'])
        room = bridge_manager.rooms.get(room_id)
        
        if not room: return

        # Count actual occupied seats
        player_count = sum(1 for p in room["players"].values() if p is not None)
        
        # Only deal if table is full and we are in waiting phase
        if player_count == 4 and room["game"]["phase"] == "waiting":
            bridge_manager.deal_cards(room_id) 
            
            emit('game_state_update', {
                "game": room['game'], 
                "players": room['players']
            }, room=f"bridge_room_{room_id}")

    @socketio.on('submit_bid')
    def handle_submit_bid(data):
        room_id = str(data['room_id'])
        room = bridge_manager.rooms.get(room_id)
        
        # 1. Validation: Is it this player's turn?
        # (In a real game, you'd check the session/direction here too)
        
        # 2. Add to history
        bid = {
            "player": room["game"]["current_bidder"],
            "level": data.get("level", 0),
            "strain": data.get("strain")
        }
        room["game"]["bid_history"].append(bid)
        
        # 3. Handle Pass logic
        if data.get("strain") == "Pass":
            room["game"]["pass_count"] += 1
        else:
            room["game"]["pass_count"] = 0 # Reset passes if someone bids
        
        # 4. Check for end of bidding (3 passes, or 4 if no one bid)
        if room["game"]["pass_count"] >= 3 and len(room["game"]["bid_history"]) >= 3:
            # For now, just mark play phase (we will add contract logic later)
            room["game"]["phase"] = "play"
        else:
            # Rotate to next bidder
            order = ["N", "E", "S", "W"]
            curr_idx = order.index(room["game"]["current_bidder"])
            room["game"]["current_bidder"] = order[(curr_idx + 1) % 4]
        
        bridge_manager.save_states()
        emit('game_state_update', {
            "game": room['game'], 
            "players": room['players']
        }, room=f"bridge_room_{room_id}")            