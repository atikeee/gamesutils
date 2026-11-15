import json
import math
import os
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import RLock, Thread
from time import monotonic

from flask import current_app, jsonify, render_template, request

from scripts.weather_aggregator import DEFAULT_LAT, DEFAULT_LON, build_weather_json


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEATHER_DIR = PROJECT_ROOT / "data" / "weather"
LOCATIONS_FILE = WEATHER_DIR / "locations.json"
LEGACY_DEFAULT_FILE = PROJECT_ROOT / "scripts" / f"wf{DEFAULT_LAT}.{DEFAULT_LON}.json"
WEATHER_REFRESH_LOCK = RLock()
WEATHER_REFRESH_JOBS = {}
WEATHER_RETRY_SECONDS = 300
SOURCE_NAMES = {
    "0": "Open-Meteo Blend",
    "1": "NOAA GFS",
    "2": "Visual Crossing",
    "3": "WeatherAPI",
}


def _coordinate_text(value):
    text = f"{value:.6f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text == "-0" else text


def _location_id(latitude, longitude):
    return f"{_coordinate_text(latitude)}.{_coordinate_text(longitude)}"


def _weather_file(location):
    return WEATHER_DIR / f"wf{_location_id(location['latitude'], location['longitude'])}.json"


def _default_state():
    location = {
        "name": "Hillsboro, OR",
        "latitude": DEFAULT_LAT,
        "longitude": DEFAULT_LON,
    }
    location["id"] = _location_id(DEFAULT_LAT, DEFAULT_LON)
    return {"locations": [location], "selected_id": location["id"]}


def _write_json_atomic(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(temporary_path, path)


def _load_state():
    WEATHER_DIR.mkdir(parents=True, exist_ok=True)
    try:
        state = json.loads(LOCATIONS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        state = _default_state()
        _write_json_atomic(LOCATIONS_FILE, state)
    except (OSError, ValueError):
        state = _default_state()

    locations = []
    seen = set()
    for row in state.get("locations", []) if isinstance(state, dict) else []:
        try:
            name = str(row.get("name", "")).strip()[:80]
            latitude = float(row["latitude"])
            longitude = float(row["longitude"])
        except (AttributeError, KeyError, TypeError, ValueError):
            continue
        if not name or not math.isfinite(latitude) or not math.isfinite(longitude):
            continue
        if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
            continue
        identifier = _location_id(latitude, longitude)
        if identifier in seen:
            continue
        seen.add(identifier)
        locations.append({"id": identifier, "name": name, "latitude": latitude, "longitude": longitude})

    selected_id = state.get("selected_id") if isinstance(state, dict) else None
    if selected_id not in seen:
        selected_id = locations[0]["id"] if locations else ""
    return {"locations": locations, "selected_id": selected_id}


def _validate_locations(raw_locations):
    if not isinstance(raw_locations, list):
        raise ValueError("Locations must be a table of rows.")

    locations = []
    seen = set()
    for row in raw_locations:
        if not isinstance(row, dict):
            raise ValueError("Every location must have a name, longitude, and latitude.")
        name = str(row.get("name", "")).strip()
        if not name or len(name) > 80:
            raise ValueError("Location names must be between 1 and 80 characters.")
        try:
            longitude = float(row.get("longitude"))
            latitude = float(row.get("latitude"))
        except (TypeError, ValueError):
            raise ValueError(f"Enter numeric coordinates for {name}.")
        if not math.isfinite(latitude) or not -90 <= latitude <= 90:
            raise ValueError(f"Latitude for {name} must be between -90 and 90.")
        if not math.isfinite(longitude) or not -180 <= longitude <= 180:
            raise ValueError(f"Longitude for {name} must be between -180 and 180.")
        identifier = _location_id(latitude, longitude)
        if identifier in seen:
            raise ValueError("Each location must have unique coordinates.")
        seen.add(identifier)
        locations.append({"id": identifier, "name": name, "latitude": latitude, "longitude": longitude})
    return locations


def _find_location(state, identifier):
    return next((location for location in state["locations"] if location["id"] == identifier), None)


def _read_forecast(path):
    try:
        forecast = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(forecast, dict) or not isinstance(forecast.get("48hr"), list) or not isinstance(forecast.get("10_day"), list):
        return None
    return forecast


def _forecast_is_fresh(forecast):
    try:
        timestamp = datetime.fromisoformat(forecast["timestamp"].replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
    except (KeyError, AttributeError, TypeError, ValueError):
        return False
    age = datetime.now(timezone.utc) - timestamp.astimezone(timezone.utc)
    return timedelta(0) <= age < timedelta(hours=1)


def _read_location_forecast(location, path):
    forecast = _read_forecast(path)
    if forecast is None and _location_id(location["latitude"], location["longitude"]) == _location_id(DEFAULT_LAT, DEFAULT_LON):
        legacy = _read_forecast(LEGACY_DEFAULT_FILE)
        if legacy:
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(LEGACY_DEFAULT_FILE, path)
            forecast = legacy
    return forecast


def _run_weather_refresh(app, location):
    identifier = location["id"]
    path = _weather_file(location)
    try:
        with app.app_context():
            build_weather_json(location["latitude"], location["longitude"], str(path))
            forecast = _read_forecast(path)
            if forecast is None or not _forecast_is_fresh(forecast):
                raise ValueError("The weather script did not produce fresh, valid forecast JSON.")
    except Exception as error:
        with app.app_context():
            app.logger.exception("Weather refresh failed for %s", location["name"])
        with WEATHER_REFRESH_LOCK:
            WEATHER_REFRESH_JOBS[identifier] = {
                "loading": False,
                "retry_at": monotonic() + WEATHER_RETRY_SECONDS,
                "warning": f"Refresh failed; showing the saved forecast when available: {error}",
            }
        return

    with WEATHER_REFRESH_LOCK:
        WEATHER_REFRESH_JOBS[identifier] = {"loading": False, "retry_at": 0, "warning": None}


def _ensure_weather_refresh(location):
    path = _weather_file(location)
    forecast = _read_location_forecast(location, path)
    if forecast is not None and _forecast_is_fresh(forecast):
        return forecast, False, None

    identifier = location["id"]
    app = current_app._get_current_object()
    with WEATHER_REFRESH_LOCK:
        forecast = _read_location_forecast(location, path)
        if forecast is not None and _forecast_is_fresh(forecast):
            return forecast, False, None
        job = WEATHER_REFRESH_JOBS.get(identifier, {})
        if job.get("loading"):
            return forecast, True, None
        if job.get("retry_at", 0) > monotonic():
            return forecast, False, job.get("warning")
        WEATHER_REFRESH_JOBS[identifier] = {"loading": True, "retry_at": 0, "warning": None}
        Thread(target=_run_weather_refresh, args=(app, location.copy()), daemon=True).start()
    return forecast, True, None


def configure_routes_weather(app):
    @app.get("/weather")
    def weather_dashboard():
        state = _load_state()
        location = _find_location(state, state["selected_id"])
        forecast, loading, warning = _ensure_weather_refresh(location) if location else (None, False, None)
        return render_template(
            "weather.html",
            locations=state["locations"],
            selected_id=state["selected_id"],
            initial_forecast=forecast,
            initial_loading=loading,
            initial_warning=warning,
            source_names=SOURCE_NAMES,
        )

    @app.post("/weather/api/locations")
    def save_weather_locations():
        payload = request.get_json(silent=True) or {}
        try:
            locations = _validate_locations(payload.get("locations"))
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        selected_id = payload.get("selected_id")
        valid_ids = {location["id"] for location in locations}
        if selected_id not in valid_ids:
            selected_id = locations[0]["id"] if locations else ""
        state = {"locations": locations, "selected_id": selected_id}
        _write_json_atomic(LOCATIONS_FILE, state)
        return jsonify(state)

    @app.post("/weather/api/selection")
    def select_weather_location():
        payload = request.get_json(silent=True) or {}
        state = _load_state()
        location = _find_location(state, payload.get("selected_id"))
        if not location:
            return jsonify({"error": "Choose a saved location."}), 400
        state["selected_id"] = location["id"]
        _write_json_atomic(LOCATIONS_FILE, state)
        forecast, loading, warning = _ensure_weather_refresh(location)
        return jsonify({"location": location, "forecast": forecast, "loading": loading, "warning": warning})

    @app.get("/weather/api/status")
    def weather_status():
        state = _load_state()
        location = _find_location(state, request.args.get("selected_id"))
        if not location:
            return jsonify({"error": "Choose a saved location."}), 400
        forecast, loading, warning = _ensure_weather_refresh(location)
        return jsonify({"location": location, "forecast": forecast, "loading": loading, "warning": warning})