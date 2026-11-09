from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sqlite3
import time
from urllib.parse import unquote, urlsplit

import click
from flask import Blueprint, g, jsonify, make_response, redirect, render_template, request, url_for
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash


DEFAULT_DATABASE = Path(__file__).resolve().parents[1] / 'instance' / 'passphrase_router.sqlite3'
AUTH_COOKIE = 'passphrase_manager'
CSRF_COOKIE = 'passphrase_router_csrf'
ACCESS_COOKIE = 'passphrase_access'
SESSION_SECONDS = 3600


@contextmanager
def database(path):
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_database(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with database(path) as connection:
        connection.executescript('''
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS destinations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                lookup TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                info TEXT NOT NULL,
                url TEXT NOT NULL,
                is_master INTEGER NOT NULL DEFAULT 0 CHECK(is_master IN (0, 1))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_master ON destinations(is_master) WHERE is_master = 1;
            CREATE TABLE IF NOT EXISTS manager_sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS access_sessions (
                token_hash TEXT PRIMARY KEY,
                destination_id INTEGER NOT NULL,
                signature TEXT NOT NULL,
                expires INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS protected_paths (path TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS login_attempts (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, started INTEGER NOT NULL);
        ''')
        connection.execute('INSERT OR IGNORE INTO settings VALUES (?, ?)', ('secret', secrets.token_hex(32)))
        connection.execute('INSERT OR IGNORE INTO protected_paths VALUES (?)', ('/phototag',))
        for entry in connection.execute('SELECT url FROM destinations WHERE is_master = 0').fetchall():
            connection.execute('INSERT OR IGNORE INTO protected_paths VALUES (?)', (destination_path(entry['url']),))
    if os.name != 'nt':
        os.chmod(path, 0o600)


def secret_key(connection):
    return connection.execute('SELECT value FROM settings WHERE key = ?', ('secret',)).fetchone()['value']


def lookup_key(connection, passphrase):
    return hmac.new(bytes.fromhex(secret_key(connection)), passphrase.encode('utf-8'), hashlib.sha256).hexdigest()


def validate_passphrase(passphrase):
    if not 8 <= len(passphrase) <= 256:
        raise ValueError('Use a passphrase between 8 and 256 characters.')


def destination_path(value):
    return unquote(urlsplit(value).path).rstrip('/') or '/'


def path_matches(path, destination):
    return path == destination or path.startswith(destination + '/')


def destination_signature(entry):
    values = [entry[key] for key in ('lookup', 'password_hash', 'info', 'url')]
    return hashlib.sha256(json.dumps(values).encode()).hexdigest()


def validate_destination(value):
    decoded = value
    for iteration in range(4):
        decoded = unquote(decoded)
        parsed = urlsplit(decoded)
        if (not decoded.startswith('/') or decoded.startswith('//') or parsed.scheme or parsed.netloc
                or '\\' in decoded or any(ord(character) < 33 or ord(character) == 127 for character in decoded)):
            raise ValueError('Use a local URL starting with /, without spaces or backslashes.')
    if len(value) > 2048:
        raise ValueError('The URL is too long.')
    target = destination_path(decoded)
    if target == '/' or path_matches(target, '/static') or path_matches(target, '/passphrases'):
        raise ValueError('The root, manager, and static asset paths are reserved.')
    if any(segment in ('.', '..') for segment in urlsplit(decoded).path.split('/')):
        raise ValueError('Use a local URL without . or .. path segments.')
    return value


def seed_destinations(path, master, dashboard):
    validate_passphrase(master)
    validate_passphrase(dashboard)
    if hmac.compare_digest(master.encode(), dashboard.encode()):
        raise ValueError('The two passphrases must be different.')
    with database(path) as connection:
        if connection.execute('SELECT 1 FROM destinations').fetchone():
            raise ValueError('Already initialized. Use the manager to make changes.')
        for passphrase, info, target, is_master in (
            (master, 'Passphrase manager', '/passphrases', 1),
            (dashboard, 'Game Hub', '/index', 0),
        ):
            connection.execute('INSERT INTO destinations (lookup, password_hash, info, url, is_master) VALUES (?, ?, ?, ?, ?)',
                               (lookup_key(connection, passphrase), generate_password_hash(passphrase), info, target, is_master))
            if not is_master:
                connection.execute('INSERT OR IGNORE INTO protected_paths VALUES (?)', (destination_path(target),))


def configure_routes_passphrase(app):
    path = app.config.setdefault('PASSPHRASE_DATABASE', str(DEFAULT_DATABASE))
    initialize_database(path)
    router = Blueprint('passphrase_router', __name__)

    @app.before_request
    def require_destination_access():
        requested_path = request.path.rstrip('/') or '/'
        if requested_path in {'/', '/index'} or path_matches(requested_path, '/passphrases') or path_matches(requested_path, '/static'):
            return None
        with database(path) as connection:
            entries = connection.execute('SELECT * FROM destinations WHERE is_master = 0').fetchall()
            protected = {row['path'] for row in connection.execute('SELECT path FROM protected_paths')}
            matching = [target for target in protected if path_matches(requested_path, target)]
            if not matching:
                return None
            required_path = max(matching, key=len)
            g.passphrase_protected = True
            token = request.cookies.get(ACCESS_COOKIE, '')
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            grant = connection.execute('SELECT * FROM access_sessions WHERE token_hash = ? AND expires > ?',
                                       (token_hash, int(time.time()))).fetchone() if token else None
            entry = next((entry for entry in entries if grant and entry['id'] == grant['destination_id']), None)
            if entry and hmac.compare_digest(grant['signature'], destination_signature(entry)) and destination_path(entry['url']) == required_path:
                g.passphrase_access = dict(entry)
                g.passphrase_access_expires = grant['expires']
                return None
        if '/api/' in request.path or request.is_json:
            return jsonify(status='error', message='Enter a passphrase to access this page.', login_url='/'), 401
        return redirect(url_for('passphrase_router.home'), code=303)

    @app.after_request
    def prevent_protected_caching(response):
        if getattr(g, 'passphrase_protected', False):
            response.headers['Cache-Control'] = 'no-store'
            response.headers['Referrer-Policy'] = 'no-referrer'
            response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    def csrf_token(connection):
        serializer = URLSafeTimedSerializer(secret_key(connection), salt='passphrase-router-csrf')
        token = request.cookies.get(CSRF_COOKIE, '')
        try:
            serializer.loads(token, max_age=3600)
        except (BadSignature, SignatureExpired):
            token = serializer.dumps(secrets.token_urlsafe(32))
        return token

    def valid_csrf(connection):
        cookie = request.cookies.get(CSRF_COOKIE, '')
        submitted = request.form.get('csrf_token', '')
        if not cookie or not hmac.compare_digest(cookie.encode(), submitted.encode()):
            return False
        try:
            URLSafeTimedSerializer(secret_key(connection), salt='passphrase-router-csrf').loads(cookie, max_age=3600)
            return True
        except (BadSignature, SignatureExpired):
            return False

    def authorized(connection):
        token = request.cookies.get(AUTH_COOKIE, '')
        if not token:
            return False
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        return connection.execute('SELECT 1 FROM manager_sessions WHERE token_hash = ? AND expires > ?',
                                  (token_hash, int(time.time()))).fetchone() is not None

    def page(connection, template, status=200, **values):
        token = csrf_token(connection)
        response = make_response(render_template(template, csrf_token=token, **values), status)
        response.set_cookie(CSRF_COOKIE, token, max_age=3600, httponly=True, secure=request.is_secure, samesite='Strict')
        return response

    def manager_page(connection, error=None, status=200):
        entries = connection.execute('SELECT id, info, url, is_master FROM destinations ORDER BY id').fetchall()
        return page(connection, 'main/passphrase_manager.html', status, entries=entries, error=error)

    @router.after_request
    def security_headers(response):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Content-Security-Policy'] = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
        return response

    @router.route('/', methods=['GET', 'POST'])
    def home():
        with database(path) as connection:
            ready = connection.execute('SELECT 1 FROM destinations WHERE is_master = 1').fetchone() is not None
            if not ready:
                return page(connection, 'main/passphrase_home.html', 503, ready=False, error='Passphrase routing has not been configured.')
            if request.method == 'GET':
                return page(connection, 'main/passphrase_home.html', ready=True)
            if not valid_csrf(connection):
                return page(connection, 'main/passphrase_home.html', 400, ready=True, error='This form expired. Please try again.')
            now = int(time.time())
            bucket = lookup_key(connection, request.remote_addr or 'unknown')
            connection.execute('BEGIN IMMEDIATE')
            connection.execute('DELETE FROM login_attempts WHERE started < ?', (now - 900,))
            connection.execute('DELETE FROM manager_sessions WHERE expires <= ?', (now,))
            connection.execute('DELETE FROM access_sessions WHERE expires <= ?', (now,))
            attempt = connection.execute('SELECT count FROM login_attempts WHERE bucket = ?', (bucket,)).fetchone()
            if attempt and attempt['count'] >= 10:
                response = page(connection, 'main/passphrase_home.html', 429, ready=True, error='Too many attempts. Try again in 15 minutes.')
                response.headers['Retry-After'] = '900'
                return response
            passphrase = request.form.get('passphrase', '')
            entry = connection.execute('SELECT * FROM destinations WHERE lookup = ?', (lookup_key(connection, passphrase),)).fetchone() if len(passphrase) <= 256 else None
            if not entry or not check_password_hash(entry['password_hash'], passphrase):
                connection.execute('INSERT INTO login_attempts VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = count + 1', (bucket, now))
                return page(connection, 'main/passphrase_home.html', 401, ready=True, error='Passphrase not recognized.')
            response = redirect(entry['url'], code=303)
            if entry['is_master']:
                token = secrets.token_urlsafe(32)
                connection.execute('INSERT INTO manager_sessions VALUES (?, ?)', (hashlib.sha256(token.encode()).hexdigest(), now + SESSION_SECONDS))
                response.set_cookie(AUTH_COOKIE, token, max_age=SESSION_SECONDS, httponly=True, secure=request.is_secure, samesite='Strict', path='/passphrases')
            else:
                previous = request.cookies.get(ACCESS_COOKIE, '')
                connection.execute('DELETE FROM access_sessions WHERE token_hash = ?', (hashlib.sha256(previous.encode()).hexdigest(),))
                token = secrets.token_urlsafe(32)
                connection.execute('INSERT INTO access_sessions VALUES (?, ?, ?, ?)',
                                   (hashlib.sha256(token.encode()).hexdigest(), entry['id'], destination_signature(entry), now + SESSION_SECONDS))
                response.set_cookie(ACCESS_COOKIE, token, max_age=SESSION_SECONDS, httponly=True, secure=request.is_secure, samesite='Strict', path='/')
            return response

    @router.get('/passphrases')
    def manager():
        with database(path) as connection:
            if not authorized(connection):
                return redirect(url_for('passphrase_router.home'), code=303)
            return manager_page(connection)

    @router.post('/passphrases/save')
    def save():
        with database(path) as connection:
            if not authorized(connection):
                return redirect(url_for('passphrase_router.home'), code=303)
            if not valid_csrf(connection):
                return manager_page(connection, 'This form expired. Please reload.', 400)
            entry_id = request.form.get('id', type=int)
            entry = connection.execute('SELECT * FROM destinations WHERE id = ?', (entry_id,)).fetchone() if entry_id else None
            if entry_id and not entry:
                return manager_page(connection, 'Entry not found.', 404)
            try:
                info = request.form.get('info', '').strip()
                if not info or len(info) > 200:
                    raise ValueError('Enter an info label of up to 200 characters.')
                target = '/passphrases' if entry and entry['is_master'] else validate_destination(request.form.get('url', ''))
                passphrase = request.form.get('passphrase', '')
                if passphrase or not entry:
                    validate_passphrase(passphrase)
                    if entry and entry['is_master'] and not check_password_hash(entry['password_hash'], request.form.get('current_master', '')):
                        raise ValueError('Enter the current master passphrase to replace it.')
                    lookup = lookup_key(connection, passphrase)
                    password_hash = generate_password_hash(passphrase)
                else:
                    lookup, password_hash = entry['lookup'], entry['password_hash']
                if entry:
                    connection.execute('UPDATE destinations SET lookup = ?, password_hash = ?, info = ?, url = ? WHERE id = ?',
                                       (lookup, password_hash, info, target, entry_id))
                else:
                    connection.execute('INSERT INTO destinations (lookup, password_hash, info, url) VALUES (?, ?, ?, ?)',
                                       (lookup, password_hash, info, target))
                if not entry or not entry['is_master']:
                    connection.execute('INSERT OR IGNORE INTO protected_paths VALUES (?)', (destination_path(target),))
                if entry and entry['is_master'] and passphrase:
                    connection.execute('DELETE FROM manager_sessions')
                    response = redirect(url_for('passphrase_router.home'), code=303)
                    response.delete_cookie(AUTH_COOKIE, path='/passphrases')
                    return response
            except ValueError as error:
                return manager_page(connection, str(error), 400)
            except sqlite3.IntegrityError:
                return manager_page(connection, 'That passphrase is already assigned. Choose a different one.', 409)
            return redirect(url_for('passphrase_router.manager'), code=303)

    @router.post('/passphrases/delete')
    def delete():
        with database(path) as connection:
            if not authorized(connection):
                return redirect(url_for('passphrase_router.home'), code=303)
            if not valid_csrf(connection):
                return manager_page(connection, 'This form expired. Please reload.', 400)
            connection.execute('DELETE FROM destinations WHERE id = ? AND is_master = 0', (request.form.get('id', type=int),))
            return redirect(url_for('passphrase_router.manager'), code=303)

    @router.post('/passphrases/logout')
    def logout():
        with database(path) as connection:
            if not valid_csrf(connection):
                return redirect(url_for('passphrase_router.home'), code=303)
            token = request.cookies.get(AUTH_COOKIE, '')
            connection.execute('DELETE FROM manager_sessions WHERE token_hash = ?', (hashlib.sha256(token.encode()).hexdigest(),))
        response = redirect(url_for('passphrase_router.home'), code=303)
        response.delete_cookie(AUTH_COOKIE, path='/passphrases')
        return response

    app.register_blueprint(router)


@click.group()
def cli():
    pass


@cli.command('init')
@click.option('--database-path', default=str(DEFAULT_DATABASE), type=click.Path(dir_okay=False))
def initialize_command(database_path):
    initialize_database(database_path)
    with database(database_path) as connection:
        if connection.execute('SELECT 1 FROM destinations').fetchone():
            raise click.ClickException('Already initialized. Use the manager to make changes.')
    master = click.prompt('Master passphrase (8-256 characters)', hide_input=True, confirmation_prompt=True)
    dashboard = click.prompt('Dashboard passphrase (8-256 characters)', hide_input=True, confirmation_prompt=True)
    try:
        seed_destinations(database_path, master, dashboard)
    except ValueError as error:
        raise click.ClickException(str(error)) from error
    click.echo('Configured /passphrases and /index. No plaintext passphrases were saved.')


if __name__ == '__main__':
    cli()