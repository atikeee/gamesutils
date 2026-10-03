import os
import random

from flask import jsonify, redirect, render_template, request, url_for
from dashboard import PROJECT_ROOT, dashboard_tile

from storage import (
    pf_cards,
    pf_cur_savedwords,
    pf_cur_skippedwords,
    pf_deck,
    pf_level,
    pf_player_idx,
    pf_players,
    pf_score,
    pf_timer,
    pf_word_idx,
)


def configure_routes_panchforon(app, socketio):
    data_dir = os.path.join(PROJECT_ROOT, 'data')

    @app.route("/panchforon/namelist", methods=["GET", "POST"])
    @dashboard_tile(section="board", title="Panchforon", description="Register players and set up a three-level word game.", icon="pencil", order=40)
    def panchforon_namelist():
        global pf_players, pf_deck, pf_level, pf_score
        pf_words_file = os.path.join(data_dir, 'pf_words.txt')

        message = ""

        if request.method == "POST":
            action = request.form.get("action")
            if action == "add":
                name = request.form.get("player")
                if name and name not in pf_players:
                    pf_players.append(name)
                else:
                    message = "Name already exists or is empty."
            elif action == "clear":
                pf_players.clear()
            elif action == "delete":
                name = request.form.get("name_to_del")
                if name in pf_players:
                    pf_players.remove(name)
            elif action == "randomize":
                random.shuffle(pf_players)
            elif action == "start":
                try:
                    pf_level = 1
                    for player in pf_players:
                        pf_score[player] = [0, 0, 0]
                    with open(pf_words_file, encoding="utf-8") as f:
                        words = [line.strip() for line in f if line.strip()]
                    pf_deck = random.sample(words, len(pf_players) * 3)
                    return redirect(url_for("panchforon_play"))
                except FileNotFoundError:
                    message = "Word file not found."
        return render_template("panchforon/panchforon_namelist.html", pf_players=pf_players)

    @app.route("/panchforon/play")
    @dashboard_tile(section="board", title="Panchforon Play", description="Play three rounds of increasing word-game difficulty.", icon="play", order=50)
    def panchforon_play():
        global pf_level, pf_player_idx, pf_players, pf_deck, pf_word_idx, pf_cards, pf_cur_savedwords, pf_cur_skippedwords
        if not pf_players:
            return redirect(url_for('panchforon_namelist'))  # fallback if no players or deck

        if pf_level > 3:
            return redirect(url_for('panchforon_status'))
        print("pfdeck", pf_deck)
        print("pfcard", pf_cards)
        timer_value = pf_timer[pf_level - 1]

        return render_template("panchforon/play.html",
                           pf_level=pf_level,
                           pf_players=pf_players,
                           pf_player_idx=pf_player_idx,
                           timer=timer_value,
                           pf_deck=pf_deck,
                           pf_word_idx=pf_word_idx,
                           pf_cards=pf_cards,
                           pf_cur_skippedwords=pf_cur_skippedwords,
                           pf_cur_savedwords=pf_cur_savedwords
                           )

    @app.route("/panchforon/next_player_confirm", methods=["POST"])
    def next_player_confirm():
        global pf_player_idx, pf_cards, pf_deck, pf_cur_savedwords, pf_cur_skippedwords
        #data = request.get_json()
        #if not data:
        #    return jsonify({"error": "No data received"}), 400

        #pf_cards = data.get("pf_cards", {})
        #pf_deck = data.get("pf_deck", [])

        #pf_player_idx = (pf_player_idx + 1) % len(pf_players)
        #socketio.emit("update_progress")
        print("xx", pf_cur_savedwords)
        print("xxx", pf_cur_skippedwords)
        current_player = pf_players[pf_player_idx]
        print("before: ", pf_cards, pf_deck)
        if current_player not in pf_cards:
            pf_cards[current_player] = []
        for card in pf_cur_savedwords:
            pf_cards[current_player].append(card)
            pf_deck.remove(card)
        random.shuffle(pf_deck)
        print("after: ", pf_cards, pf_deck)
        pf_cur_savedwords = []
        pf_cur_skippedwords = []
        confirmed = request.form.get("confirmed")
        if confirmed == "yes":
            pf_player_idx = (pf_player_idx + 1) % len(pf_players)
            socketio.emit("update_progress")
        return redirect(url_for("panchforon_play"))

    @app.route("/panchforon/next_level", methods=["POST"])
    def panchforon_next_level():
        global pf_players, pf_deck, pf_level, pf_cards, pf_word_idx, pf_score
        if pf_level < 4:
            pf_word_idx = 0
            for player in pf_players:
                if player not in pf_score:
                    pf_score[player] = [0, 0, 0]
                words = pf_cards.get(player, [])
                pf_score[player][pf_level - 1] = len(words)

            # 1. Clear pf_players
            all_words = []
            for player in pf_players:
                if player in pf_cards:
                    all_words.extend(pf_cards[player])  # Combine all words
            pf_deck = all_words
            pf_cards.clear()  # Clear player dictionary

            # 2. Increment pf_level
            socketio.emit("update_result")
            pf_level += 1
            return jsonify({"status": "ok", "pf_level": pf_level, "pf_deck": pf_deck})
        return redirect(url_for('panchforon_status'))

    @app.route("/panchforon/status")
    @dashboard_tile(section="board", title="Panchforon Score", description="View live team scores and game progress.", icon="chart", order=60)
    def panchforon_status():
        # Progress Table: transpose words into columns
        max_len = max((len(v) for v in pf_cards.values()), default=0)
        progress_rows = []
        for i in range(max_len):
            row = []
            for player in pf_players:
                row.append(pf_cards.get(player, [])[i] if i < len(pf_cards.get(player, [])) else "")
            progress_rows.append(row)

        # Result Table from pf_score
        result_data = {}
        for player in pf_players:
            level_scores = pf_score.get(player, [0, 0, 0])
            total = sum(level_scores)
            result_data[player] = level_scores + [total]

        return render_template("panchforon/status.html",
                            players=pf_players,
                            progress_rows=progress_rows,
                            result_data=result_data)

    @app.route("/panchforon/review", methods=["GET", "POST"])
    @dashboard_tile(section="board", title="Panchforon Review", description="Review saved or skipped words for the current player.", icon="review", order=70)
    def panchforon_review():
        global pf_player_idx, pf_cards, pf_players, pf_deck, pf_cur_savedwords, pf_cur_skippedwords

        socketio.emit("update_progress")
        current_player = pf_players[pf_player_idx]

        if request.method == "POST":
            if request.is_json:
                data = request.get_json()
                print("jsondata", data)
                #return '', 204  # No Content, avoids JSON parse errors in JS
            else:
                skippedwords = request.form.get("skippedwords", '')
                savedwords = request.form.get("savedwords", '')
                if skippedwords:
                    pf_cur_skippedwords.remove(skippedwords)
                    pf_cur_savedwords.append(skippedwords)
                if savedwords:
                    pf_cur_savedwords.remove(savedwords)
                    pf_cur_skippedwords.append(savedwords)

                #print(" word", word_to_save,word_to_delete,pf_cards[current_player])
                #if word_to_delete and (current_player in pf_cards):
                #    if word_to_delete in pf_cards[current_player]:
                #        pf_cur_skippedwords.remove(word_to_delete)
                #        pf_cards[current_player].remove(word_to_delete)
                #        pf_deck.append(word_to_delete)
                #if word_to_save and (current_player in pf_cards):
                #    if word_to_save not in pf_cards[current_player]:
                #        pf_cur_savedwords.remove(word_to_save)
                #        pf_cards[current_player].append(word_to_save)
                #        pf_deck.remove(word_to_save)
                #print("word to delete:", word_to_delete)
                #print("word to save:", word_to_save)
            print("list: ", pf_cur_savedwords, pf_cur_skippedwords)

            #saved_words = pf_cards.get(current_player, [])
        return render_template("panchforon/review.html", player=current_player, pf_cur_savedwords=pf_cur_savedwords, pf_cur_skippedwords=pf_cur_skippedwords)

    @app.route("/panchforon/review_save", methods=["GET", "POST"])
    def panchforon_review_save():
        global pf_cur_savedwords
        if request.method == "POST":
            data = request.get_json()
            saved_word = data.get("saved_word")
            pf_cur_savedwords.append(saved_word)
            print("after save", pf_cur_savedwords)
        return '', 204

    @app.route("/panchforon/review_skip", methods=["GET", "POST"])
    def panchforon_review_skip():
        global pf_cur_skippedwords
        if request.method == "POST":
            data = request.get_json()
            skipped_word = data.get("skipped_word")
            pf_cur_skippedwords.append(skipped_word)
            print("after skip", pf_cur_skippedwords)
        return '', 204