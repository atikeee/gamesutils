"""=============================================================================
MULTI-SOURCE WEATHER AGGREGATOR (PACIFIC TIME EXCLUSIVE)
=============================================================================
API Index Mapping in Output JSON:
  "0"    : Open-Meteo (Multi-Model Blended Forecast) - No API Key Required
  "1"    : Open-Meteo (NOAA GFS Global Model)        - No API Key Required
  "2"    : Visual Crossing Weather API               - Free Key Active
  "3"    : WeatherAPI.com                            - Free Key Active
  "calc" : Outlier-Resistant Consensus Value (Trimmed Mean / Median)

Timezone:
  - All timestamps and hourly steps are strictly formatted in Pacific Time (PT).
  - 'hour_index: 1' starts at the current Pacific hour.

Output Filename Convention:
  wf{lat}.{lon}.json  (e.g., wf45.5229.-122.9898.json)
=============================================================================
"""

import argparse
import datetime
import json
import statistics
from pathlib import Path
from typing import Any, Dict, List, Optional
import zoneinfo
import requests

# =====================================================================
# DEFAULT CONFIGURATION, API KEYS & TIMEZONE
# =====================================================================
DEFAULT_LAT = 45.5229  # Default: Hillsboro, OR
DEFAULT_LON = -122.9898

VISUAL_CROSSING_API_KEY = "JKBX99TTHVFVTUJF97Y7FVKSE"
WEATHERAPI_KEY = "5af6b1604b904d94ab514221261411"

# Pacific Time Zone (handles PST/PDT automatically)
PACIFIC_TZ = zoneinfo.ZoneInfo("America/Los_Angeles")


# =====================================================================
# OUTLIER-RESISTANT CONSENSUS CALCULATOR
# =====================================================================
def robust_calc(
    values: List[Optional[float]], cap: Optional[float] = None
) -> Optional[float]:
  """Calculates a low-variance consensus value from up to 4 APIs.

  - Filters out None values. - Standardizes visibility with an optional cap
  (10.0 km). - For 4 values: uses Trimmed Mean (drops min & max outliers,
  averages middle 2). - For 3 values: drops extreme outlier if present, else
  averages.
  """
  clean = [float(v) for v in values if v is not None]
  if not clean:
    return None

  if cap is not None:
    clean = [min(v, cap) for v in clean]

  clean.sort()
  n = len(clean)

  if n == 4:
    return round((clean[1] + clean[2]) / 2.0, 2)
  elif n == 3:
    d_low = clean[1] - clean[0]
    d_high = clean[2] - clean[1]
    if d_high > 2.5 * d_low and d_low > 0:
      return round((clean[0] + clean[1]) / 2.0, 2)
    elif d_low > 2.5 * d_high and d_high > 0:
      return round((clean[1] + clean[2]) / 2.0, 2)
    return round(statistics.median(clean), 2)
  else:
    return round(sum(clean) / n, 2)


def safe_get(lst: List[Any], idx: int, default=None):
  try:
    return lst[idx] if idx < len(lst) else default
  except (IndexError, TypeError):
    return default


def avg_slice(lst: List[float], start: int, end: int, scale: float = 1.0):
  if not lst:
    return None
  sub = [x for x in lst[start:end] if x is not None]
  return round((sum(sub) / len(sub)) * scale, 2) if sub else None


def c_to_f(celsius: Optional[float]) -> Optional[float]:
  if celsius is None:
    return None
  return round((celsius * 9.0 / 5.0) + 32.0, 2)


# =====================================================================
# API 0: OPEN-METEO (Multi-Model Blended)
# =====================================================================
def fetch_api_0(lat: float, lon: float) -> Dict[str, Any]:
  url = "https://api.open-meteo.com/v1/forecast"
  params = {
      "latitude": lat,
      "longitude": lon,
      "temperature_unit": "fahrenheit",
      "wind_speed_unit": "kmh",
      "precipitation_unit": "mm",
      "timeformat": "unixtime",
      "hourly": (
          "temperature_2m,precipitation_probability,precipitation,wind_speed_10m,visibility,cloud_cover"
      ),
      "daily": (
          "temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max"
      ),
      "timezone": "America/Los_Angeles",
      "forecast_days": 11,
  }
  r = requests.get(url, params=params, timeout=15)
  r.raise_for_status()
  return r.json()


# =====================================================================
# API 1: OPEN-METEO (NOAA GFS Model)
# =====================================================================
def fetch_api_1(lat: float, lon: float) -> Dict[str, Any]:
  url = "https://api.open-meteo.com/v1/gfs"
  params = {
      "latitude": lat,
      "longitude": lon,
      "temperature_unit": "fahrenheit",
      "wind_speed_unit": "kmh",
      "precipitation_unit": "mm",
      "timeformat": "unixtime",
      "hourly": (
          "temperature_2m,precipitation_probability,precipitation,wind_speed_10m,visibility,cloud_cover"
      ),
      "daily": (
          "temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max"
      ),
      "timezone": "America/Los_Angeles",
      "forecast_days": 11,
  }
  r = requests.get(url, params=params, timeout=15)
  r.raise_for_status()
  return r.json()


# =====================================================================
# API 2: VISUAL CROSSING API
# =====================================================================
def fetch_api_2(lat: float, lon: float, api_key: str) -> Dict[str, Any]:
  url = f"https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/{lat},{lon}/next10days"
  params = {
      "unitGroup": "metric",
      "include": "days,hours",
      "key": api_key,
      "contentType": "json",
  }
  r = requests.get(url, params=params, timeout=15)
  r.raise_for_status()
  return r.json()


# =====================================================================
# API 3: WEATHERAPI.COM
# =====================================================================
def fetch_api_3(lat: float, lon: float, api_key: str) -> Dict[str, Any]:
  url = "http://api.weatherapi.com/v1/forecast.json"
  params = {
      "key": api_key,
      "q": f"{lat},{lon}",
      "days": 10,
      "aqi": "no",
      "alerts": "no",
  }
  r = requests.get(url, params=params, timeout=15)
  r.raise_for_status()
  return r.json()


# =====================================================================
# MAIN AGGREGATOR
# =====================================================================
def build_weather_json(lat: float, lon: float, custom_out: Optional[str] = None):
  weather_dir = Path(__file__).resolve().parents[1] / "data" / "weather"
  output_file = Path(custom_out) if custom_out else weather_dir / f"wf{lat}.{lon}.json"
  output_file.parent.mkdir(parents=True, exist_ok=True)

  # Current time strictly in Pacific Time
  now_pt = datetime.datetime.now(PACIFIC_TZ)
  fetch_time_pt = now_pt.isoformat()

  # Align start of the 48hr window to the top of the current Pacific hour
  current_pt_hour = now_pt.replace(minute=0, second=0, microsecond=0)
  current_hour_epoch = int(current_pt_hour.timestamp())

  print(
      f"Fetching weather data at {fetch_time_pt} (Pacific Time) for"
      f" (lat={lat}, lon={lon})..."
  )

  # Fetch from all 4 APIs
  data_0 = fetch_api_0(lat, lon)
  data_1 = fetch_api_1(lat, lon)
  data_2 = fetch_api_2(lat, lon, VISUAL_CROSSING_API_KEY)
  data_3 = fetch_api_3(lat, lon, WEATHERAPI_KEY)

  # -----------------------------------------------------------------
  # INDEX ALL HOURLY DATA BY UNIX EPOCH TIMESTAMP
  # -----------------------------------------------------------------
  h0_raw = data_0.get("hourly", {})
  h0_map = {
      ep: {k: safe_get(v, idx) for k, v in h0_raw.items()}
      for idx, ep in enumerate(h0_raw.get("time", []))
  }

  h1_raw = data_1.get("hourly", {})
  h1_map = {
      ep: {k: safe_get(v, idx) for k, v in h1_raw.items()}
      for idx, ep in enumerate(h1_raw.get("time", []))
  }

  h2_map = {
      hr["datetimeEpoch"]: hr
      for day in data_2.get("days", [])
      for hr in day.get("hours", [])
      if "datetimeEpoch" in hr
  }

  h3_map = {
      hr["time_epoch"]: hr
      for day in data_3.get("forecast", {}).get("forecastday", [])
      for hr in day.get("hour", [])
      if "time_epoch" in hr
  }

  # -----------------------------------------------------------------
  # BUILD 48-HOUR FORECAST (In Pacific Time Starting From Current Hour)
  # -----------------------------------------------------------------
  hourly_48hr = []

  for i in range(48):
    target_epoch = current_hour_epoch + (i * 3600)
    # Pure Pacific timestamp format (e.g. 2026-11-13T18:00:00-08:00)
    time_pt_str = datetime.datetime.fromtimestamp(
        target_epoch, tz=PACIFIC_TZ
    ).isoformat()

    s0 = h0_map.get(target_epoch, {})
    s1 = h1_map.get(target_epoch, {})
    s2 = h2_map.get(target_epoch, {})
    s3 = h3_map.get(target_epoch, {})

    t_vals = [
        s0.get("temperature_2m"),
        s1.get("temperature_2m"),
        c_to_f(s2.get("temp")),
        s3.get("temp_f"),
    ]
    rprob_vals = [
        s0.get("precipitation_probability"),
        s1.get("precipitation_probability"),
        s2.get("precipprob"),
        s3.get("chance_of_rain"),
    ]
    rprec_vals = [
        s0.get("precipitation"),
        s1.get("precipitation"),
        s2.get("precip"),
        s3.get("precip_mm"),
    ]
    wind_vals = [
        s0.get("wind_speed_10m"),
        s1.get("wind_speed_10m"),
        s2.get("windspeed"),
        s3.get("wind_kph"),
    ]

    v0 = (
        round(s0["visibility"] / 1000.0, 2)
        if s0.get("visibility") is not None
        else None
    )
    v1 = (
        round(s1["visibility"] / 1000.0, 2)
        if s1.get("visibility") is not None
        else None
    )
    v2 = s2.get("visibility")
    v3 = s3.get("vis_km")
    vis_vals = [v0, v1, v2, v3]

    cloud_vals = [
        s0.get("cloud_cover"),
        s1.get("cloud_cover"),
        s2.get("cloudcover"),
        s3.get("cloud"),
    ]

    entry = {
        "hour_index": i + 1,
        "time": time_pt_str,  # Pacific Time
        "temp_f": {
            "0": t_vals[0],
            "1": t_vals[1],
            "2": t_vals[2],
            "3": t_vals[3],
            "calc": robust_calc(t_vals),
        },
        "rain_probability_pct": {
            "0": rprob_vals[0],
            "1": rprob_vals[1],
            "2": rprob_vals[2],
            "3": rprob_vals[3],
            "calc": robust_calc(rprob_vals),
        },
        "rain_precipitation_mm": {
            "0": rprec_vals[0],
            "1": rprec_vals[1],
            "2": rprec_vals[2],
            "3": rprec_vals[3],
            "calc": robust_calc(rprec_vals),
        },
        "wind_speed_kmh": {
            "0": wind_vals[0],
            "1": wind_vals[1],
            "2": wind_vals[2],
            "3": wind_vals[3],
            "calc": robust_calc(wind_vals),
        },
        "fog_visibility_km": {
            "0": v0,
            "1": v1,
            "2": v2,
            "3": v3,
            "calc": robust_calc(vis_vals, cap=10.0),
        },
        "cloud_coverage_pct": {
            "0": cloud_vals[0],
            "1": cloud_vals[1],
            "2": cloud_vals[2],
            "3": cloud_vals[3],
            "calc": robust_calc(cloud_vals),
        },
    }
    hourly_48hr.append(entry)

  # -----------------------------------------------------------------
  # BUILD 10-DAY FORECAST (10 Entries)
  # -----------------------------------------------------------------
  daily_10day = []
  d0 = data_0.get("daily", {})
  d1 = data_1.get("daily", {})
  vc_days = data_2.get("days", [])
  wa_days = data_3.get("forecast", {}).get("forecastday", [])

  for d in range(10):
    d2 = safe_get(vc_days, d, {})
    d3_obj = safe_get(wa_days, d, {})
    d3 = d3_obj.get("day", {})
    d3_hours = d3_obj.get("hour", [])

    date_str = d2.get("datetime") or d3_obj.get("date")

    # Min/Max/Avg Temperatures
    t0_min, t0_max = safe_get(d0.get("temperature_2m_min", []), d), safe_get(
        d0.get("temperature_2m_max", []), d
    )
    t0_avg = (
        round((t0_min + t0_max) / 2, 2)
        if (t0_min is not None and t0_max is not None)
        else None
    )

    t1_min, t1_max = safe_get(d1.get("temperature_2m_min", []), d), safe_get(
        d1.get("temperature_2m_max", []), d
    )
    t1_avg = (
        round((t1_min + t1_max) / 2, 2)
        if (t1_min is not None and t1_max is not None)
        else None
    )

    t2_min, t2_max, t2_avg = (
        c_to_f(d2.get("tempmin")),
        c_to_f(d2.get("tempmax")),
        c_to_f(d2.get("temp")),
    )
    t3_min, t3_max, t3_avg = (
        d3.get("mintemp_f"),
        d3.get("maxtemp_f"),
        d3.get("avgtemp_f"),
    )

    rp_vals = [
        safe_get(d0.get("precipitation_probability_max", []), d),
        safe_get(d1.get("precipitation_probability_max", []), d),
        d2.get("precipprob"),
        d3.get("daily_chance_of_rain"),
    ]
    rsum_vals = [
        safe_get(d0.get("precipitation_sum", []), d),
        safe_get(d1.get("precipitation_sum", []), d),
        d2.get("precip"),
        d3.get("totalprecip_mm"),
    ]
    wmax_vals = [
        safe_get(d0.get("wind_speed_10m_max", []), d),
        safe_get(d1.get("wind_speed_10m_max", []), d),
        d2.get("windspeed"),
        d3.get("maxwind_kph"),
    ]

    fog0 = avg_slice(
        h0_raw.get("visibility", []), d * 24, (d + 1) * 24, scale=0.001
    )
    fog1 = avg_slice(
        h1_raw.get("visibility", []), d * 24, (d + 1) * 24, scale=0.001
    )
    fog2 = d2.get("visibility")
    fog3 = d3.get("avgvis_km")
    fog_vals = [fog0, fog1, fog2, fog3]

    wa_cloud_avg = (
        round(sum(h.get("cloud", 0) for h in d3_hours) / len(d3_hours), 2)
        if d3_hours
        else None
    )
    c_vals = [
        avg_slice(h0_raw.get("cloud_cover", []), d * 24, (d + 1) * 24),
        avg_slice(h1_raw.get("cloud_cover", []), d * 24, (d + 1) * 24),
        d2.get("cloudcover"),
        wa_cloud_avg,
    ]

    entry = {
        "day_index": d + 1,
        "date": date_str,
        "temp_f": {
            "0": {"min": t0_min, "max": t0_max, "avg": t0_avg},
            "1": {"min": t1_min, "max": t1_max, "avg": t1_avg},
            "2": {"min": t2_min, "max": t2_max, "avg": t2_avg},
            "3": {"min": t3_min, "max": t3_max, "avg": t3_avg},
            "calc": {
                "min": robust_calc([t0_min, t1_min, t2_min, t3_min]),
                "max": robust_calc([t0_max, t1_max, t2_max, t3_max]),
                "avg": robust_calc([t0_avg, t1_avg, t2_avg, t3_avg]),
            },
        },
        "rain_probability_max_pct": {
            "0": rp_vals[0],
            "1": rp_vals[1],
            "2": rp_vals[2],
            "3": rp_vals[3],
            "calc": robust_calc(rp_vals),
        },
        "rain_precipitation_sum_mm": {
            "0": rsum_vals[0],
            "1": rsum_vals[1],
            "2": rsum_vals[2],
            "3": rsum_vals[3],
            "calc": robust_calc(rsum_vals),
        },
        "wind_speed_max_kmh": {
            "0": wmax_vals[0],
            "1": wmax_vals[1],
            "2": wmax_vals[2],
            "3": wmax_vals[3],
            "calc": robust_calc(wmax_vals),
        },
        "fog_visibility_avg_km": {
            "0": fog0,
            "1": fog1,
            "2": fog2,
            "3": fog3,
            "calc": robust_calc(fog_vals, cap=10.0),
        },
        "cloud_coverage_avg_pct": {
            "0": c_vals[0],
            "1": c_vals[1],
            "2": c_vals[2],
            "3": c_vals[3],
            "calc": robust_calc(c_vals),
        },
    }
    daily_10day.append(entry)

  # -----------------------------------------------------------------
  # FINAL JSON PAYLOAD
  # -----------------------------------------------------------------
  final_output = {
      "timestamp": fetch_time_pt,
      "location": {"latitude": lat, "longitude": lon},
      "48hr": hourly_48hr,
      "10_day": daily_10day,
  }

  with output_file.open("w", encoding="utf-8") as f:
    json.dump(final_output, f, indent=2)

  print(f"✅ Successfully wrote 48hr and 10-day forecast to '{output_file}'")


if __name__ == "__main__":
  parser = argparse.ArgumentParser(
      description=(
          "Fetch 48-hour and 10-day weather forecasts from 4 APIs (0-3) in"
          " Pacific Time."
      )
  )
  parser.add_argument(
      "--lat",
      type=float,
      default=DEFAULT_LAT,
      help=f"Latitude (default: {DEFAULT_LAT})",
  )
  parser.add_argument(
      "--lon",
      type=float,
      default=DEFAULT_LON,
      help=f"Longitude (default: {DEFAULT_LON})",
  )
  parser.add_argument(
      "--out",
      type=str,
      default=None,
    help="Optional: Override the output path (default: data/weather/wf{lat}.{lon}.json)",
  )

  args = parser.parse_args()
  build_weather_json(args.lat, args.lon, args.out)
