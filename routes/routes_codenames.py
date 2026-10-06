import os
import random
import re

from flask import jsonify, redirect, render_template, request, session, url_for
from dashboard import PROJECT_ROOT, dashboard_tile

hint_log = []
codenames_spy_password = 'xxx'
current_game = {
    'words': [],
    'colors': [],
    'revealed': set(),
    'team': 'red',
}


def configure_routes_codenames(app, socketio):
    data_dir = os.path.join(PROJECT_ROOT, 'data')

    @app.route("/codenames")
    @dashboard_tile(section="board", title="Codenames", description="Play a red-versus-blue clue-giving word game.", icon="spy", order=10)
    def codenames():
        last_team = hint_log[-1][0] if hint_log else "Red"

        if not current_game['words']:
            return redirect(url_for('start_codenames'))

        return render_template(
            "codenames/codenames.html",
            words=current_game['words'],
            colors=current_game['colors'],
            last_team=last_team,
            hint_log=hint_log,
            revealed=current_game.get('revealed', set()),
            winner=current_game.get('winner')
        )

    @app.route("/codenames/spy2", methods=["GET", "POST"])
    @dashboard_tile(section="board", title="Spy View 2", description="Codenames spymaster view 2.", icon="spy", order=80)
    def codenames_spy2():
        global hint_log

        if not current_game['words']:
            return redirect(url_for('start_codenames'))

        if request.method == "POST":
            hint = request.form.get("hint")
            count = request.form.get("count")
            hint_log.append([current_game['team'], hint, count])
            current_game['team'] = "blue" if current_game['team'] == "red" else "red"
            if hint:
                socketio.emit('new_hint', {'hint': hint, 'count': count})
        return render_template(
            "codenames/codenames_spy.html",
            words=current_game['words'],
            colors=current_game['colors'],
            hint_log=hint_log,
            current_team=current_game['team'],
            zip=zip
        )

    @app.route("/codenames/spy1", methods=["GET", "POST"])
    @dashboard_tile(section="board", title="Spy View 1", description="Codenames spymaster view 1.", icon="spy", order=20)
    def codenames_spy():
        global hint_log, codenames_spy_password

        if request.method == "POST" and 'spy_password' in request.form:
            submitted_password = request.form.get("spy_password")
            if submitted_password == codenames_spy_password:
                session['spy_authenticated'] = True
            else:
                return render_template("codenames/codenames_spy.html", access_denied=True)

        if not session.get('spy_authenticated'):
            return render_template("codenames/codenames_spy.html", require_password=True)

        if not current_game['words']:
            return redirect(url_for('start_codenames'))

        if request.method == "POST" and 'hint' in request.form:
            hint = request.form.get("hint")
            count = request.form.get("count")
            hint_log.append([current_game['team'], hint, count])
            current_game['team'] = "blue" if current_game['team'] == "red" else "red"
            if hint:
                socketio.emit('new_hint', {'hint': hint, 'count': count})

        return render_template("codenames/codenames_spy.html",
                               words=current_game['words'],
                               colors=current_game['colors'],
                               hint_log=hint_log,
                               current_team=current_game['team'],
                               zip=zip)

    @app.route("/codenames/start")
    def start_codenames():
        global hint_log
        session.pop('spy_authenticated', None)
        word_folder = os.path.join(data_dir, 'codename-words')
        all_words = []

        for filename in os.listdir(word_folder):
            if filename.endswith(".txt"):
                with open(os.path.join(word_folder, filename), encoding='utf-8') as f:
                    for line in f:
                        word = line.strip()
                        if word and re.match(r'^[a-zA-Z]', word):
                            all_words.append(word)
        print("Total words read: ", len(all_words))
        selected_words = random.sample(all_words, 25)
        color_list = ['red'] * 9 + ['blue'] * 8 + ['black'] + ['gray'] * 7
        random.shuffle(color_list)
        current_game['words'] = selected_words
        current_game['colors'] = color_list
        current_game['revealed'] = set()
        current_game['team'] = 'red'
        current_game['winner'] = None
        hint_log.clear()
        socketio.emit("new_game")
        return redirect(url_for('set_password'))

    @app.route("/codenames/reveal/<int:index>", methods=["POST"])
    def reveal_word(index):
        current_game['revealed'].add(index)
        red_revealed = sum(1 for i in current_game['revealed'] if current_game['colors'][i] == 'red')
        blue_revealed = sum(1 for i in current_game['revealed'] if current_game['colors'][i] == 'blue')
        black_revealed = any(current_game['colors'][i] == 'black' for i in current_game['revealed'])
        winner = None
        if black_revealed:
            winner = "Blue" if hint_log and hint_log[-1][0] == "red" else "Red"
        elif red_revealed == 9:
            winner = "Red"
        elif blue_revealed == 8:
            winner = "Blue"

        current_game['winner'] = winner
        return jsonify({"winner": winner})

    @app.route("/codenames/set_password", methods=["GET", "POST"])
    def set_password():
        global codenames_spy_password
        if request.method == "POST":
            password = request.form.get("password")
            if password:
                codenames_spy_password = password
                return redirect(url_for("codenames"))
        return render_template("codenames/set_password.html")