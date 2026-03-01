from fun import *

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

    if ot < 0:  # Down
        fc_score = 0
        i = -ot
        if double == "Redouble":
            down_score = vr[i] if vul == "Vulnerable" else nvr[i]
        elif double == "Double":
            down_score = vd[i] if vul == "Vulnerable" else nvd[i]
        else:
            down_score = i * 100 if vul == "Vulnerable" else i * 50
        total_score = -down_score
    else:  # Made
        if bid_point >= 100:  # Game
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


def configure_routes_bridge(app, socketio):

    @app.route("/bridge")
    def bridge():
        return render_template("bridge.html")

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