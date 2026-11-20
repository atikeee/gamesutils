import json
import os
import subprocess
from flask import Blueprint, jsonify, render_template, request

remote_bp = Blueprint('remote_control', __name__)

CONFIG_PATH = os.path.join(os.getcwd(), 'data', 'mm', 'mm_config.json')

KEY_MAP = {
    'power': '26',
    'wake': '224',
    'sleep': '223',
    'home': '3',
    'back': '4',
    'menu': '82',
    'up': '19',
    'down': '20',
    'left': '21',
    'right': '22',
    'select': '23',
    'vol_up': '24',
    'vol_down': '25',
    'mute': '164',
    'play_pause': '85',
    'rewind': '89',
    'fast_forward': '90',
    # --- HDMI & Source Inputs ---
    'hdmi1': '243',
    'hdmi2': '244',
    'hdmi3': '245',
    'hdmi4': '246',
    'input_menu': '178',  # Opens TV Input source selection menu
}



def load_tv_config():
    """Reads TV settings dynamically from data/mm/mm_config.json."""
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
            tv = data.get('tv', {})
            return {
                'ip': tv.get('ip', '192.168.0.245'),
                'port': str(tv.get('adb_port', 5555)),
                'adb_bin': tv.get('adb_executable', 'adb'),
                'timeout': int(tv.get('timeout_seconds', 15))
            }
    except Exception as e:
        print(f"[RemoteControl] Error reading config: {e}")
        return {
            'ip': '192.168.0.245',
            'port': '5555',
            'adb_bin': 'adb',
            'timeout': 15
        }


def run_adb(cmd_args, timeout=None):
    """Executes an adb command with output capture."""
    cfg = load_tv_config()
    adb_bin = cfg['adb_bin']
    t = timeout or cfg['timeout']

    try:
        result = subprocess.run(
            [adb_bin] + cmd_args,
            capture_output=True,
            text=True,
            timeout=t
        )
        output = (result.stdout or '') + (result.stderr or '')
        return result.returncode == 0, output.strip()
    except subprocess.TimeoutExpired:
        return False, "ADB command timed out"
    except FileNotFoundError:
        return False, f"'{adb_bin}' executable not found"
    except Exception as e:
        return False, str(e)


def reconnect_tv():
    """Clears stale ADB sockets and reconnects to the TV."""
    cfg = load_tv_config()
    target = f"{cfg['ip']}:{cfg['port']}"
    # Disconnect first to clear any stale or offline socket
    run_adb(['disconnect', target], timeout=5)
    success, output = run_adb(['connect', target], timeout=10)
    return success and ('connected to' in output or 'already connected to' in output), output


@remote_bp.route('/rc', methods=['GET'])
def remote_page():
    cfg = load_tv_config()
    return render_template('rc.html', tv_ip=cfg['ip'])


@remote_bp.route('/rc/api/connect', methods=['POST'])
def api_connect():
    ok, out = reconnect_tv()
    return jsonify({'success': ok, 'output': out})


@remote_bp.route('/rc/api/command', methods=['POST'])
def send_command():
    data = request.get_json(silent=True) or {}
    key = data.get('command')

    if not key or key not in KEY_MAP:
        return jsonify({'success': False, 'error': f'Invalid key: {key}'}), 400

    cfg = load_tv_config()
    target = f"{cfg['ip']}:{cfg['port']}"
    keycode = KEY_MAP[key]

    # Attempt 1: Send keyevent directly
    success, output = run_adb(['-s', target, 'shell', 'input', 'keyevent', keycode], timeout=5)

    # Attempt 2: If device was not found or offline, reconnect and retry
    if not success and any(err in output.lower() for err in ['not found', 'offline', 'error', 'no devices']):
        connected, connect_out = reconnect_tv()
        if not connected:
            return jsonify({
                'success': False,
                'error': f"Could not connect to {target}: {connect_out}"
            }), 500
        
        # Retry keyevent after fresh connection
        success, output = run_adb(['-s', target, 'shell', 'input', 'keyevent', keycode], timeout=5)

    if success:
        return jsonify({'success': True, 'command': key, 'code': keycode})
    return jsonify({'success': False, 'error': output}), 500
