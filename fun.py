import pandas as pd
import csv, os, re,random,json
import sqlite3
from PIL import Image
from io import BytesIO
import base64
from flask import Flask, request, render_template, redirect, url_for,jsonify,render_template_string,abort,send_from_directory,make_response,session,Response
from datetime import datetime,timedelta
import requests
from storage import *
#CATAN_DB_FILE = "catan.db"
JSON_STATE_FILE = "catan_board_state.json"
DB = "flights.db"



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
    with open("clips.csv", newline='') as csvfile:
        reader = csv.reader(csvfile)
        for row in reader:
            url = row[0]
            segments = [(int(row[i]), int(row[i+1])) for i in range(1, len(row), 2)]
            if (not url.strip().startswith('#')):
                clips.append({"url": url, "segments": segments})
    return clips

def extract_video_id(url):
    match = re.search(r"v=([^&]+)", url)
    return match.group(1) if match else None
def generate_letter_mapping():
    import random, string
    letters = list(string.ascii_uppercase)
    while True:
        shuffled = letters[:]
        random.shuffle(shuffled)
        if all(l != s for l, s in zip(letters, shuffled)):
            return dict(zip(letters, shuffled))

# --- Catan Board JSON File Functions ---
def save_catan_board_state_to_json(board_state_json):
    """Saves the current Catan board state to a JSON file."""
    try:
        with open(JSON_STATE_FILE, 'w', encoding='utf-8') as f:
            f.write(board_state_json)
        return True
    except Exception as e:
        print(f"Error saving Catan board state to JSON file: {e}")
        return False

def load_latest_catan_board_state_from_json():
    """Loads the latest Catan board state from a JSON file."""
    if not os.path.exists(JSON_STATE_FILE):
        return None
    try:
        with open(JSON_STATE_FILE, 'r', encoding='utf-8') as f:
            content = f.read()
            if content:
                return content
            return None
    except Exception as e:
        print(f"Error loading Catan board state from JSON file: {e}")
        return None

def get_player_state_file_path(player_id):
    """Generates the file path for a player's state JSON file."""
    if not os.path.exists(PLAYER_STATE_DIR):
        os.makedirs(PLAYER_STATE_DIR)
    return os.path.join(PLAYER_STATE_DIR, f"player_{player_id}_state.json")

def save_player_state_to_json(player_id, player_state_json):
    """Saves a player's current state to a JSON file."""
    file_path = get_player_state_file_path(player_id)
    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(player_state_json)
        return True
    except Exception as e:
        print(f"Error saving player {player_id} state to JSON file: {e}")
        return False

def load_player_state_from_json(player_id):
    """Loads a player's state from a JSON file."""
    file_path = get_player_state_file_path(player_id)
    if not os.path.exists(file_path):
        return None
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
            if content:
                return content
            return None
    except Exception as e:
        print(f"Error loading player {player_id} state from JSON file: {e}")
        return None

