from flask import render_template, request, jsonify
import json
import os
import yfinance as yf
from datetime import datetime
import math

POPULAR_STOCKS_FILE = "data/popular_stocks.json"


# ── Watchlist helpers ─────────────────────────────────────────────────────────

def _load_watchlist():
    if not os.path.exists(POPULAR_STOCKS_FILE):
        return []
    try:
        with open(POPULAR_STOCKS_FILE, "r", encoding="utf-8") as f:
            return _normalize_watchlist(json.load(f))
    except Exception as e:
        print(f"[stocks] Error loading watchlist: {e}")
        return []


def _number(value, field_name):
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        raise ValueError(f"{field_name} must be a number")
    if not math.isfinite(number) or number < 0:
        raise ValueError(f"{field_name} must be a non-negative number")
    return number


def _quantity(value):
    number = _number(value, "quantity")
    if not number.is_integer():
        raise ValueError("quantity must be a whole number")
    return int(number)


def _price(value):
    number = _number(value, "price")
    return int(number) if number.is_integer() else number


def _normalize_watchlist(watchlist):
    normalized = []
    for item in watchlist if isinstance(watchlist, list) else []:
        if not isinstance(item, dict) or not item.get("symbol"):
            continue
        entry = dict(item)
        try:
            entry["quantity"] = _quantity(entry.get("quantity", 0))
            entry["price"] = _price(entry.get("price", 0))
        except ValueError:
            entry["quantity"] = 0
            entry["price"] = 0
        normalized.append(entry)
    return normalized


def _save_watchlist(lst):
    try:
        with open(POPULAR_STOCKS_FILE, "w", encoding="utf-8") as f:
            json.dump(_normalize_watchlist(lst), f, indent=2)
        return True
    except Exception as e:
        print(f"[stocks] Error saving watchlist: {e}")
        return False


# ── yfinance data helpers ─────────────────────────────────────────────────────

def _fetch_stock_data(symbol: str, period: str = "1mo"):
    """Full data fetch: price, stats, chart series, news."""
    period_map = {
        "1wk": ("7d",  "1d"),
        "1mo": ("1mo", "1d"),
        "6mo": ("6mo", "1d"),
    }
    yf_period, interval = period_map.get(period, ("1mo", "1d"))

    ticker = yf.Ticker(symbol)
    info   = ticker.info
    hist   = ticker.history(period=yf_period, interval=interval)

    if hist.empty:
        raise ValueError(f"No data found for symbol '{symbol}'")

    dates   = [d.strftime("%Y-%m-%d") for d in hist.index]
    closes  = [round(float(v), 2) if not math.isnan(float(v)) else None for v in hist["Close"]]
    volumes = [int(v) if not math.isnan(float(v)) else 0 for v in hist["Volume"]]

    current_price = info.get("currentPrice") or info.get("regularMarketPrice") or closes[-1]
    prev_close    = info.get("previousClose") or (closes[-2] if len(closes) > 1 else closes[-1])
    change        = round(current_price - prev_close, 2)
    change_pct    = round((change / prev_close) * 100, 2) if prev_close else 0.0

    raw_news = ticker.news or []
    news = []
    for n in raw_news[:8]:
        content     = n.get("content", {})
        title       = content.get("title") or n.get("title", "")
        pub_raw     = content.get("pubDate") or ""
        try:
            pub_str = datetime.strptime(pub_raw[:19], "%Y-%m-%dT%H:%M:%S").strftime("%b %d, %Y")
        except Exception:
            pub_str = pub_raw[:10] if pub_raw else ""
        canon       = content.get("canonicalUrl", {})
        url         = (canon.get("url") if isinstance(canon, dict) else "") or n.get("link", "#")
        source      = content.get("provider", {})
        source_name = (source.get("displayName") if isinstance(source, dict) else "") or "News"
        if title:
            news.append({"title": title, "summary": content.get("summary", ""),
                         "url": url, "date": pub_str, "source": source_name})

    return {
        "symbol":        symbol.upper(),
        "name":          info.get("longName") or info.get("shortName") or symbol,
        "current_price": round(float(current_price), 2),
        "change":        change,
        "change_pct":    change_pct,
        "currency":      info.get("currency", "USD"),
        "market_cap":    info.get("marketCap"),
        "pe_ratio":      info.get("trailingPE"),
        "week_52_high":  info.get("fiftyTwoWeekHigh"),
        "week_52_low":   info.get("fiftyTwoWeekLow"),
        "dates":         dates,
        "closes":        closes,
        "volumes":       volumes,
        "news":          news,
        "period":        period,
        "fetched_at":    datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def _fetch_spark(symbol: str, period: str = "1wk"):
    """Lightweight daily price fetch for watchlist cards."""
    period_map = {
        "1wk": "7d",
        "1mo": "1mo",
        "6mo": "6mo",
    }
    yf_period = period_map.get(period, "7d")
    ticker = yf.Ticker(symbol)
    info   = ticker.info
    hist   = ticker.history(period=yf_period, interval="1d")
    daily_hist = ticker.history(period="5d", interval="1d")

    if hist.empty:
        raise ValueError(f"No data for '{symbol}'")

    closes  = [round(float(v), 2) if not math.isnan(float(v)) else None for v in hist["Close"]]
    dates   = [d.strftime("%b %d") for d in hist.index]
    current = info.get("currentPrice") or info.get("regularMarketPrice") or closes[-1]
    daily_closes = [round(float(v), 2) for v in daily_hist["Close"] if not math.isnan(float(v))]
    prev    = info.get("previousClose") or (daily_closes[-2] if len(daily_closes) > 1 else current)
    change  = round(current - prev, 2)
    pct     = round((change / prev) * 100, 2) if prev else 0.0

    return {
        "symbol":   symbol.upper(),
        "name":     info.get("longName") or info.get("shortName") or symbol,
        "price":    round(float(current), 2),
        "change":   change,
        "pct":      pct,
        "currency": info.get("currency", "USD"),
        "dates":    dates,
        "closes":   closes,
    }


# ── Route registration ────────────────────────────────────────────────────────

def configure_routes_stocks(app, socketio=None):

    @app.route("/stocks")
    def stocks_dashboard():
        watchlist = _load_watchlist()
        return render_template("stocks_dashboard.html", watchlist=watchlist)

    @app.route("/stocks/detail/<symbol>")
    def stocks_detail(symbol):
        period = request.args.get("period", "1mo")
        return render_template("stocks_detail.html",
                               symbol=symbol.upper(), period=period)

    @app.route("/stocks/select", methods=["GET"])
    def stocks_select():
        watchlist = _load_watchlist()
        return render_template("stocks_select.html", watchlist=watchlist)

    @app.route("/stocks/select/add", methods=["POST"])
    def stocks_select_add():
        data   = request.json or {}
        symbol = data.get("symbol", "").upper().strip()
        name   = data.get("name", symbol).strip()
        if not symbol:
            return jsonify({"status": "error", "message": "Symbol required"}), 400
        wl = _load_watchlist()
        if any(s["symbol"] == symbol for s in wl):
            return jsonify({"status": "exists", "message": f"{symbol} already in watchlist"})
        wl.append({"symbol": symbol, "name": name, "quantity": 0, "price": 0})
        _save_watchlist(wl)
        return jsonify({"status": "success", "message": f"{symbol} added"})

    @app.route("/stocks/select/save", methods=["POST"])
    def stocks_select_save():
        data = request.json or {}
        updates = data.get("holdings")
        if not isinstance(updates, list):
            return jsonify({"status": "error", "message": "holdings list required"}), 400
        watchlist = _load_watchlist()
        by_symbol = {item["symbol"]: item for item in watchlist}
        try:
            for update in updates:
                symbol = (update.get("symbol") or "").upper().strip()
                if symbol not in by_symbol:
                    continue
                by_symbol[symbol]["quantity"] = _quantity(update.get("quantity"))
                by_symbol[symbol]["price"] = _price(update.get("price"))
        except (AttributeError, ValueError) as error:
            return jsonify({"status": "error", "message": str(error)}), 400
        if not _save_watchlist(watchlist):
            return jsonify({"status": "error", "message": "Could not save holdings"}), 500
        return jsonify({"status": "success", "watchlist": watchlist})

    @app.route("/stocks/select/remove", methods=["POST"])
    def stocks_select_remove():
        data   = request.json or {}
        symbol = data.get("symbol", "").upper().strip()
        wl     = _load_watchlist()
        _save_watchlist([s for s in wl if s["symbol"] != symbol])
        return jsonify({"status": "success", "message": f"{symbol} removed"})

    @app.route("/stocks/select/reorder", methods=["POST"])
    def stocks_select_reorder():
        data    = request.json or {}
        symbols = data.get("symbols", [])
        wl      = _load_watchlist()
        lookup  = {s["symbol"]: s for s in wl}
        _save_watchlist([lookup[sym] for sym in symbols if sym in lookup])
        return jsonify({"status": "success"})

    @app.route("/stocks/api/data")
    def stocks_api_data():
        symbol = request.args.get("symbol", "").upper().strip()
        period = request.args.get("period", "1mo")
        if not symbol:
            return jsonify({"status": "error", "message": "symbol param required"}), 400
        try:
            return jsonify({"status": "success", "data": _fetch_stock_data(symbol, period)})
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 400

    @app.route("/stocks/api/spark")
    def stocks_api_spark():
        symbol = request.args.get("symbol", "").upper().strip()
        period = request.args.get("period", "1wk")
        if not symbol:
            return jsonify({"status": "error", "message": "symbol param required"}), 400
        try:
            return jsonify({"status": "success", "data": _fetch_spark(symbol, period)})
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 400

    @app.route("/stocks/api/search")
    def stocks_api_search():
        q = request.args.get("q", "").strip()
        if not q:
            return jsonify({"results": []})
        try:
            results = yf.Search(q, max_results=8)
            quotes  = results.quotes or []
            out = [{"symbol": r.get("symbol", ""),
                    "name":   r.get("longname") or r.get("shortname") or ""}
                   for r in quotes if r.get("symbol")]
            return jsonify({"results": out})
        except Exception as e:
            return jsonify({"results": [], "error": str(e)})

    @app.route("/stocks/api/watchlist")
    def stocks_api_watchlist():
        return jsonify({"status": "success", "watchlist": _load_watchlist()})
