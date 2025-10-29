from fun import *
from ppp import process_links,OUTPUT_FILE,INPUT_FILE,ERROR_FILE

def configure_routes(app,socketio):
    @app.route("/")
    def index():
        return render_template("index.html")

   
    @app.route("/buzzer", methods=["GET", "POST"])
    def buzzer():
        message = ''
        name_value = request.cookies.get('name', '')
        name_locked = request.cookies.get('name_locked')
        #name_locked = name_locked_cookie == 'true'

        if request.method == 'POST':
            if not name_locked:
                name = request.form.get('name')
                ip = request.remote_addr
                time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                note = request.form.get('note')
                message = f"Buzz from {name} recorded!"
                buzzer_entries.append({'name': name, 'ip': ip, 'note': note, 'time': time})
                resp = make_response(render_template("buzzer.html", message=message, name=name, name_locked=True, note=""))
                
                resp.set_cookie('name', name)
                resp.set_cookie('name_locked', 'true')
                return resp
            else:
                name = name_value
                note = request.form.get('note')
                ip = request.remote_addr
                time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                message = f"Buzz from {name} recorded!"
                buzzer_entries.append({'name': name, 'ip': ip, 'note': note, 'time': time})
                socketio.emit('buzz_trigger',{'name':name})
                return render_template("buzzer.html", message=message, name=name, name_locked=True, note=note)

        return render_template("buzzer.html", message=message, name=name_value, name_locked=name_locked, note="")




    @app.route('/report', methods=['GET', 'POST'])
    def report():
        if request.method == 'POST':
            buzzer_entries.clear()
        return render_template("report.html", entries=buzzer_entries)

    @app.route('/resetnames', methods=['POST'])
    def reset_names():
        buzzer_entries.clear()
        name_locks.clear()
        return redirect('/report')
    @app.route('/shuffle', methods=['POST'])
    def shuffle_names():
        unique_names = list(set([entry['name'] for entry in buzzer_entries]))
        from random import shuffle
        shuffle(unique_names)
        return render_template("report.html", entries=buzzer_entries, unique_names=unique_names)
    
    @app.route('/photoscramble', methods=['GET', 'POST'])
    def photoscramble():
        #if not is_request_from_localhost():
        #    abort(403)  # Forbidden
        photo_folder = 'photos'
        image_list = sorted([f for f in os.listdir(photo_folder) if f.lower().endswith(('png', 'jpg', 'jpeg'))])
        #print(image_list)
        index = int(request.args.get('index', 0))
        n = int(request.form.get('grid_size', request.args.get('n', 20)))

        if index < 0:
            index = 0
        if index >= len(image_list):
            index = len(image_list) - 1

        image_path = os.path.join(photo_folder, image_list[index])
        scrambled = scramble_image(image_path, n)

        return render_template("photoscramble.html",
                               image_data=scrambled,
                               index=index,
                               n=n,
                               total=len(image_list),
                               has_prev=index > 0,
                               has_next=index < len(image_list) - 1)
    @app.route('/guesstune')
    def guesstune():
        clips = load_clips()
        clip_index = int(request.args.get("clip", 0))
        segment_index = int(request.args.get("seg", 0))

        clip_index = max(0, min(clip_index, len(clips) - 1))
        segment_index = max(0, segment_index)

        clip = clips[clip_index]
        video_id = extract_video_id(clip["url"])
        segments = clip["segments"]
        segment = segments[segment_index % len(segments)]
        solution_start, solution_end = segments[-1]  # Use last pair for solution

        return render_template("guesstune.html",
            video_id=video_id,
            start=segment[0],
            end=segment[1],
            clip_index=clip_index,
            segment_index=segment_index,
            total_clips=len(clips),
            total_segments=len(segments),
            solution_start=solution_start,
            solution_end=solution_end
        )

    @app.route('/photopair', methods=['GET'])
    def photopair():
        m = int(request.args.get("m", 3))
        n = int(request.args.get("n", 8))
        delay = int(request.args.get("delay", 2000))
        folder = "photopair"
        pairs = find_image_pairs(folder)
        needed = (m * n) // 2
        if len(pairs) < needed:
            images = []
        else:
            selected = random.sample(pairs, needed)
            images = []
            for base in selected:
                images.append(f"{base}1.jpg")
                images.append(f"{base}2.jpg")
            random.shuffle(images)

        return render_template("photopair.html", m=m, n=n, delay=delay, images=images)

    @app.route('/photopair_images/<filename>')
    def photopair_image(filename):
        return send_from_directory("photopair", filename)
    @app.route('/misc_image/<filename>')
    def misc_image(filename):
        return send_from_directory('misc', filename)
    @app.route('/misc')
    def misc():
        index = int(request.args.get("index", 0))
        csv_path = "misc_data.csv"
        if not os.path.exists(csv_path):
            return "CSV file not found."

        df = pd.read_csv(csv_path, comment='#').fillna("")
        index = max(0, min(index, len(df) - 1))
        data = df.iloc[index].to_dict()
        data["index"] = index
        data["total"] = len(df)
        #data["hide_image"]=True
        print(data)
        #try:
        #    hide_image = str(row[4]).strip() == "1"
        #except IndexError:
        hide_image = True
        return render_template("misc.html", data=data)
    @app.route('/riddle')
    def riddle():
        import glob

        index = int(request.args.get("index", 0))
        files = sorted(glob.glob("riddle/q*.txt"))

        if not files:
            return "No riddle files found."

        index = max(0, min(index, len(files) - 1))

        with open(files[index], 'r', encoding='utf-8') as f:
            parts = f.read().split("***")
            question = parts[0].strip() if len(parts) > 0 else ""
            answer = parts[1].strip() if len(parts) > 1 else ""
            hint = parts[2].strip() if len(parts) > 2 else ""

        data = {
            "question": question,
            "answer": answer,
            "hint": hint,
            "index": index,
            "total": len(files)
        }

        return render_template("riddle.html", data=data)
    @app.route('/crack', methods=['GET'])
    def crack():
        with open("crack.txt", encoding="utf-8") as f:
            raw_text = f.read()

        lines = [line.strip() for line in raw_text.split("***") if line.strip() and not line.strip().startswith("#")]

        index = int(request.args.get("index", 0))
        index = max(0, min(index, len(lines)))

        revealed = lines[:index]
        current = lines[index] if index < len(lines) else None
        more_left = index < len(lines) - 1
        def encode(text, mapping):
            return ''.join(mapping.get(ch.upper(), ch) for ch in text)

        mapping = generate_letter_mapping()
        data = []

        for line in lines:
            answer = line.upper()
            cipher = encode(answer, mapping)
            data.append({'question': cipher, 'answer': answer})

        
        return render_template("crack.html", data=data,revealed=revealed, current=current, index=index, more_left=more_left)
    @app.route("/codenames")
    def codenames():
        last_team = hint_log[-1][0] if hint_log else "Red"

        if not current_game['words']:  # Only if game not started
            return redirect(url_for('start_codenames'))

        return render_template(
            "codenames.html",
            words=current_game['words'],
            colors=current_game['colors'],
            last_team=last_team,
            hint_log=hint_log,
            revealed=current_game.get('revealed', set()),  # ✅ Add this line
            winner=current_game.get('winner')
        )
    @app.route("/codenames_spy2", methods=["GET", "POST"])
    def codenames_spy2():
        global hint_log

        if not current_game['words']:  # fallback safety
            return redirect(url_for('start_codenames'))

        if request.method == "POST":
            hint = request.form.get("hint")
            count = request.form.get("count")
            hint_log.append([current_game['team'], hint, count])  # updated structure
            current_game['team'] = "blue" if current_game['team'] == "red" else "red"
            if hint:
                socketio.emit('new_hint',{'hint':hint, 'count':count})
        return render_template(
            "codenames_spy.html",
            words=current_game['words'],
            colors=current_game['colors'],
            hint_log=hint_log,
            current_team=current_game['team'],
            zip=zip
        )

    @app.route("/codenames_spy", methods=["GET", "POST"])
    def codenames_spy():
        global hint_log
        print("password:::")
        print(codenames_spy_password)
        if request.method == "POST" and 'spy_password' in request.form:
            submitted_password = request.form.get("spy_password")
            if submitted_password == codenames_spy_password:
                session['spy_authenticated'] = True
            else:
                return render_template("codenames_spy.html", access_denied=True)

        if not session.get('spy_authenticated'):
            return render_template("codenames_spy.html", require_password=True)

        if not current_game['words']:
            return redirect(url_for('start_codenames'))

        if request.method == "POST" and 'hint' in request.form:
            hint = request.form.get("hint")
            count = request.form.get("count")
            hint_log.append([current_game['team'], hint, count])
            current_game['team'] = "blue" if current_game['team'] == "red" else "red"
            if hint:
                socketio.emit('new_hint', {'hint': hint, 'count': count})

        return render_template("codenames_spy.html",
                            words=current_game['words'],
                            colors=current_game['colors'],
                            hint_log=hint_log,
                            current_team=current_game['team'],
                            zip=zip)
    @app.route("/start_codenames")
    def start_codenames():
        global hint_log
        session.pop('spy_authenticated', None)
        base_dir = os.path.dirname(os.path.abspath(__file__))
        word_folder = os.path.join(base_dir, 'codename-words')
        all_words = []

        for filename in os.listdir(word_folder):
            if filename.endswith(".txt"):
                with open(os.path.join(word_folder, filename), encoding='utf-8') as f:
                    for line in f:
                        word = line.strip()
                        if word and re.match(r'^[a-zA-Z]', word):  # Only lines starting with letters
                            all_words.append(word)
        print("Total words read: ",len(all_words))
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
    
    @app.route("/reveal/<int:index>", methods=["POST"])
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

        current_game['winner'] = winner  # ✅ Save winner
        return jsonify({"winner": winner})
        #return redirect(url_for('codenames'))
        #return '', 204  # no content
    @app.route("/set_password", methods=["GET", "POST"])
    def set_password():
        global codenames_spy_password
        if request.method == "POST":
            password = request.form.get("password")
            if password:
                codenames_spy_password = password
                return redirect(url_for("codenames"))  # or any page you want
        return render_template("set_password.html")
    @app.route("/panchforon/namelist", methods=["GET", "POST"])
    def panchforon_namelist():
        global pf_players, pf_deck,pf_level,pf_score
        pf_words_file = 'pf_words.txt'

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
                    pf_level=1
                    for player in pf_players:
                        pf_score[player] = [0,0,0]
                    with open(pf_words_file , encoding="utf-8") as f:
                        words = [line.strip() for line in f if line.strip()]
                    pf_deck = random.sample(words, len(pf_players) * 3)  # example multiplier
                    
                    return redirect(url_for("panchforon_play"))
                except FileNotFoundError:
                    message = "Word file not found."
        return render_template("panchforon_namelist.html", pf_players=pf_players)

    @app.route("/panchforon/play")
    def panchforon_play():
        global pf_level,pf_player_idx,pf_players,pf_deck,pf_word_idx,pf_cards,pf_cur_savedwords,pf_cur_skippedwords
        if not pf_players:
            return redirect(url_for('panchforon_namelist'))  # fallback if no players or deck

        if(pf_level>3):
            return redirect(url_for('panchforon_status'))
        print("pfdeck",pf_deck)
        print("pfcard",pf_cards)
        timer_value = pf_timer[pf_level-1]

        return render_template("play.html",
                           pf_level=pf_level,
                           pf_players=pf_players,
                           pf_player_idx=pf_player_idx,
                           timer=timer_value,
                           pf_deck=pf_deck,
                           pf_word_idx = pf_word_idx,
                           pf_cards=pf_cards,
                           pf_cur_skippedwords = pf_cur_skippedwords,
                           pf_cur_savedwords = pf_cur_savedwords
                           )

    @app.route("/panchforon/next_player_confirm", methods=["POST"])
    def next_player_confirm():
        global pf_player_idx, pf_cards, pf_deck, pf_cur_savedwords,pf_cur_skippedwords
        #data = request.get_json()
        #if not data:
        #    return jsonify({"error": "No data received"}), 400

        #pf_cards = data.get("pf_cards", {})
        #pf_deck = data.get("pf_deck", [])

        #pf_player_idx = (pf_player_idx + 1) % len(pf_players)
        #socketio.emit("update_progress")
        print("xx",pf_cur_savedwords)
        print("xxx", pf_cur_skippedwords)
        current_player = pf_players[pf_player_idx]
        print("before: ",pf_cards,pf_deck)
        if current_player not in pf_cards:
            pf_cards[current_player] = []
        for card in pf_cur_savedwords:
            pf_cards[current_player].append(card)
            pf_deck.remove(card)
        random.shuffle(pf_deck)
        print("after: ",pf_cards,pf_deck)
        pf_cur_savedwords = []
        pf_cur_skippedwords = []
        confirmed = request.form.get("confirmed")
        if confirmed == "yes":
            pf_player_idx = (pf_player_idx + 1) % len(pf_players)
            socketio.emit("update_progress")
        return redirect(url_for("panchforon_play"))
        
    @app.route("/panchforon/next_level", methods=["POST"])
    def panchforon_next_level():
        global pf_players, pf_deck, pf_level,pf_cards, pf_word_idx,pf_score
        if(pf_level<4):
            pf_word_idx = 0
            for player in pf_players:
                if player not in pf_score:
                    pf_score[player] = [0, 0, 0]
                words = pf_cards.get(player, [])
                pf_score[player][pf_level - 1] = len(words)

            # 1. Clear pf_players
            all_words = []
            for player in pf_players:
                if(player in pf_cards):
                    all_words.extend(pf_cards[player])  # Combine all words
            pf_deck = all_words

            pf_cards.clear()  # Clear player dictionary

            # 2. Increment pf_level
            socketio.emit("update_result")
            pf_level += 1
            return jsonify({"status": "ok", "pf_level": pf_level, "pf_deck": pf_deck})
        else:
            return redirect(url_for('panchforon_status'))


    @app.route("/panchforon/status")
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

        return render_template("status.html",
                            players=pf_players,
                            progress_rows=progress_rows,
                            result_data=result_data)
    @app.route("/panchforon/review", methods=["GET", "POST"])
    def panchforon_review():
        global pf_player_idx, pf_cards, pf_players, pf_deck,pf_cur_savedwords,pf_cur_skippedwords

        socketio.emit("update_progress")
        current_player = pf_players[pf_player_idx]

        if request.method == "POST":
            if request.is_json:
                data = request.get_json()
                print("jsondata",data)
                #return '', 204  # No Content, avoids JSON parse errors in JS
                
            else:  # only when tries to delete or unsave any items. 
                skippedwords = request.form.get("skippedwords",'')
                savedwords = request.form.get("savedwords",'')
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
            print("list: ",pf_cur_savedwords,pf_cur_skippedwords)

        #saved_words = pf_cards.get(current_player, [])
        return render_template("review.html", player=current_player, pf_cur_savedwords=pf_cur_savedwords,pf_cur_skippedwords=pf_cur_skippedwords)

    @app.route("/panchforon/review_save", methods=["GET", "POST"])
    def panchforon_review_save():
        global pf_cur_savedwords
        if request.method == "POST":
            data = request.get_json()
            saved_word = data.get("saved_word")
            pf_cur_savedwords.append(saved_word)
            print("after save",pf_cur_savedwords)
        return '', 204
    @app.route("/panchforon/review_skip", methods=["GET", "POST"])
    def panchforon_review_skip():
        global pf_cur_skippedwords
        if request.method == "POST":
            data = request.get_json()
            skipped_word = data.get("skipped_word")
            pf_cur_skippedwords.append(skipped_word)
            print("after skip",pf_cur_skippedwords)
        return '', 204
        
    @app.route('/shuffle_cards')
    def shuffle_cards():
        card_folder = 'cards'
        card_files = sorted([
            f for f in os.listdir(card_folder)
            if f.lower().endswith(('.png', '.jpg', '.jpeg'))
        ])
        return render_template("shuffle_cards.html", cards=card_files)
        
    @app.route('/cards/<filename>')
    def serve_card_image(filename):
        return send_from_directory('cards', filename)              
        
    @app.route("/playmedia")
    def playmedia():
        MEDIA_FOLDER = 'vdo'
        media_files = [f for f in os.listdir(MEDIA_FOLDER) if f.lower().endswith(('.mp4', '.webm', '.ogg'))]
        media_files.sort()
        return render_template("playmedia.html", media_files=media_files)
        
    @app.route('/vdo/<filename>')
    def serve_vdo_files(filename):
        return send_from_directory('vdo', filename)   

    @app.route('/leetcode/<path:filename>')
    def send_leetcode_static(filename):
        return send_from_directory('templates/leetcode', filename)        

    @app.route('/links')
    def send_links():
        return send_from_directory('templates', 'links.html')        
        
    @app.route('/delta/view')
    def view_page2():
        # Initialize lists for unique sources and destinations
        src_list = set()
        dst_list = set()
        rows_data = [] # To store all flight data as lists (matching row[0], row[1] etc.)

        try:
            conn = sqlite3.connect(DB)
            conn.row_factory = sqlite3.Row # Allows access by column name
            cursor = conn.cursor()
            
            # Fetch all flights
            cursor.execute("SELECT flightno, src, dst, departure, arrival, duration FROM flights ORDER BY src, dst")
            all_flights = cursor.fetchall()
            conn.close()

            for flight in all_flights:
                # Add src and dst to their respective sets to ensure uniqueness
                src_list.add(flight['src'])
                dst_list.add(flight['dst'])
                
                # Append the flight data as a list of values
                # Ensure the order matches your HTML table columns: Flight No, From, To, Departure, Arrival, Duration
                
                rows_data.append([
                    flight['flightno'],
                    flight['src'],
                    flight['dst'],
                    datetime.strptime(flight['departure'], '%Y-%m-%d %H:%M:%S').strftime('%H:%M'),
                    datetime.strptime(flight['arrival'], '%Y-%m-%d %H:%M:%S').strftime('%H:%M'),
                    flight['duration']
                ])

        except Exception as e:
            print(f"Error fetching data for view_page2: {e}")
            # In a real app, you might want to return an error page or message
            return "Error loading data", 500

        # Convert sets to sorted lists for consistent dropdown order
        sorted_src_list = sorted(list(src_list))
        sorted_dst_list = sorted(list(dst_list))

        # Prepare the 'data' dictionary for the template
        template_data = {
            'srclist': sorted_src_list,
            'dstlist': sorted_dst_list,
            'rows': rows_data
        }

        # Render the template, passing the prepared data
        return render_template("delta_view2.html", data=template_data)
        

    @app.route('/delta/')
    def view_page():
        conn = sqlite3.connect(DB)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("""
            SELECT id,flightno, src, dst, departure, arrival, duration
            FROM flights
        """)
        rows = cur.fetchall()
        conn.close()

        # Organize data by destination
        data_by_dest = {}
        for row in rows:
            dst = row['dst']
            src = row ['src']
            srcdst = src+'=>'+dst
            departure = datetime.strptime(row['departure'], '%Y-%m-%d %H:%M:%S')
            arrival = datetime.strptime(row['arrival'], '%Y-%m-%d %H:%M:%S')
            #print('date format',row['departure'],departure,arrival)
            if srcdst not in data_by_dest:
                data_by_dest[srcdst] = []
            data_by_dest[srcdst].append({
                'flightno': row['flightno'],
                'departure': departure.strftime('%H:%M'),
                'arrival': arrival.strftime('%H:%M'),
                'duration':row['duration'],
                'id':row['id']
            })

        return render_template("delta_view.html", data=data_by_dest)

        
    @app.route("/delta/add", methods=["GET", "POST"])
    def index_delta():
        message = ""
        if request.method == "POST":
            try:
                flightno = request.form["flightno"]
                src = request.form["src"].upper()
                dst = request.form["dst"].upper()
                departure = request.form["departure"]
                arrival = request.form["arrival"]
                duration = int(request.form["duration"])

                # Validate time format
                datetime.strptime(departure, "%Y-%m-%d %H:%M:%S")
                datetime.strptime(arrival, "%Y-%m-%d %H:%M:%S")

                conn = sqlite3.connect(DB)
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT INTO flights (flightno, src, dst, departure, arrival, duration)
                    VALUES (?, ?, ?, ?, ?, ?)
                ''', (flightno, src, dst, departure, arrival, duration))
                conn.commit()
                conn.close()
                message = "✅ Flight added successfully!"
            except Exception as e:
                message = f"❌ Error: {e}"
        
        return render_template("delta_update_form.html",message=message)
        #return render_template_string(HTML_TEMPLATE, message=message)
        
    @app.route("/delta/delete_flight/<int:flight_id>", methods=["POST"])
    def delete_flight(flight_id):
        try:
            conn = sqlite3.connect(DB)
            cursor = conn.cursor()
            cursor.execute("DELETE FROM flights WHERE id = ?", (flight_id,))
            conn.commit()
            conn.close()
            # Return a JSON response indicating success
            return jsonify(success=True, message=f"Flight {flight_id} deleted successfully.")
        except Exception as e:
            print(f"Error deleting flight {flight_id}: {e}")
            # Return a JSON response indicating failure with an error message
            return jsonify(success=False, message=str(e)), 500 # Return 500 status for server error
    # --- NEW ROUTE FOR PARSING FLIGHTS VIA WEB FORM ---
    @app.route("/delta/parse_flights", methods=["GET", "POST"])
    def parse_flights_page():
        message = ""
        if request.method == "POST":
            src_iata = request.form.get("src_iata", "").upper()
            dst_iata = request.form.get("dst_iata", "").upper()

            if not src_iata or not dst_iata:
                message = "❌ Error: Both Source and Destination IATA codes are required."
            else:
                try:
                    # Get tomorrow's date in YYYY-MM-DD format
                    query_date = (datetime.now() + timedelta(days=1)).strftime('%Y-%m-%d')

                    API_KEY = '26ae356c0b45057250bdca8fbaacd231'  # Replace with your actual key
                    BASE_URL = 'http://api.aviationstack.com/v1/flights'
                    
                    # List to store results from both directions
                    all_parsed_flights = []

                    # Iterate for both SRC->DST and DST->SRC
                    for i in range(2):
                        current_src = src_iata if i == 0 else dst_iata
                        current_dst = dst_iata if i == 0 else src_iata

                        params = {
                            'access_key': API_KEY,
                            'dep_iata': current_src,
                            'arr_iata': current_dst,
                            'airline_iata':'DL',
                            'limit': 20, # Limit results to 20 per query
                            'flight_date': query_date # Add flight date to params
                        }

                        response = requests.get(BASE_URL, params=params)
                        data = response.json()
                        print(data)
                        if 'data' not in data or not data['data']:
                            # print(f"API error or no data for {current_src}->{current_dst}: {data}")
                            message += f"⚠️ Warning: No flights found for {current_src} to {current_dst}. "
                            continue # Continue to the next direction

                        conn = sqlite3.connect(DB)
                        cursor = conn.cursor()

                        for flight in data['data']:
                            airline = flight.get('airline', {}).get('name')
                            flight_number = flight.get('flight', {}).get('iata')
                            
                            # Only process Delta flights
                            if 'Delta' not in str(airline): 
                                continue

                            departure_time = flight.get('departure', {}).get('scheduled')
                            arrival_time = flight.get('arrival', {}).get('scheduled')
                            
                            # Use iata codes from the API response for accuracy
                            api_src = flight.get('departure', {}).get('iata')
                            api_dst = flight.get('arrival', {}).get('iata')

                            if departure_time and arrival_time and api_src and api_dst:
                                try:
                                    dep_dt = datetime.fromisoformat(departure_time.replace('Z', '+00:00'))
                                    arr_dt = datetime.fromisoformat(arrival_time.replace('Z', '+00:00'))

                                    duration_minutes = int((arr_dt - dep_dt).total_seconds() // 60)

                                    cursor.execute('''
                                        INSERT INTO flights (flightno, src, dst, departure, arrival, duration)
                                        VALUES (?, ?, ?, ?, ?, ?)
                                    ''', (
                                        flight_number,
                                        api_src, # Use API's src
                                        api_dst, # Use API's dst
                                        dep_dt.strftime('%Y-%m-%d %H:%M:%S'),
                                        arr_dt.strftime('%Y-%m-%d %H:%M:%S'),
                                        duration_minutes
                                    ))
                                    all_parsed_flights.append(f"{airline} {flight_number} ({api_src} to {api_dst}) added.")

                                except ValueError as ve:
                                    print(f"Date parsing error for flight {flight_number}: {ve}")
                                    message += f"❌ Error parsing date for {flight_number}. "
                                except Exception as insert_e:
                                    print(f"Database insert error for flight {flight_number}: {insert_e}")
                                    message += f"❌ Error saving {flight_number} to DB. "
                            else:
                                print(f"{airline} {flight_number} — Missing time/airport info\n")
                                message += f"⚠️ Warning: Missing info for {flight_number}. "
                        
                        conn.commit()
                        conn.close() # Close connection after each direction's processing

                    if not message: # If no warnings or errors, assume success
                        message = f"✅ Flight data parsed and saved successfully for {src_iata} and {dst_iata}!"
                    elif "Error" in message:
                        message = "❌ Some errors occurred during parsing: " + message
                    else:
                        message = "⚠️ Warnings during parsing: " + message

                except requests.exceptions.RequestException as req_e:
                    message = f"❌ Network Error: Could not connect to API. {req_e}"
                except Exception as e:
                    message = f"❌ An unexpected error occurred: {e}"
        return render_template("delta_parseflights.html", message=message)
    @app.route('/ppp_tool', methods=['GET', 'POST'])
    def ppp_tool_page():
        """
        Handles the web interface for the ppp.py script.
        GET: Displays the form.
        POST: Processes the form data using ppp.py and displays the result.
        """
        result = ""
        download_link_available = False # Flag to control download link visibility
        view_link_available = False # Flag to control view link visibility

        if request.method == 'POST':
            beg_str = request.form.get('beg', '1')
            end_str = request.form.get('end', '0')

            # Basic input validation
            try:
                beg = int(beg_str)
                end = int(end_str)
            except ValueError:
                result = "Error: 'Beg' and 'End' must be valid numbers."
                return render_template('ppp_tool.html', result=result, download_link_available=download_link_available, view_link_available=view_link_available)

            # Call the process_links function from ppp.py
            # ppp.py is now responsible for reading from _input.txt and writing to OUTPUT_FILE
            processed_result_message = process_links(beg, end)
            result = processed_result_message

            # Check if processing was successful to enable download and view links
            if result.startswith("✅"): # Assuming success message starts with "✅"
                download_link_available = True
                view_link_available = True # Enable view link too

        return render_template('ppp_tool.html', result=result, download_link_available=download_link_available, view_link_available=view_link_available, output_filename=OUTPUT_FILE)
    # END NEW ROUTE

    @app.route(f'/ppp_tool/input')
    def view_ppp_input():
        """
        Displays the content of _input.txt with line numbers prepended to each line.
        """
        if os.path.exists(INPUT_FILE):
            try:
                with open(INPUT_FILE, 'r', encoding='utf-8') as f:
                    lines = f.readlines() # Read all lines, including empty ones
                
                formatted_content = []
                for i, line in enumerate(lines):
                    # Remove newline character first, then prepend line number and two spaces
                    stripped_line = line.rstrip('\n')
                    formatted_content.append(f"{i+1:04d}  {stripped_line}")
                
                # Join with newline characters to preserve line breaks
                return Response("\n".join(formatted_content), mimetype='text/plain')
            except Exception as e:
                return f"Error reading input file: {e}", 500
        else:
            return "Error: Input file `_input.txt` not found on the server.", 404

    @app.route(f'/ppp_tool/error') # Use f-string for dynamic filename
    def view_ppp_error():
        """
        Allows users to view the zzz.m3u file directly in the browser without styling.
        """
        if os.path.exists(ERROR_FILE):
            try:
                with open(ERROR_FILE, 'r', encoding='utf-8') as f:
                    content = f.read()
                # Return the content with text/plain MIME type
                return Response(content, mimetype='text/plain')
            except Exception as e:
                return f"Error reading output file: {e}", 500
        else:
            return "Error: Output file not found. Please process the URLs first.", 404
    @app.route('/ppp_tool/<filename>')
    def view_m3u_file(filename):
        """
        Allows users to view any specified .m3u file directly in the browser 
        with a 'text/plain' MIME type.
        """
        # 1. Basic validation to ensure the requested file is an .m3u file
        if not filename.endswith('.m3u'):
            return "Invalid file type. Only .m3u files can be viewed.", 400
        full_path = filename 

        if os.path.exists(full_path):
            try:
                with open(full_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                return Response(content, mimetype='text/plain')
                
            except Exception as e:
                return f"Error reading file {filename}: {e}", 500
        else:
            return f"File **{filename}** not found.", 404
        
    #@app.route(f'/ppp_output') # Use f-string for dynamic filename
    #def view_ppp_output():
    #    """
    #    Allows users to view the zzz.m3u file directly in the browser without styling.
    #    """
    #    if os.path.exists(OUTPUT_FILE):
    #        try:
    #            with open(OUTPUT_FILE, 'r', encoding='utf-8') as f:
    #                content = f.read()
    #            # Return the content with text/plain MIME type
    #            return Response(content, mimetype='text/plain')
    #        except Exception as e:
    #            return f"Error reading output file: {e}", 500
    #    else:
    #        return "Error: Output file not found. Please process the URLs first.", 404

    @app.route('/ppp_tool/download')
    def download_ppp_output():
        """
        Allows users to download the zzz.m3u file.
        """
        # Ensure the file exists before sending
        if os.path.exists(OUTPUT_FILE):
            # send_from_directory will securely serve the file
            # as_attachment=True will prompt a download
            return send_from_directory(os.getcwd(), OUTPUT_FILE, as_attachment=True)
        else:
            return "Error: Output file not found. Please process the URLs first.", 404
