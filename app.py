from flask import Flask
from routes import configure_routes
from routes_catan import configure_routes_catan
from flask_socketio import SocketIO, emit
import random


app = Flask(__name__)
app.config['SECRET_KEY']='secret!'
socketio = SocketIO(app)
configure_routes(app,socketio)
configure_routes_catan(app,socketio)

if __name__ == '__main__':
    #app.run(debug=True, host='0.0.0.0')
    socketio.run(app, debug=True, host='0.0.0.0', allow_unsafe_werkzeug=True)
