# routes_triage_email.py
from flask import jsonify, render_template, request, send_from_directory
from dashboard import PROJECT_ROOT, dashboard_tile
import json
import os
import subprocess
import sys
import threading

# Assuming the data file is in the same directory as the app
DATA_FILE = "triage_email_data.json"
DATA_PREFIX = "triage_email_data"
BASE_DIR = os.path.join(PROJECT_ROOT, "data")
PROCESS4_PATH = os.path.join(PROJECT_ROOT, "scripts", "triage_email_process4.py")
PROCESS4_LOCK = threading.Lock()
PROCESS4_OUTPUT_LOCK = threading.Lock()
PROCESS4_OUTPUT = {"running": False, "lines": [], "return_code": None, "imported_rows": []}


def _import_item_keys():
    path = os.path.join(BASE_DIR, DATA_FILE)
    if not os.path.exists(path):
        return set()
    with open(path, encoding='utf-8') as data_file:
        data = json.load(data_file)
    return {(section_name, str(item_id)) for section_name, section in data.items()
            for item_id in section.get('ind_dats', {})}


def _list_data_files():
    files = []
    if not os.path.isdir(BASE_DIR):
        return files
    for name in os.listdir(BASE_DIR):
        if name.startswith(DATA_PREFIX) and name.endswith('.json'):
            full_path = os.path.join(BASE_DIR, name)
            if os.path.isfile(full_path):
                files.append(name)
    return sorted(files)


def _resolve_data_file(candidate):
    data_files = _list_data_files()
    if not data_files:
        return None, []

    if not candidate:
        selected = DATA_FILE if DATA_FILE in data_files else data_files[0]
        return selected, data_files

    # Prevent path traversal; only allow plain filenames in root.
    safe_name = os.path.basename(candidate)
    if (
        safe_name != candidate
        or not safe_name.startswith(DATA_PREFIX)
        or not safe_name.endswith('.json')
        or safe_name not in data_files
    ):
        selected = DATA_FILE if DATA_FILE in data_files else data_files[0]
        return selected, data_files

    return safe_name, data_files

def configure_routes_triage_email(app):

    def append_process4_output(line):
        with PROCESS4_OUTPUT_LOCK:
            PROCESS4_OUTPUT["lines"].append(line)
            PROCESS4_OUTPUT["lines"] = PROCESS4_OUTPUT["lines"][-2000:]
    
    @app.route('/triage_email_dashboard')
    @dashboard_tile(section="tools", title="Triage Email", description="Review and update triage email items.", icon="mail", order=60)
    def triage_email_dashboard():
        requested_file = request.args.get('data_file')
        selected_file, data_files = _resolve_data_file(requested_file)
        if not selected_file:
            # No JSON yet; the import script creates it.
            return render_template(
                'triage_email_dashboard.html',
                data={},
                data_files=[],
                selected_data_file=DATA_FILE,
            )

        data_file_path = os.path.join(BASE_DIR, selected_file)
        if not os.path.exists(data_file_path):
            return "Data file not found", 404
        with open(data_file_path, 'r') as f:
            data = json.load(f)
        return render_template(
            'triage_email_dashboard.html',
            data=data,
            data_files=data_files,
            selected_data_file=selected_file,
        )

    def run_triage_process4(previous_keys):
        try:
            unread_keys = set()
            append_process4_output("[triage-email] Starting triage_email_process4.py")
            process = subprocess.Popen(
                [sys.executable, "-u", PROCESS4_PATH],
                cwd=PROJECT_ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
            if process.stdout:
                for line in process.stdout:
                    line = line.rstrip("\r\n")
                    if line.startswith('[triage-row] '):
                        try:
                            row = json.loads(line[len('[triage-row] '):])
                            if isinstance(row, dict) and isinstance(row.get('section'), str) and isinstance(row.get('item_id'), str):
                                unread_keys.add((row['section'], row['item_id']))
                        except ValueError:
                            pass
                    else:
                        append_process4_output(line)
            return_code = process.wait()
            current_keys = _import_item_keys()
            imported_rows = [{'section': section, 'item_id': item_id}
                             for section, item_id in sorted((unread_keys | (current_keys - previous_keys)) & current_keys)]
            with PROCESS4_OUTPUT_LOCK:
                PROCESS4_OUTPUT["return_code"] = return_code
                PROCESS4_OUTPUT["imported_rows"] = imported_rows
            append_process4_output(
                f"[triage-email] Script finished with exit code {return_code}"
            )
        except Exception as error:
            append_process4_output(f"[triage-email] Failed to run script: {error}")
        finally:
            with PROCESS4_OUTPUT_LOCK:
                PROCESS4_OUTPUT["running"] = False
            PROCESS4_LOCK.release()

    @app.route('/triage_email_api/run_process4', methods=['POST'])
    def triage_email_api_run_process4():
        if request.remote_addr not in ('127.0.0.1', '::1'):
            return jsonify({"status": "error", "message": "Local access only"}), 403
        if not PROCESS4_LOCK.acquire(blocking=False):
            return jsonify({"status": "error", "message": "Triage import is already running"}), 409

        try:
            previous_keys = _import_item_keys()
            with PROCESS4_OUTPUT_LOCK:
                PROCESS4_OUTPUT["running"] = True
                PROCESS4_OUTPUT["lines"] = []
                PROCESS4_OUTPUT["return_code"] = None
                PROCESS4_OUTPUT["imported_rows"] = []
            thread = threading.Thread(target=run_triage_process4, args=(previous_keys,), daemon=True)
            thread.start()
        except Exception as error:
            PROCESS4_LOCK.release()
            with PROCESS4_OUTPUT_LOCK:
                PROCESS4_OUTPUT["running"] = False
                PROCESS4_OUTPUT["return_code"] = -1
                PROCESS4_OUTPUT["lines"].append(f"[triage-email] Failed to start script: {error}")
            return jsonify({"status": "error", "message": str(error)}), 500

        return jsonify({
            "status": "started",
        }), 202

    @app.route('/triage_email_api/process4_output', methods=['GET'])
    def triage_email_api_process4_output():
        with PROCESS4_OUTPUT_LOCK:
            return jsonify({
                "running": PROCESS4_OUTPUT["running"],
                "lines": PROCESS4_OUTPUT["lines"],
                "return_code": PROCESS4_OUTPUT["return_code"],
                "imported_rows": PROCESS4_OUTPUT["imported_rows"],
                "data_file": DATA_FILE,
            })

    @app.route('/triage_email_api/update', methods=['POST'])
    def triage_email_api_update():
        update_info = request.json
        # update_info structure: {section, item_id, status, comment}
        selected_file, _ = _resolve_data_file(update_info.get('data_file'))
        if not selected_file:
            return jsonify({"status": "error", "message": "No data files found"}), 404
        data_file_path = os.path.join(BASE_DIR, selected_file)
        
        with open(data_file_path, 'r+') as f:
            data = json.load(f)
            
            # Perform update logic
            section = update_info.get('section')
            item_id = update_info.get('item_id')
            
            if section in data and item_id in data[section]['ind_dats']:
                data[section]['ind_dats'][item_id]['status'] = update_info.get('status')
                data[section]['ind_dats'][item_id]['notes'] = update_info.get('comment')
                
                f.seek(0)
                json.dump(data, f, indent=2)
                f.truncate()
                return jsonify({"status": "success"})
            
        return jsonify({"status": "error", "message": "Item not found"}), 404
    @app.route('/triage_email_api/update_batch', methods=['POST'])
    def triage_email_api_update_batch():
        payload = request.json
        items = payload.get('items', [])
        common_notes = payload.get('common_notes', {})
        selected_file, _ = _resolve_data_file(payload.get('data_file'))
        if not selected_file:
            return jsonify({"status": "error", "message": "No data files found"}), 404
        data_file_path = os.path.join(BASE_DIR, selected_file)

        with open(data_file_path, 'r+') as f:
            data = json.load(f)
            
            # Update Table Items
            for u in items:
                sec = u['section']
                iid = u['item_id']
                if sec in data and iid in data[sec]['ind_dats']:
                    data[sec]['ind_dats'][iid]['status'] = u['status']
                    data[sec]['ind_dats'][iid]['notes'] = u['notes']
            
            # Update Common Notes
            for section_name, note_text in common_notes.items():
                if section_name in data:
                    data[section_name]['notes'] = note_text

            f.seek(0)
            json.dump(data, f, indent=2)
            f.truncate()
            
        return jsonify({"status": "success"})

    @app.route('/triagemails/<path:filename>')
    def send_triageemails_static(filename):
        return send_from_directory('templates/triagemails', filename)