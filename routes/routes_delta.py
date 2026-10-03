import os
import sqlite3
from datetime import datetime, timedelta

import requests
from flask import jsonify, render_template, request
from dashboard import PROJECT_ROOT, dashboard_tile


DB = os.path.join(PROJECT_ROOT, "data", "flights.db")


def configure_routes_delta(app):
    @app.route('/delta/view')
    @dashboard_tile(section="flights", title="Flights Detail", description="Browse Delta flights with source and destination details.", icon="calendar", order=20)
    def view_page2():
        src_list = set()
        dst_list = set()
        rows_data = []

        try:
            conn = sqlite3.connect(DB)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT flightno, src, dst, departure, arrival, duration FROM flights ORDER BY src, dst")
            all_flights = cursor.fetchall()
            conn.close()

            for flight in all_flights:
                src_list.add(flight['src'])
                dst_list.add(flight['dst'])
                rows_data.append([
                    flight['flightno'],
                    flight['src'],
                    flight['dst'],
                    datetime.strptime(flight['departure'], '%Y-%m-%d %H:%M:%S').strftime('%H:%M'),
                    datetime.strptime(flight['arrival'], '%Y-%m-%d %H:%M:%S').strftime('%H:%M'),
                    flight['duration']
                ])

        except Exception as e:
            print(f"Error fetching data for view_page2: {e}")
            return "Error loading data", 500

        template_data = {
            'srclist': sorted(src_list),
            'dstlist': sorted(dst_list),
            'rows': rows_data
        }
        return render_template("delta/delta_view2.html", data=template_data)

    @app.route('/delta/')
    @dashboard_tile(section="flights", title="Flights Grouped", description="View Delta flights grouped by route.", icon="plane", order=10)
    def view_page():
        conn = sqlite3.connect(DB)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("""
            SELECT id,flightno, src, dst, departure, arrival, duration
            FROM flights
        """)
        rows = cur.fetchall()
        conn.close()

        data_by_dest = {}
        for row in rows:
            dst = row['dst']
            src = row['src']
            srcdst = src + '=>' + dst
            departure = datetime.strptime(row['departure'], '%Y-%m-%d %H:%M:%S')
            arrival = datetime.strptime(row['arrival'], '%Y-%m-%d %H:%M:%S')
            if srcdst not in data_by_dest:
                data_by_dest[srcdst] = []
            data_by_dest[srcdst].append({
                'flightno': row['flightno'],
                'departure': departure.strftime('%H:%M'),
                'arrival': arrival.strftime('%H:%M'),
                'duration': row['duration'],
                'id': row['id']
            })

        return render_template("delta/delta_view.html", data=data_by_dest)

    @app.route("/delta/add", methods=["GET", "POST"])
    @dashboard_tile(section="flights", title="Add Flight", description="Add a flight record to the local database.", icon="add", order=30)
    def index_delta():
        message = ""
        if request.method == "POST":
            try:
                flightno = request.form["flightno"]
                src = request.form["src"].upper()
                dst = request.form["dst"].upper()
                departure = request.form["departure"]
                arrival = request.form["arrival"]
                duration = int(request.form["duration"])

                datetime.strptime(departure, "%Y-%m-%d %H:%M:%S")
                datetime.strptime(arrival, "%Y-%m-%d %H:%M:%S")

                conn = sqlite3.connect(DB)
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT INTO flights (flightno, src, dst, departure, arrival, duration)
                    VALUES (?, ?, ?, ?, ?, ?)
                ''', (flightno, src, dst, departure, arrival, duration))
                conn.commit()
                conn.close()
                message = "✅ Flight added successfully!"
            except Exception as e:
                message = f"❌ Error: {e}"

        return render_template("delta/delta_update_form.html", message=message)

    @app.route("/delta/delete_flight/<int:flight_id>", methods=["POST"])
    def delete_flight(flight_id):
        try:
            conn = sqlite3.connect(DB)
            cursor = conn.cursor()
            cursor.execute("DELETE FROM flights WHERE id = ?", (flight_id,))
            conn.commit()
            conn.close()
            return jsonify(success=True, message=f"Flight {flight_id} deleted successfully.")
        except Exception as e:
            print(f"Error deleting flight {flight_id}: {e}")
            return jsonify(success=False, message=str(e)), 500

    @app.route("/delta/parse_flights", methods=["GET", "POST"])
    @dashboard_tile(section="flights", title="Parse Flights", description="Fetch and save Delta flight data for a route.", icon="radar", order=40)
    def parse_flights_page():
        message = ""
        if request.method == "POST":
            src_iata = request.form.get("src_iata", "").upper()
            dst_iata = request.form.get("dst_iata", "").upper()

            if not src_iata or not dst_iata:
                message = "❌ Error: Both Source and Destination IATA codes are required."
            else:
                try:
                    query_date = (datetime.now() + timedelta(days=1)).strftime('%Y-%m-%d')

                    API_KEY = '26ae356c0b45057250bdca8fbaacd231'
                    BASE_URL = 'http://api.aviationstack.com/v1/flights'
                    all_parsed_flights = []

                    for i in range(2):
                        current_src = src_iata if i == 0 else dst_iata
                        current_dst = dst_iata if i == 0 else src_iata

                        params = {
                            'access_key': API_KEY,
                            'dep_iata': current_src,
                            'arr_iata': current_dst,
                            'airline_iata': 'DL',
                            'limit': 20,
                            'flight_date': query_date
                        }

                        response = requests.get(BASE_URL, params=params)
                        data = response.json()
                        print(data)
                        if 'data' not in data or not data['data']:
                            message += f"⚠️ Warning: No flights found for {current_src} to {current_dst}. "
                            continue

                        conn = sqlite3.connect(DB)
                        cursor = conn.cursor()

                        for flight in data['data']:
                            airline = flight.get('airline', {}).get('name')
                            flight_number = flight.get('flight', {}).get('iata')
                            if 'Delta' not in str(airline):
                                continue

                            departure_time = flight.get('departure', {}).get('scheduled')
                            arrival_time = flight.get('arrival', {}).get('scheduled')
                            api_src = flight.get('departure', {}).get('iata')
                            api_dst = flight.get('arrival', {}).get('iata')

                            if departure_time and arrival_time and api_src and api_dst:
                                try:
                                    dep_dt = datetime.fromisoformat(departure_time.replace('Z', '+00:00'))
                                    arr_dt = datetime.fromisoformat(arrival_time.replace('Z', '+00:00'))
                                    duration_minutes = int((arr_dt - dep_dt).total_seconds() // 60)

                                    cursor.execute('''
                                        INSERT INTO flights (flightno, src, dst, departure, arrival, duration)
                                        VALUES (?, ?, ?, ?, ?, ?)
                                    ''', (
                                        flight_number,
                                        api_src,
                                        api_dst,
                                        dep_dt.strftime('%Y-%m-%d %H:%M:%S'),
                                        arr_dt.strftime('%Y-%m-%d %H:%M:%S'),
                                        duration_minutes
                                    ))
                                    all_parsed_flights.append(f"{airline} {flight_number} ({api_src} to {api_dst}) added.")
                                except ValueError as ve:
                                    print(f"Date parsing error for flight {flight_number}: {ve}")
                                    message += f"❌ Error parsing date for {flight_number}. "
                                except Exception as insert_e:
                                    print(f"Database insert error for flight {flight_number}: {insert_e}")
                                    message += f"❌ Error saving {flight_number} to DB. "
                            else:
                                print(f"{airline} {flight_number} — Missing time/airport info\n")
                                message += f"⚠️ Warning: Missing info for {flight_number}. "

                        conn.commit()
                        conn.close()

                    if not message:
                        message = f"✅ Flight data parsed and saved successfully for {src_iata} and {dst_iata}!"
                    elif "Error" in message:
                        message = "❌ Some errors occurred during parsing: " + message
                    else:
                        message = "⚠️ Warnings during parsing: " + message

                except requests.exceptions.RequestException as req_e:
                    message = f"❌ Network Error: Could not connect to API. {req_e}"
                except Exception as e:
                    message = f"❌ An unexpected error occurred: {e}"
        return render_template("delta/delta_parseflights.html", message=message)