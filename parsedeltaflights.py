import sqlite3
import sys
from datetime import datetime, timedelta
import requests

if len(sys.argv) != 3:
    print("Usage: python script.py <SRC> <DST>")
    sys.exit(1)

SRC = sys.argv[1].upper()
DST = sys.argv[2].upper()

# Get tomorrow's date in YYYY-MM-DD format
query_date = (datetime.now() + timedelta(days=1)).strftime('%Y-%m-%d')

API_KEY = '26ae356c0b45057250bdca8fbaacd231'  # Replace with your actual key
BASE_URL = 'http://api.aviationstack.com/v1/flights'
for i in range(2):
    if i == 1:
        T = SRC
        SRC = DST
        DST = T
    print('src',SRC,'dst',DST)
    params = {
        'access_key': API_KEY,
        'dep_iata': SRC,
        'arr_iata': DST,
        'airline_iata':'DL',
        'limit': 40
    }

    # Connect to SQLite database
    conn = sqlite3.connect('flights.db')
    cursor = conn.cursor()

    # Create table if not exists
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS flights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flightno TEXT,
        src TEXT,
        dst TEXT,
        departure TEXT,
        arrival TEXT,
        duration INTEGER
    )
    ''')

    response = requests.get(BASE_URL, params=params)
    data = response.json()

    if 'data' not in data:
        print("API error:", data)
        conn.close()
        sys.exit(1)

    for flight in data['data']:
        airline = flight['airline']['name']
        flight_number = flight['flight']['iata']
        print(airline,flight_number)
        if 'Delta' not in airline:
            continue

        departure_time = flight['departure']['scheduled']
        arrival_time = flight['arrival']['scheduled']
        src = flight['departure']['iata']
        dst = flight['arrival']['iata']

        if departure_time and arrival_time:
            dep_dt = datetime.fromisoformat(departure_time.replace('Z', '+00:00'))
            arr_dt = datetime.fromisoformat(arrival_time.replace('Z', '+00:00'))

            duration_minutes = int((arr_dt - dep_dt).total_seconds() // 60)

            print(f"{airline} {flight_number}")
            print(f"  Departs: {dep_dt.strftime('%Y-%m-%d %H:%M')}")
            print(f"  Arrives: {arr_dt.strftime('%Y-%m-%d %H:%M')}")
            print(f"  Duration: {duration_minutes} minutes\n")

            cursor.execute('''
                INSERT INTO flights (flightno,src, dst, departure, arrival, duration)
                VALUES (?,?, ?, ?, ?, ?)
            ''', (
                flight_number,
                src,
                dst,
                dep_dt.strftime('%Y-%m-%d %H:%M:%S'),
                arr_dt.strftime('%Y-%m-%d %H:%M:%S'),
                duration_minutes
            ))

        else:
            print(f"{airline} {flight_number} — Missing time info\n")

    conn.commit()
    conn.close()


"""
C:\github\delta>python parsedeltaflights.py msp pdx
Delta Air Lines DL2415
  Departs: 2025-06-28 09:10
  Arrives: 2025-06-28 10:48
  Duration: 98 minutes

Delta Air Lines DL2167
  Departs: 2025-06-27 11:05
  Arrives: 2025-06-27 12:40
  Duration: 95 minutes

Delta Air Lines DL2415
  Departs: 2025-06-27 09:10
  Arrives: 2025-06-27 10:48
  Duration: 98 minutes

Delta Air Lines DL1661
  Departs: 2025-06-27 14:20
  Arrives: 2025-06-27 15:54
  Duration: 94 minutes

Delta Air Lines DL2151
  Departs: 2025-06-27 18:45
  Arrives: 2025-06-27 20:23
  Duration: 98 minutes

Delta Air Lines DL2391
  Departs: 2025-06-27 21:55
  Arrives: 2025-06-27 23:32
  Duration: 97 minutes
Delta Air Lines DL1521
  Departs: 2025-06-28 08:50
  Arrives: 2025-06-28 11:55
  Duration: 185 minutes

Delta Air Lines DL2131
  Departs: 2025-06-27 20:20
  Arrives: 2025-06-27 23:23
  Duration: 183 minutes

Delta Air Lines DL5001
  Departs: 2025-06-27 15:22
  Arrives: 2025-06-27 18:34
  Duration: 192 minutes
  

"""