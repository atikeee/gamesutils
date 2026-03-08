import random
import json
import os

WORDS = ["Apple", "River", "Bridge", "Spade", "Heart", "Diamond", "Club", "Forest", "Mountain", "Ocean"]

class BridgeManager:
    def __init__(self, state_file="bridge_v2_state.json"):
        self.state_file = state_file
        self.rooms = self.load_all_states()

    def load_all_states(self):
        """Loads the JSON database or initializes it if missing."""
        if os.path.exists(self.state_file):
            with open(self.state_file, 'r') as f:
                return json.load(f)
        # Initialize 10 empty rooms if file doesn't exist
        initial_state = {str(i): self.get_default_room_state() for i in range(1, 11)}
        self.rooms = initial_state
        self.save_states()
        return initial_state


    def save_states(self):
        """Writes the current memory state to the JSON file."""
        with open(self.state_file, 'w') as f:
            json.dump(self.rooms, f, indent=4)

    def verify_admin(self, provided_password):
        """Checks password against the server's admin_config.txt file."""
        try:
            with open("admin_config.txt", "r") as f:
                stored_password = f.read().strip()
            return provided_password == stored_password
        except FileNotFoundError:
            print("CRITICAL: admin_config.txt not found!")
            return False

    def join_room(self, room_id, direction, name, provided_passcode=None):
        """Handles player registration and re-entry."""
        room = self.rooms.get(str(room_id))
        if not room: return {"error": "Room not found"}

        player = room["players"][direction]

        # Case 1: Seat is empty - Register New Player
        if player is None:
            new_passcode = random.choice(WORDS) + str(random.randint(10, 99))
            room["players"][direction] = {
                "name": name,
                "passcode": new_passcode
            }
            self.save_states()
            return {"status": "success", "passcode": new_passcode, "message": "Registered"}

        # Case 2: Seat is occupied - Re-entry Check
        if player["name"] == name and player["passcode"] == provided_passcode:
            return {"status": "success", "message": "Welcome back"}
        
        return {"error": "Seat occupied or wrong passcode"}

    def reset_room(self, room_id):
        """Wipes a specific room back to default."""
        room_id_str = str(room_id)
        if room_id_str in self.rooms:
            self.rooms[room_id_str] = self.get_default_room_state()
            self.save_states()
            return True
        return False

    def get_default_room_state(self):
        return {
            "players": {"N": None, "E": None, "S": None, "W": None},
            "game": {
                "round": 1,
                "dealer": "N", # Starts with North
                "phase": "waiting", # waiting, bidding, playing
                "hands": {"N":[], "E":[], "S":[], "W":[]},
                "tricks_won": {"NS": 0, "EW": 0},
                "current_bid": "None",
                "declarer": None,
                "dummy": None,
                "current_trick": []
            },
            "config": {"max_rounds": 12}
        }

    def deal_cards(self, room_id):
        room = self.rooms.get(str(room_id))
        
        # Restoration of your specific deck logic
        suits = ['S', 'H', 'D', 'C']
        values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A']
        deck = [{'suit': s, 'val': v} for s in suits for v in values]
        random.shuffle(deck)

        # Distribute 13 cards to each player
        room["game"]["hands"]["N"] = deck[0:13]
        room["game"]["hands"]["E"] = deck[13:26]
        room["game"]["hands"]["S"] = deck[26:39]
        room["game"]["hands"]["W"] = deck[39:52]
        
        room["game"]["phase"] = "bidding"
        self.save_states()
        return room["game"]
        
    def rotate_dealer(self, room_id):
        room = self.rooms.get(str(room_id))
        order = ["N", "E", "S", "W"]
        curr_idx = order.index(room["game"]["dealer"])
        room["game"]["dealer"] = order[(curr_idx + 1) % 4]
        self.save_states()

    def get_default_room_state(self):
        return {
            "players": {"N": None, "E": None, "S": None, "W": None},
            "game": {
                "round": 1,
                "dealer": "N", 
                "phase": "waiting",
                "hands": {"N":[], "E":[], "S":[], "W":[]},
                "tricks_won": {"NS": 0, "EW": 0}, # Ensure this exists
                "current_bid": "None",
                "dummy": None,
                "current_trick": []
            }
        }

    def deal_cards(self, room_id):
        room = self.rooms.get(str(room_id))
        
        # Restored your specific deck and shuffle logic
        suits = ['S', 'H', 'D', 'C']
        values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A']
        deck = [{'suit': s, 'val': v} for s in suits for v in values]
        random.shuffle(deck)

        # Distribute 13 cards to each player
        room["game"]["hands"]["N"] = deck[0:13]
        room["game"]["hands"]["E"] = deck[13:26]
        room["game"]["hands"]["S"] = deck[26:39]
        room["game"]["hands"]["W"] = deck[39:52]
        
        room["game"]["phase"] = "bidding" 
        self.save_states()
        return room["game"]