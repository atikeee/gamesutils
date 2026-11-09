import hmac
import os
import signal
import subprocess
from pathlib import Path
from threading import Lock, Timer

from flask import Blueprint, current_app, jsonify, request


routes_deploy = Blueprint('routes_deploy', __name__)
DEPLOY_LOCK = Lock()


def _git(directory, *arguments):
    return subprocess.run(
        ['git', '-c', f'safe.directory={directory}', *arguments],
        cwd=directory, env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'},
        capture_output=True, text=True, check=True, timeout=120
    ).stdout.strip()


def _restart_app():
    os.kill(os.getpid(), signal.SIGTERM)


@routes_deploy.route('/api/deploy-webhook', methods=['POST'])
def deploy_webhook():
    secret = os.environ.get('DEPLOY_WEBHOOK_SECRET', '')
    if not secret:
        return jsonify({'success': False, 'error': 'Deployment webhook is not configured.'}), 503
    authorization = request.headers.get('Authorization', '')
    supplied = authorization.removeprefix('Bearer ') if authorization.startswith('Bearer ') else ''
    if not hmac.compare_digest(secret.encode('utf-8'), supplied.encode('utf-8')):
        return jsonify({'success': False, 'error': 'Unauthorized.'}), 401
    data = request.get_json(silent=True)
    if data is not None and (not isinstance(data, dict) or data.get('ref', 'refs/heads/release') != 'refs/heads/release'):
        return jsonify({'success': False, 'error': 'Only the release branch can be deployed.'}), 400
    if not DEPLOY_LOCK.acquire(blocking=False):
        return jsonify({'success': False, 'error': 'A deployment is already running.'}), 409
    try:
        directory = Path(os.environ.get('DEPLOY_REPO_DIR', '/app')).resolve()
        if not directory.is_dir():
            return jsonify({'success': False, 'error': 'Deployment directory does not exist.'}), 503
        top_level = Path(_git(directory, 'rev-parse', '--show-toplevel')).resolve()
        if top_level != directory:
            return jsonify({'success': False, 'error': 'The deployment directory must be the Git repository root.'}), 409
        if _git(directory, 'branch', '--show-current') != 'release':
            return jsonify({'success': False, 'error': 'Check out the release branch on the NAS before deploying.'}), 409
        previous = _git(directory, 'rev-parse', 'HEAD')
        _git(directory, 'pull', '--ff-only', 'origin', 'release')
        commit = _git(directory, 'rev-parse', 'HEAD')
        changed = commit != previous
        restart = changed and os.environ.get('DEPLOY_RESTART', '0') == '1'
        if restart:
            timer = Timer(2, _restart_app)
            timer.daemon = True
            timer.start()
        return jsonify({'success': True, 'changed': changed, 'commit': commit, 'restart_scheduled': restart})
    except FileNotFoundError:
        return jsonify({'success': False, 'error': 'Git is not installed in the container.'}), 503
    except subprocess.TimeoutExpired:
        return jsonify({'success': False, 'error': 'Git operation timed out.'}), 504
    except subprocess.CalledProcessError:
        current_app.logger.warning('Deployment Git command failed; check repository state and origin authentication on the NAS.')
        return jsonify({'success': False, 'error': 'Git pull failed. Check local changes, branch history, and origin authentication on the NAS.'}), 409
    except OSError:
        return jsonify({'success': False, 'error': 'Cannot access the deployment repository.'}), 503
    finally:
        DEPLOY_LOCK.release()


def configure_routes_deploy(app):
    app.register_blueprint(routes_deploy)