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
        room_id = str(data.get("room_id"))
        direction = data.get("direction")
        name = data.get("name", "").strip()
        passcode = (data.get("passcode") or "").strip().upper()  # handles None safely

        if not room_id or not direction or not name:
            return jsonify({"status": "error", "message": "Missing fields"})

        result = bridge_manager.join_room(room_id, direction, name, passcode)

        if result["status"] == "ok":
            session['bridge_room_id'] = room_id
            session['bridge_direction'] = direction
            session['bridge_passcode'] = result["passcode"]

        return jsonify(result)
    @app.route("/bridge_v2/check_seats/<room_id>")
    def check_seats(room_id):
        room = bridge_manager.rooms.get(str(room_id))
        if not room:
            return jsonify({})
        status = {}
        for k, v in room["players"].items():
            if v is None:
                status[k] = "empty"
            else:
                status[k] = "occupied"  # has passcode set
        return jsonify(status)
        
    @socketio.on('admin_reset')
    def handle_reset(data):
        room_id = str(data['room_id'])
        bridge_manager.rooms[room_id] = bridge_manager._new_room()
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



    @app.route("/bridge_v2/play")
    def bridge_v2_play():
        room_id = session.get('bridge_room_id')
        direction = session.get('bridge_direction')
        passcode = session.get('bridge_passcode', '')
        if not room_id or not direction:
            return redirect('/bridge_v2')
        return render_template("bridge_v2_game.html", 
                               room_id=room_id, 
                               direction=direction,
                               passcode=passcode)

         

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
        bridge_manager.rooms[str(room_id)] = bridge_manager.get_default_room_state()
        bridge_manager.save_states()
        socketio.emit('room_was_reset', room=f"bridge_room_{room_id}")
        return jsonify({"status": "success"})
    


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
        if not room: return
        
        game = room["game"]
        level = int(data.get("level", 0))
        strain = data.get("strain")
        
        # 1. Bidding Validation
        strain_rank = {"C": 1, "D": 2, "H": 3, "S": 4, "NT": 5}
        last_bid = game.get("highest_bid") # This might be None
        
        is_pass = (strain == "Pass")
        is_double = (strain in ["X", "XX"])
        
        if not is_pass and not is_double:
            # If there's an existing bid, validate that the new one is higher
            if last_bid and last_bid.get('level', 0) > 0:
                new_val = (level * 10) + strain_rank[strain]
                old_val = (last_bid['level'] * 10) + strain_rank[last_bid['strain']]
                if new_val <= old_val:
                    return 

            game["highest_bid"] = {
                "level": level, "strain": strain, 
                "player": game["current_bidder"], "db": "None"
            }
        elif is_double and last_bid and last_bid.get('level', 0) > 0:
            game["highest_bid"]["db"] = strain

        # 2. Update History
        history = game.get("bid_history", [])
        history.append({
            "player": game["current_bidder"], 
            "level": level, 
            "strain": strain
        })

        # 3. Check End of Bidding
        consecutive_passes = 0
        for b in reversed(history):
            if b["strain"] == "Pass":
                consecutive_passes += 1
            else:
                break

        # Case A: Pass Out (First 4 passes)
        if len(history) == 4 and consecutive_passes == 4:
            # Rotate dealer and increment round
            game["round"] = game.get("round", 1) + 1
            bridge_manager.rotate_dealer(room_id)
            
            # Reset state for re-deal
            game["phase"] = "waiting"
            game["bid_history"] = []
            game["highest_bid"] = None # Reset to None safely
            game["hands"] = {"N":[], "E":[], "S":[], "W":[]}
            game["tricks_won"] = {"NS": 0, "EW": 0}

        # Case B: Auction ends (3 passes after a real bid)
        elif len(history) > 3 and consecutive_passes == 3:
            game["phase"] = "picking_declarer"
        
        else:
            # Rotate turn clockwise
            order = ["N", "E", "S", "W"]
            game["current_bidder"] = order[(order.index(game["current_bidder"]) + 1) % 4]

        bridge_manager.save_states()
        emit('game_state_update', {"game": game, "players": room['players']}, room=f"bridge_room_{room_id}")    
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
            game["last_completed_trick"] = list(game["current_trick"])
            winner = determine_trick_winner(game["current_trick"], game["highest_bid"])
            
            # Update Team Scores
            if winner in ["N", "S"]:
                game["tricks_won"]["NS"] += 1
            else:
                game["tricks_won"]["EW"] += 1
                
            # Trick winner leads the next trick
            game["current_player"] = winner
            #game["current_trick"] = []
            
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
        if not room:
            return
        game = room["game"]
        
        amount = data.get('amount')
        if amount is None:
            return

        current_trick = game.get("current_trick", [])
        isTrickEmpty = len(current_trick) == 0
        isTrickComplete = len(current_trick) == 4
        
        if not (isTrickEmpty or isTrickComplete):
            return

        if game["current_player"] != data['direction']:
            return

        game["claim_data"] = {
            "claimer": data['direction'],
            "amount": int(amount),
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


    @socketio.on('request_undo')
    def handle_undo_request(data):
        room_id = str(data['room_id'])
        room = bridge_manager.rooms.get(room_id)
        if not room:
            return
        game = room["game"]
        game["undo_requested_by"] = data['direction']
        bridge_manager.save_states()
        emit('game_state_update', {"game": game, "players": room['players']}, room=f"bridge_room_{room_id}")

    @socketio.on('accept_undo')
    def handle_accept_undo(data):
        room_id = str(data['room_id'])
        room = bridge_manager.rooms.get(room_id)
        if not room:
            return
        game = room["game"]

        # Only an opponent of the requester can accept
        requester = game.get("undo_requested_by")
        if not requester:
            return
        req_team = "NS" if requester in ["N", "S"] else "EW"
        acc_team = "NS" if data['direction'] in ["N", "S"] else "EW"
        if req_team == acc_team:
            return

        # Roll back the last played card
        if game.get("last_completed_trick"):
            # Undo after a completed trick — restore all 4 cards
            for play in reversed(game["last_completed_trick"]):
                game["hands"][play["player"]].insert(0, play["card"])
            # Reverse the trick score
            winner = game["current_player"]
            if winner in ["N", "S"]:
                game["tricks_won"]["NS"] = max(0, game["tricks_won"]["NS"] - 1)
            else:
                game["tricks_won"]["EW"] = max(0, game["tricks_won"]["EW"] - 1)
            game["current_player"] = game["last_completed_trick"][0]["player"]
            game["current_trick"] = list(game["last_completed_trick"])
            game["last_completed_trick"] = []
        elif game.get("current_trick"):
            # Undo mid-trick — restore just the last card played
            last_play = game["current_trick"].pop()
            game["hands"][last_play["player"]].insert(0, last_play["card"])
            order = ["N", "E", "S", "W"]
            game["current_player"] = last_play["player"]

        game["undo_requested_by"] = None
        bridge_manager.save_states()
        emit('game_state_update', {"game": game, "players": room['players']}, room=f"bridge_room_{room_id}")        
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
    @socketio.on('accept_round')
    def handle_accept_round(data):
        room_id = str(data['room_id'])
        room = bridge_manager.rooms.get(room_id)
        if not room:
            return
        # Accept simply ends the round cleanly — same as force end
        end_round(room["game"], room_id)
        bridge_manager.save_states()
        emit('game_state_update', {"game": room["game"], "players": room['players']}, room=f"bridge_room_{room_id}")
        
        