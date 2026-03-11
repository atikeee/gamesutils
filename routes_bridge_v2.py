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
        
        # 1. Validation: Does room exist?
        if not room: 
            return

        # 2. Validation: Are there 4 players?
        player_count = sum(1 for p in room["players"].values() if p is not None)
        
        # 3. Only deal if 4 players are present and phase is 'waiting'
        if player_count == 4 and room["game"]["phase"] == "waiting":
            # This triggers the sorting and state update in the manager
            bridge_manager.deal_cards(room_id) 
            
            # 4. Broadcast the FULL state (game + players) so names and hands update
            emit('game_state_update', {
                "game": room['game'], 
                "players": room['players']
            }, room=f"bridge_room_{room_id}")
    @socketio.on('submit_bid')
    def handle_submit_bid(data):
        room_id = str(data['room_id'])
        room = bridge_manager.rooms.get(room_id)
        level = int(data.get("level", 0))
        strain = data.get("strain")
        
        # 1. Bidding Validation Logic
        strain_rank = {"C": 1, "D": 2, "H": 3, "S": 4, "NT": 5}
        last_bid = room["game"].get("highest_bid")
        
        is_pass = (strain == "Pass")
        is_double = (strain in ["X", "XX"])
        
        if not is_pass and not is_double:
            # Check if the new bid is actually higher
            if last_bid:
                new_val = (level * 10) + strain_rank[strain]
                old_val = (last_bid['level'] * 10) + strain_rank[last_bid['strain']]
                if new_val <= old_val:
                    return  # Ignore bid if it's not higher

            # Update Highest Bid (only for suit/NT bids)
            room["game"]["highest_bid"] = {
                "level": level, "strain": strain, 
                "player": room["game"]["current_bidder"],
                "db": "None"
            }
        
        if is_double and last_bid:
            room["game"]["highest_bid"]["db"] = strain

        # 2. History & Turn Rotation
        room["game"]["bid_history"].append({
            "player": room["game"]["current_bidder"], 
            "level": level, 
            "strain": strain
        })
        
        room["game"]["pass_count"] = (room["game"]["pass_count"] + 1) if is_pass else 0
        
        # 3. Phase Transition
        if room["game"]["pass_count"] >= 3 and len(room["game"]["bid_history"]) >= 3:
            if not room["game"]["highest_bid"]:
                room["game"]["phase"] = "waiting" # All passed
            else:
                room["game"]["phase"] = "play"
                winner = room["game"]["highest_bid"]["player"]
                order = ["N", "E", "S", "W"]
                # Identify Dummy (Partner of Winner)
                room["game"]["dummy"] = order[(order.index(winner) + 2) % 4]
                # Next player starts the play
                room["game"]["current_player"] = order[(order.index(winner) + 1) % 4]
        else:
            order = ["N", "E", "S", "W"]
            curr_idx = order.index(room["game"]["current_bidder"])
            room["game"]["current_bidder"] = order[(curr_idx + 1) % 4]
        
        bridge_manager.save_states()
        emit('game_state_update', {"game": room['game'], "players": room['players']}, room=f"bridge_room_{room_id}")
    @socketio.on('play_card')
    def handle_play_card(data):
        room_id = str(data['room_id'])
        room = bridge_manager.rooms.get(room_id)
        player_dir = data['direction']
        card_index = data['card_index']

        game = room["game"]
        
        # 1. Validation
        if game["phase"] != "play": return
        if game["current_player"] != player_dir: return

        # 2. Move card from hand to center
        hand = game["hands"][player_dir]
        played_card = hand.pop(card_index)
        game["current_trick"].append({
            "player": player_dir,
            "card": played_card
        })

        # 3. Check if Trick is complete (4 cards)
        if len(game["current_trick"]) == 4:
            # Identify Winner
            winner = determine_trick_winner(game["current_trick"], game["highest_bid"])
            
            # Update Score
            if winner in ["N", "S"]: game["tricks_won"]["NS"] += 1
            else: game["tricks_won"]["EW"] += 1
            
            # Winner leads the next trick
            game["current_player"] = winner
            
            # IMPORTANT: We usually want players to SEE the 4th card 
            # before the center clears. We'll handle the "Clear" on the next play 
            # or via a short timer logic later.
        else:
            # Rotate turn to next player
            order = ["N", "E", "S", "W"]
            game["current_player"] = order[(order.index(player_dir) + 1) % 4]

        bridge_manager.save_states()
        emit('game_state_update', {"game": game, "players": room['players']}, room=f"bridge_room_{room_id}")

    def determine_trick_winner(trick_cards, contract):
        # trick_cards[0] is the lead card
        lead_suit = trick_cards[0]['card']['suit']
        trump_suit = contract['strain']
        
        best_card = None
        winner = None

        rank_map = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}

        for play in trick_cards:
            card = play['card']
            player = play['player']
            
            score = rank_map[card['val']]
            if card['suit'] == trump_suit:
                score += 100 # Trump beats everything
            elif card['suit'] != lead_suit:
                score = 0 # Wrong suit, no trump = can't win
                
            if best_card is None or score > best_card:
                best_card = score
                winner = player
                
        return winner        