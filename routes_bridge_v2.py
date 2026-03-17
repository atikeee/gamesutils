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
        # Removed password check as requested
        room_id = str(data['room_id'])
        bridge_manager.reset_room(room_id)
        
        room = bridge_manager.rooms.get(room_id)
        if room and "force_dealer" in data:
            room["game"]["dealer"] = data["force_dealer"]
            room["game"]["current_bidder"] = data["force_dealer"]
            
        bridge_manager.save_states()
        emit('room_was_reset', room=f"bridge_room_{room_id}")

    @socketio.on('admin_set_dealer')
    def handle_set_dealer(data):
        room_id = str(data['room_id'])
        room = bridge_manager.rooms.get(room_id)
        
        if room and "force_dealer" in data:
            # Only change the dealer/bidder without resetting hands or scores
            room["game"]["dealer"] = data["force_dealer"]
            room["game"]["current_bidder"] = data["force_dealer"]
            
            bridge_manager.save_states()
            # Notify players of the dealer change immediately
            emit('game_state_update', {"game": room["game"], "players": room['players']}, room=f"bridge_room_{room_id}")



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
        # 3. Phase Transition
        if room["game"]["pass_count"] >= 3 and len(room["game"]["bid_history"]) >= 4:
            if not room["game"]["highest_bid"]:
                room["game"]["phase"] = "waiting" # All passed (Redeal)
            else:
                # Instead of going to 'play', go to the new selection phase
                room["game"]["phase"] = "picking_declarer"
                
                # Reset these so nobody can play yet
                room["game"]["current_player"] = None
                room["game"]["current_bidder"] = None
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
        if not room:
            return
            
        game = room["game"]
        player_dir = data['direction'] # Seat of the person who clicked
        card_index = data['card_index']
        if game.get("claim_data"):
            return
        if game["phase"] != "play":
            return

        # 1. Determine whose turn it is and if the clicker has permission
        current_turn_seat = game["current_player"]
        is_dummy_turn = (current_turn_seat == game["dummy"])
        
        can_play = False
        if not is_dummy_turn:
            # Normal turn: Only the player in the seat can play
            if player_dir == current_turn_seat:
                can_play = True
        else:
            # Dummy turn: Either the dummy clicks their own card, or the declarer clicks it
            if player_dir == current_turn_seat or player_dir == game["declarer"]:
                can_play = True

        if not can_play:
            return

        # 2. Clear old trick if a new lead is happening
        # If there are 4 cards on the table, the new lead clears them
        if len(game["current_trick"]) == 4:
            game["current_trick"] = []

        # 3. Execute the Play
        # Always pop from the current_player's hand
        if card_index >= len(game["hands"][current_turn_seat]):
            return # Safety check

        card = game["hands"][current_turn_seat].pop(card_index)
        game["current_trick"].append({"player": current_turn_seat, "card": card})

        # 4. Dummy Reveal Logic
        # Dummy is revealed only after the very first card of the first trick is played
        total_tricks_completed = game["tricks_won"]["NS"] + game["tricks_won"]["EW"]
        if total_tricks_completed == 0 and len(game["current_trick"]) == 1:
            game["dummy_revealed"] = True

        # 5. Determine Next Turn or Trick Winner
        if len(game["current_trick"]) == 4:
            winner = determine_trick_winner(game["current_trick"], game["highest_bid"])
            
            # Update Team Scores
            if winner in ["N", "S"]:
                game["tricks_won"]["NS"] += 1
            else:
                game["tricks_won"]["EW"] += 1
                
            # Trick winner leads the next trick
            game["current_player"] = winner
        else:
            # Move to next player clockwise
            order = ["N", "E", "S", "W"]
            curr_idx = order.index(current_turn_seat)
            game["current_player"] = order[(curr_idx + 1) % 4]

        # 6. End Round Check
        if (game["tricks_won"]["NS"] + game["tricks_won"]["EW"]) == 13:
            end_round(game, room_id)

        bridge_manager.save_states()
        emit('game_state_update', {"game": game, "players": room['players']}, room=f"bridge_room_{room_id}")    

    @socketio.on('claim_tricks')
    def handle_claim(data):
        room_id = str(data['room_id'])
        room = bridge_manager.rooms.get(room_id)
        game = room["game"]
        
        # Only current player can claim
        if len(game["current_trick"]) == 0 and game["current_player"] == data['direction']:
            game["claim_data"] = {
                "claimer": data['direction'],
                "amount": int(data['amount']),
                "approvals": []
            }
            bridge_manager.save_states()
            emit('game_state_update', {"game": game, "players": room['players']}, room=f"bridge_room_{room_id}")
    @socketio.on('respond_claim')
    def handle_claim_response(data):
        room_id = str(data['room_id'])
        room = bridge_manager.rooms.get(room_id)
        game = room["game"]
        
        if not game.get("claim_data"): 
            return

        player_direction = data['direction']
        claimer = game["claim_data"]["claimer"]
        
        # Determine teams to verify the responder is an opponent
        claimer_team = "NS" if claimer in ["N", "S"] else "EW"
        responder_team = "NS" if player_direction in ["N", "S"] else "EW"

        # Only process if the person responding is an opponent
        if claimer_team != responder_team:
            if data['response'] == 'approve':
                # ACTION: ONE opponent approval is sufficient to end the round
                team = "NS" if claimer in ["N", "S"] else "EW"
                opp_team = "EW" if team == "NS" else "NS"
                
                # Calculate total tricks remaining at the time the claim was made
                # (Note: tricks_won should only be updated after the claim is settled)
                total_played = game["tricks_won"]["NS"] + game["tricks_won"]["EW"]
                remaining = 13 - total_played
                
                claimed_amt = game["claim_data"]["amount"]
                
                # Add claimed tricks to claimer's team, rest to opponents
                game["tricks_won"][team] += claimed_amt
                game["tricks_won"][opp_team] += (remaining - claimed_amt)
                
                # Reset claim data and end the round
                game["claim_data"] = None
                end_round(game, room_id)
            else:
                # ACTION: ONE opponent rejection is sufficient to resume the game
                # Per your request: reveals all cards and clears the claim lock
                game["reveal_all"] = True
                game["claim_data"] = None 

        bridge_manager.save_states()
        emit('game_state_update', {"game": game, "players": room['players']}, room=f"bridge_room_{room_id}")


    def end_round(game, room_id):
        # Fix: Increment Round Number
        game["round_num"] = game.get("round_num", 1) + 1
        
        game["phase"] = "waiting"
        game["hands"] = {"N":[], "E":[], "S":[], "W":[]}
        game["current_trick"] = []
        game["claim_data"] = None
        game["tricks_won"] = {"NS": 0, "EW": 0} # Reset trick counts
        game["highest_bid"] = {"level": 0, "strain": None, "bidder": None}
        game["bid_history"] = []
        game["dummy_revealed"] = False
        game["reveal_all"] = False
        
        bridge_manager.rotate_dealer(room_id)
    def handle_bid(data):
        # ... (existing bid logic)
        
        # NEW RULE: Bidding ends if 3 passes occur AND at least 4 bids total have been made.
        # This prevents the game from ending if the first three people pass immediately.
        consecutive_passes = 0
        for b in reversed(game["bid_history"]):
            if b["bid"] == "Pass":
                consecutive_passes += 1
            else:
                break
                
        if consecutive_passes >= 3 and len(game["bid_history"]) >= 4:
            # Bidding finishes...
            game["phase"] = "picking_declarer"
    def determine_trick_winner(trick_cards, contract):
        """
        Determines the winner of a 4-card trick.
        trick_cards: List of {'player': 'N', 'card': {...}}
        contract: The highest_bid object containing 'strain' (trump)
        """
        lead_suit = trick_cards[0]['card']['suit']
        trump_suit = contract['strain'] # e.g., 'H', 'S', or 'NT'
        
        rank_map = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}
        
        winner_index = 0
        best_score = -1

        for i, play in enumerate(trick_cards):
            card = play['card']
            suit = card['suit']
            rank = rank_map[card['val']]
            
            # Scoring logic:
            # 1. Trump cards get a massive bonus to always beat non-trumps
            # 2. Lead suit cards are evaluated at face value
            # 3. Other suits are evaluated as 0 (cannot win)
            if suit == trump_suit:
                current_score = rank + 100 
            elif suit == lead_suit:
                current_score = rank
            else:
                current_score = 0
                
            if current_score > best_score:
                best_score = current_score
                winner_index = i
                
        return trick_cards[winner_index]['player']       
    @socketio.on('set_declarer')
    def handle_set_declarer(data):
        room_id = str(data['room_id'])
        room = bridge_manager.rooms.get(room_id)
        game = room["game"]
        
        # Verify it's actually the dealer making the choice
        if game["dealer"] == data.get('direction'):
            declarer_choice = data['declarer']
            game["declarer"] = declarer_choice
            game["phase"] = "play"
            
            # Identify Dummy (Partner of Declarer)
            order = ["N", "E", "S", "W"]
            game["dummy"] = order[(order.index(declarer_choice) + 2) % 4]
            
            # The player to the LEFT of the declarer always leads first
            game["current_player"] = order[(order.index(declarer_choice) + 1) % 4]
            
            bridge_manager.save_states()
            emit('game_state_update', {"game": game, "players": room['players']}, room=f"bridge_room_{room_id}")

    @socketio.on('request_end_round')
    def handle_end_round_request(data):
        # Placeholder for End Round logic
        pass

    @socketio.on('request_undo')
    def handle_undo_request(data):
        # Placeholder for Undo logic
        pass            
    @socketio.on('force_end_round')
    def handle_force_end(data):
        room_id = str(data['room_id'])
        room = bridge_manager.rooms.get(room_id)
        game = room["game"]
        
        # Log who ended the round (optional)
        print(f"Round forced to end by {data['direction']} in room {room_id}")
        
        # Reuse existing end_round logic (Resets hands, clears trick, rotates dealer)
        end_round(game, room_id)
        
        bridge_manager.save_states()
        emit('game_state_update', {"game": game, "players": room['players']}, room=f"bridge_room_{room_id}")