from flask import Flask
from routes import configure_routes
from flask_socketio import SocketIO, emit
import random


app = Flask(__name__)
app.config['SECRET_KEY']='secret!'
socketio = SocketIO(app)
configure_routes(app,socketio)

if __name__ == '__main__':
    #app.run(debug=True, host='0.0.0.0')
    socketio.run(app, debug=True, host='0.0.0.0' )
