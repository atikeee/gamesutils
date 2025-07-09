import sqlite3
import json
from datetime import datetime


conn = sqlite3.connect('flights.db')
cursor = conn.cursor()

# Fetch all rows
cursor.execute("SELECT flightno, src, dst, departure, arrival, duration FROM flights")
rows = cursor.fetchall()

# Extract unique src/dst
cursor.execute("SELECT DISTINCT src FROM flights")
src_list = sorted([row[0] for row in cursor.fetchall()])
cursor.execute("SELECT DISTINCT dst FROM flights")
dst_list = sorted([row[0] for row in cursor.fetchall()])


conn.close()

# Write to a self-contained HTML file
with open('flights.html', 'w', encoding='utf-8') as f:
    f.write(f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Delta Flights</title>
    <style>
        body {{
            font-family: Arial, sans-serif;
            padding: 2rem;
            background: #f0f2f5;
        }}
        h1 {{
            text-align: center;
        }}
        select {{
            padding: 0.5rem;
            margin: 0.5rem;
            font-size: 1rem;
        }}
        table {{
            width: 100%;
            border-collapse: collapse;
            margin-top: 1rem;
            background: white;
            box-shadow: 0 0 10px rgba(0,0,0,0.1);
        }}
        th, td {{
            border: 1px solid #ccc;
            padding: 0.75rem;
            text-align: center;
        }}
        th {{
            background-color: #0077cc;
            color: white;
        }}
    </style>
</head>
<body>
    <h1>Delta Flights</h1>

    <label for="srcSelect">From:</label>
    <select id="srcSelect" onchange="filterTable()">
        <option value="">All</option>
        {''.join(f'<option value="{src}">{src}</option>' for src in src_list)}
    </select>

    <label for="dstSelect">To:</label>
    <select id="dstSelect" onchange="filterTable()">
        <option value="">All</option>
        {''.join(f'<option value="{dst}">{dst}</option>' for dst in dst_list)}
    </select>

    <table id="flightTable">
        <thead>
            <tr>
                <th>Flight No</th>
                <th>From</th>
                <th>To</th>
                <th>Departure</th>
                <th>Arrival</th>
                <th>Duration (min)</th>
            </tr>
        </thead>
        <tbody>
    ''')

    for flightno, src, dst, departure, arrival, duration in rows:
        try:
            dep_time = datetime.strptime(departure, "%Y-%m-%d %H:%M:%S").strftime("%H:%M")
            arr_time = datetime.strptime(arrival, "%Y-%m-%d %H:%M:%S").strftime("%H:%M")
        except:
            dep_time = departure
            arr_time = arrival
        f.write(f'''
            <tr>
                <td>{flightno}</td>
                <td>{src}</td>
                <td>{dst}</td>
                <td>{dep_time}</td>
                <td>{arr_time}</td>
                <td>{duration}</td>
            </tr>
        ''')

    # End of table and JS
    f.write('''
        </tbody>
    </table>

    <script>
        function filterTable() {
            const srcFilter = document.getElementById('srcSelect').value;
            const dstFilter = document.getElementById('dstSelect').value;
            const rows = document.querySelectorAll('#flightTable tbody tr');
            const uniqueDestinations = new Set();
            const currentDstFilter = dstSelect.value;
            rows.forEach(row => {
                const src = row.cells[1].textContent;
                const dst = row.cells[2].textContent;
                // no need to use dstFilter here. 
                const show = (!srcFilter || src === srcFilter) ;
                if (show)
                    uniqueDestinations.add(dst);
                row.style.display = show ? '' : 'none';
            });
            console.log("test");
            console.log(uniqueDestinations);
                const allOption = document.createElement('option');
                allOption.value = '';
                allOption.textContent = 'All';
                dstSelect=document.getElementById('dstSelect');
                dstSelect.innerHTML='';
                dstSelect.appendChild(allOption);
                const sortedDestinations = Array.from(uniqueDestinations).sort();
                sortedDestinations.forEach(dst => {
                    const option = document.createElement('option');
                    option.value = dst;
                    option.textContent = dst;
                    dstSelect.appendChild(option);
                });
                if (uniqueDestinations.has(currentDstFilter)) {
                    dstSelect.value = currentDstFilter;
                } else {
                    dstSelect.value = ''; // Reset to 'All' if the previous selection is no longer valid
                }
                const finalDstFilter = dstSelect.value; // Get the value after repopulating/re-selecting

                rows.forEach(row => {
                const src = row.cells[1].textContent;
                const dst = row.cells[2].textContent;
                const show = (!srcFilter || src === srcFilter) && (!finalDstFilter || dst === finalDstFilter);
                row.style.display = show ? '' : 'none';
    });
        }
        function filterTableD() {
            const srcFilter = document.getElementById('srcSelect').value;
            const dstFilter = document.getElementById('dstSelect').value;
            const rows = document.querySelectorAll('#flightTable tbody tr');
            rows.forEach(row => {
                const src = row.cells[1].textContent;
                const dst = row.cells[2].textContent;
                const show = (!srcFilter || src === srcFilter) && (!dstFilter || dst === dstFilter);
                row.style.display = show ? '' : 'none';
            });
        }
        
        document.addEventListener('DOMContentLoaded', function() {
            const dstSelect = document.getElementById('dstSelect');
            dstSelect.value = document.getElementById('srcSelect');
            filterTable();
        });
    </script>
</body>
</html>''')

print("✅ flights.html generated.")
