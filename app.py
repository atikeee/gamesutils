from flask import Flask
from routes import configure_routes
from routes_catan import configure_routes_catan
from routes_bridge import configure_routes_bridge
from routes_bridge_v2 import configure_routes_bridge_v2
from routes_links import configure_routes_links
from routes_launcher import configure_routes_launcher
from routes_triage_email import configure_routes_triage_email
from flask_socketio import SocketIO, emit

import random




app = Flask(__name__)
app.config['SECRET_KEY'] = 'bridge-game-secret-2024-xkq'  # fixed, not 'secret!'
app.config['SESSION_TYPE'] = 'filesystem'  # not needed but helps debug
socketio = SocketIO(app)
configure_routes(app,socketio)
configure_routes_links(app, socketio)
configure_routes_catan(app,socketio)
configure_routes_bridge(app, socketio) 
configure_routes_launcher(app, socketio) 
# Add the new Bridge V2 configuration
configure_routes_bridge_v2(app, socketio)
configure_routes_triage_email(app)

if __name__ == '__main__':
    #app.run(debug=True, host='0.0.0.0')
    socketio.run(app, debug=True, host='0.0.0.0', allow_unsafe_werkzeug=True)
