import base64
import csv
import os
import random
import re
from io import BytesIO

import pandas as pd
from flask import render_template, request, send_from_directory
from PIL import Image

from dashboard import PROJECT_ROOT, dashboard_sections, dashboard_tile

def is_request_from_localhost():
    return request.remote_addr in ("127.0.0.1", "localhost", "::1")

def find_image_pairs(folder):
    files = os.listdir(folder)
    bases = set()
    for f in files:
        if f.endswith("1.jpg"):
            base = f[:-5]
            if f"{base}2.jpg" in files:
                bases.add(base)
    return list(bases)

def scramble_image(image_path, n):
    image = Image.open(image_path)
    width, height = image.size
    tile_w, tile_h = width // n, height // n
    tiles = []

    for i in range(n):
        for j in range(n):
            box = (j * tile_w, i * tile_h, (j + 1) * tile_w, (i + 1) * tile_h)
            tiles.append(image.crop(box))

    random.shuffle(tiles)
    new_img = Image.new('RGB', (width, height))
    for idx, tile in enumerate(tiles):
        i, j = divmod(idx, n)
        new_img.paste(tile, (j * tile_w, i * tile_h))

    buf = BytesIO()
    new_img.save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode()

def load_clips():
    clips = []
    clips_path = os.path.join(PROJECT_ROOT, "data", "clips.csv")
    with open(clips_path, newline='') as csvfile:
        reader = csv.reader(csvfile)
        for row in reader:
            url = row[0]
            segments = [(int(row[i]), int(row[i+1])) for i in range(1, len(row), 2)]
            if not url.strip().startswith('#'):
                clips.append({"url": url, "segments": segments})
    return clips

def extract_video_id(url):
    match = re.search(r"v=([^&]+)", url)
    return match.group(1) if match else None

def generate_letter_mapping():
    import string
    letters = list(string.ascii_uppercase)
    while True:
        shuffled = letters[:]
        random.shuffle(shuffled)
        if all(left != right for left, right in zip(letters, shuffled)):
            return dict(zip(letters, shuffled))

def configure_routes(app,socketio):
    data_dir = os.path.join(PROJECT_ROOT, 'data')

    @app.route("/")
    def index():
        return render_template("main/index.html", dashboard_sections=dashboard_sections(app))

   
    @app.route('/photoscramble', methods=['GET', 'POST'])
    @dashboard_tile(section="quiz", title="Photo Scramble", description="Guess the image behind scrambled tiles.", icon="puzzle", order=30)
    def photoscramble():
        #if not is_request_from_localhost():
        #    abort(403)  # Forbidden
        photo_folder = os.path.join(data_dir, 'photos')
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

        return render_template("main/photoscramble.html",
                               image_data=scrambled,
                               index=index,
                               n=n,
                               total=len(image_list),
                               has_prev=index > 0,
                               has_next=index < len(image_list) - 1)
    @app.route('/guesstune')
    @dashboard_tile(section="media", title="Guess the Tune", description="Listen to a short clip and guess the track.", icon="music", order=10)
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

        return render_template("main/guesstune.html",
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
    @dashboard_tile(section="quiz", title="Photo Pair", description="Match photo pairs in a timed memory game.", icon="photo", order=40)
    def photopair():
        m = int(request.args.get("m", 3))
        n = int(request.args.get("n", 8))
        delay = int(request.args.get("delay", 2000))
        folder = os.path.join(data_dir, 'photopair')
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

        return render_template("main/photopair.html", m=m, n=n, delay=delay, images=images)

    @app.route('/photopair/image/<filename>')
    def photopair_image(filename):
        return send_from_directory(os.path.join(data_dir, 'photopair'), filename)
    @app.route('/misc/image/<filename>')
    def misc_image(filename):
        return send_from_directory(os.path.join(data_dir, 'misc'), filename)
    @app.route('/misc')
    @dashboard_tile(section="quiz", title="Misc Quiz", description="Browse photo questions, hints, and answers.", icon="question", order=50)
    def misc():
        index = int(request.args.get("index", 0))
        csv_path = os.path.join(data_dir, 'misc_data.csv')
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
        return render_template("main/misc.html", data=data)
    @app.route('/riddle')
    @dashboard_tile(section="quiz", title="Riddles", description="Solve flashcard-style riddles and reveal answers.", icon="brain", order=60)
    def riddle():
        import glob

        index = int(request.args.get("index", 0))
        files = sorted(glob.glob(os.path.join(data_dir, 'riddle', 'q*.txt')))

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

        return render_template("main/riddle.html", data=data)
    @app.route('/crack', methods=['GET'])
    @dashboard_tile(section="quiz", title="Crack the Code", description="Decrypt scrambled answers letter by letter.", icon="unlock", order=70)
    def crack():
        with open(os.path.join(data_dir, "crack.txt"), encoding="utf-8") as f:
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

        
        return render_template("main/crack.html", data=data,revealed=revealed, current=current, index=index, more_left=more_left)
    @app.route('/shuffle_cards')
    @dashboard_tile(section="cards", title="Shuffle Deck", description="View a freshly shuffled 52-card deck.", icon="deck", order=30)
    def shuffle_cards():
        card_folder = os.path.join(data_dir, 'cards')
        card_files = sorted([
            f for f in os.listdir(card_folder)
            if f.lower().endswith(('.png', '.jpg', '.jpeg'))
        ])
        return render_template("main/shuffle_cards.html", cards=card_files)
        
    @app.route('/cards/<filename>')
    def serve_card_image(filename):
        return send_from_directory(os.path.join(data_dir, 'cards'), filename)
        
    @app.route("/playmedia")
    @dashboard_tile(section="media", title="Play Media", description="Play audio clips and reveal videos.", icon="headphones", order=20)
    def playmedia():
        MEDIA_FOLDER = 'vdo'
        media_files = [f for f in os.listdir(MEDIA_FOLDER) if f.lower().endswith(('.mp4', '.webm', '.ogg'))]
        media_files.sort()
        return render_template("main/playmedia.html", media_files=media_files)
        
    @app.route('/vdo/<filename>')
    def serve_vdo_files(filename):
        return send_from_directory('vdo', filename)   

    @app.route('/leetcode/<path:filename>')
    @dashboard_tile(section="tools", title="LeetCode 150", description="Browse the LeetCode Top 150 problem reference.", icon="code", order=30, values={"filename": "index.html"})
    def send_leetcode_static(filename):
        return send_from_directory('templates/leetcode', filename)        
    #@app.route('/links')
    #def send_links():
    #    return send_from_directory('templates', 'links.html')        
