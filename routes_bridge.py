from fun import *
import json
import os

BRIDGE_STATE_FILE = "bridge_game_state.json"

# ── Default empty state ──────────────────────────────────────────
def default_state():
    return {
        "players": {"N": "North", "S": "South", "E": "East", "W": "West"},
        "rows": [{"id": 1, "contract": None, "tricks": None}]
    }

# ── File helpers (no database — JSON file like catan) ────────────
def load_bridge_state():
    if not os.path.exists(BRIDGE_STATE_FILE):
        return default_state()
    try:
        with open(BRIDGE_STATE_FILE, "r", encoding="utf-8") as f:
            content = f.read()
            if content:
                return json.loads(content)
    except Exception as e:
        print(f"Error loading bridge state: {e}")
    return default_state()

def save_bridge_state(state):
    try:
        with open(BRIDGE_STATE_FILE, "w", encoding="utf-8") as f:
            f.write(json.dumps(state))
        return True
    except Exception as e:
        print(f"Error saving bridge state: {e}")
        return False

# ── Scoring logic (mirrors your Gradio calculate_point) ──────────
def calculate_point(bid, suite, win, double, vul):
    suite_point = 30
    dbl = 1
    play_score = 0
    play_bonus = 0
    game_score = 0
    fc_score = 0
    ot_score = 0
    ot_score_mul = 0
    down_score = 0
    slam_bonus = 0

    nvd = [0,100,300,500,800,1100,1400,1700,2000,2300,2600,2900,3200,3500]
    vd  = [0,200,500,800,1100,1400,1700,2000,2300,2600,2900,3200,3500,3800]
    nvr = [0,200,600,1000,1600,2200,2800,3400,4000,4600,5200,5800,6400,7000]
    vr  = [0,400,1000,1600,2200,2800,3400,4000,4600,5200,5800,6400,7000,7600]

    if suite in ["C", "D"]:
        suite_point = 20
    if double == "Double":
        ot_score_mul = 200 if vul == "Vulnerable" else 100
        dbl = 2
        fc_score = 50
    elif double == "Redouble":
        ot_score_mul = 400 if vul == "Vulnerable" else 200
        dbl = 4
        fc_score = 100

    ot = win - bid - 6
    bid_point = bid * suite_point
    win_point = (win - 6) * suite_point

    if suite == "N":
        bid_point += 10
        win_point += 10

    bid_point *= dbl
    win_point *= dbl

    if ot < 0:
        fc_score = 0
        i = -ot
        if double == "Redouble":
            down_score = vr[i] if vul == "Vulnerable" else nvr[i]
        elif double == "Double":
            down_score = vd[i] if vul == "Vulnerable" else nvd[i]
        else:
            down_score = i * 100 if vul == "Vulnerable" else i * 50
        total_score = -down_score
    else:
        if bid_point >= 100:
            game_score = 500 if vul == "Vulnerable" else 300
            if bid == 7:
                slam_bonus = 1500 if vul == "Vulnerable" else 1000
            elif bid == 6:
                slam_bonus = 750 if vul == "Vulnerable" else 500
        else:
            play_bonus = 50
        play_score = win_point if dbl == 1 else bid_point
        ot_score = ot * ot_score_mul
        total_score = play_score + fc_score + game_score + play_bonus + ot_score + slam_bonus

    return {
        "total_score": total_score,
        "play_score": play_score,
        "play_bonus": play_bonus,
        "fc_score": fc_score,
        "ot_score": ot_score,
        "game_score": game_score,
        "slam_bonus": slam_bonus,
        "down_score": down_score,
    }


# ── Routes ───────────────────────────────────────────────────────
def configure_routes_bridge(app, socketio):

    @app.route("/bridge")
    def bridge():
        return render_template("bridge.html")

    @app.route("/bridge/gamescore")
    def bridge_gamescore():
        return render_template("bridge_gamescore.html")

    # ── REST: load state (called on page load) ──
    @app.route("/bridge/state", methods=["GET"])
    def bridge_get_state():
        state = load_bridge_state()
        return jsonify({"status": "success", "state": state})

    # ── REST: save full state ──
    @app.route("/bridge/state", methods=["POST"])
    def bridge_save_state():
        try:
            state = request.json
            if not state:
                return jsonify({"status": "error", "message": "No state provided"}), 400
            if save_bridge_state(state):
                # Broadcast to all other connected clients
                socketio.emit("bridge_state_update", state)
                return jsonify({"status": "success"})
            return jsonify({"status": "error", "message": "Failed to save"}), 500
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── REST: reset state ──
    @app.route("/bridge/state/reset", methods=["POST"])
    def bridge_reset_state():
        state = default_state()
        if save_bridge_state(state):
            socketio.emit("bridge_state_update", state)
            return jsonify({"status": "success", "state": state})
        return jsonify({"status": "error"}), 500

    # ── REST: single-call score calculator ──
    @app.route("/bridge/score", methods=["POST"])
    def bridge_score():
        try:
            bid    = int(request.form.get("bid"))
            suite  = request.form.get("suite")
            win    = int(request.form.get("win"))
            double = request.form.get("double")
            vul    = request.form.get("vul")
            result = calculate_point(bid, suite, win, double, vul)
            return jsonify({"status": "success", "result": result})
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 400

    # ── SocketIO: client can also push state directly ──
    @socketio.on("bridge_push_state")
    def handle_bridge_push(state):
        save_bridge_state(state)
        socketio.emit("bridge_state_update", state)