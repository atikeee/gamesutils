import sys
path = '/home/itsforfun/gamesutils'
if path not in sys.path:
    sys.path.append(path)
from app import app as application, socketio
