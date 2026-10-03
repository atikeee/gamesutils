# routes_triage_email.py
from flask import jsonify, render_template, request, send_from_directory
from dashboard import PROJECT_ROOT, dashboard_tile
import json
import os

# Assuming the data file is in the same directory as the app
DATA_FILE = "triage_email_data.json"
DATA_PREFIX = "triage_email_data"
BASE_DIR = os.path.join(PROJECT_ROOT, "data")


def _list_data_files():
    files = []
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
    
    @app.route('/triage_email_dashboard')
    @dashboard_tile(section="tools", title="Triage Email", description="Review and update triage email items.", icon="mail", order=60)
    def triage_email_dashboard():
        requested_file = request.args.get('data_file')
        selected_file, data_files = _resolve_data_file(requested_file)
        if not selected_file:
            return "No triage_email_data*.json files found", 404

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