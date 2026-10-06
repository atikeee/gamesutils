from flask import Flask
from routes.routes import configure_routes
from routes.routes_codenames import configure_routes_codenames
from routes.routes_buzzer import configure_routes_buzzer
from routes.routes_delta import configure_routes_delta
from routes.routes_ppp_tool import configure_routes_ppp_tool
from routes.routes_panchforon import configure_routes_panchforon
from routes.routes_catan import configure_routes_catan
from routes.routes_catan2 import configure_routes_catan2
from routes.routes_bridge import configure_routes_bridge
from routes.routes_bridge_v2 import configure_routes_bridge_v2
from routes.routes_links import configure_routes_links
from routes.routes_launcher import configure_routes_launcher
from routes.routes_triage_email import configure_routes_triage_email
from routes.routes_math import configure_routes_math
from flask_socketio import SocketIO, emit
from routes.routes_stocks import configure_routes_stocks

import random




app = Flask(__name__)
app.config['SECRET_KEY'] = 'bridge-game-secret-2024-xkq'  # fixed, not 'secret!'
app.config['SESSION_TYPE'] = 'filesystem'  # not needed but helps debug
socketio = SocketIO(app)
configure_routes(app,socketio)
configure_routes_codenames(app, socketio)
configure_routes_buzzer(app, socketio)
configure_routes_delta(app)
configure_routes_ppp_tool(app)
configure_routes_panchforon(app, socketio)
configure_routes_links(app, socketio)
configure_routes_catan(app,socketio)
configure_routes_catan2(app, socketio)
configure_routes_bridge(app, socketio) 
configure_routes_launcher(app, socketio) 
# Add the new Bridge V2 configuration
configure_routes_bridge_v2(app, socketio)
configure_routes_triage_email(app)
configure_routes_math(app)
configure_routes_stocks(app, socketio)

if __name__ == '__main__':
    #app.run(debug=True, host='0.0.0.0')
    socketio.run(app, debug=True, host='0.0.0.0', allow_unsafe_werkzeug=True)
