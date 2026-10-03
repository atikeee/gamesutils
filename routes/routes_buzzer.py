from datetime import datetime
from random import shuffle

from flask import make_response, redirect, render_template, request
from dashboard import dashboard_tile

from storage import buzzer_entries, name_locks


def configure_routes_buzzer(app, socketio):
    @app.route("/buzzer", methods=["GET", "POST"], strict_slashes=False)
    @dashboard_tile(section="quiz", title="Buzzer", description="Submit a quiz buzz with your name and note.", icon="bell", order=80)
    def buzzer():
        message = ''
        name_value = request.cookies.get('name', '')
        name_locked = request.cookies.get('name_locked')

        if request.method == 'POST':
            if not name_locked:
                name = request.form.get('name')
                ip = request.remote_addr
                time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                note = request.form.get('note')
                message = f"Buzz from {name} recorded!"
                entry = {'name': name, 'ip': ip, 'note': note, 'time': time}
                buzzer_entries.append(entry)
                socketio.emit('buzz_trigger', entry)
                response = make_response(render_template(
                    "buzzer/buzzer.html",
                    message=message,
                    name=name,
                    name_locked=True,
                    note=""
                ))
                response.set_cookie('name', name)
                response.set_cookie('name_locked', 'true')
                return response

            name = name_value
            note = request.form.get('note')
            ip = request.remote_addr
            time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            message = f"Buzz from {name} recorded!"
            entry = {'name': name, 'ip': ip, 'note': note, 'time': time}
            buzzer_entries.append(entry)
            socketio.emit('buzz_trigger', entry)
            return render_template(
                "buzzer/buzzer.html",
                message=message,
                name=name,
                name_locked=True,
                note=note
            )

        return render_template(
            "buzzer/buzzer.html",
            message=message,
            name=name_value,
            name_locked=name_locked,
            note=""
        )

    @app.route('/buzzer/report', methods=['GET', 'POST'])
    @dashboard_tile(section="quiz", title="Buzzer Report", description="View live buzzer entries and clear the report.", icon="clipboard", order=90)
    def report():
        if request.method == 'POST':
            buzzer_entries.clear()
            socketio.emit('buzz_cleared')
            if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
                return '', 204
        return render_template("buzzer/report.html", entries=buzzer_entries)

    @app.route('/buzzer/resetnames', methods=['POST'])
    def reset_names():
        buzzer_entries.clear()
        name_locks.clear()
        socketio.emit('buzz_cleared')
        return redirect('/buzzer/report')

    @app.route('/buzzer/shuffle', methods=['POST'])
    def shuffle_names():
        unique_names = list(set([entry['name'] for entry in buzzer_entries]))
        shuffle(unique_names)
        return render_template("buzzer/report.html", entries=buzzer_entries, unique_names=unique_names)