# routes_triage_email.py
from flask import render_template, request, jsonify
import json
import os

# Assuming the data file is in the same directory as the app
DATA_FILE = "triage_email_data.json"

def configure_routes_triage_email(app):
    
    @app.route('/triage_email_dashboard')
    def triage_email_dashboard():
        if not os.path.exists(DATA_FILE):
            return "Data file not found", 404
        with open(DATA_FILE, 'r') as f:
            data = json.load(f)
        return render_template('triage_email_dashboard.html', data=data)

    @app.route('/triage_email_api/update', methods=['POST'])
    def triage_email_api_update():
        update_info = request.json
        # update_info structure: {section, item_id, status, comment}
        
        with open(DATA_FILE, 'r+') as f:
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

        with open(DATA_FILE, 'r+') as f:
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