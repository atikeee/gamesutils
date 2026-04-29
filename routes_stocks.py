from flask import render_template, request, jsonify
import json
import yfinance as yf
from datetime import datetime, timedelta

# Popular stocks for quick selection
POPULAR_STOCKS = [
    {"symbol": "AAPL", "name": "Apple"},
    {"symbol": "MSFT", "name": "Microsoft"},
    {"symbol": "GOOGL", "name": "Alphabet"},
    {"symbol": "AMZN", "name": "Amazon"},
    {"symbol": "NVDA", "name": "NVIDIA"},
    {"symbol": "TSLA", "name": "Tesla"},
    {"symbol": "META", "name": "Meta"},
    {"symbol": "JPM", "name": "JPMorgan"},
    {"symbol": "V", "name": "Visa"},
    {"symbol": "BRK-B", "name": "Berkshire"},
]


def _fetch_stock_data(symbol: str, period: str = "1mo"):
    """
    Fetch stock data for the given symbol and period.
    period: '1wk' | '1mo' | '6mo'
    Returns a dict ready to be JSON-serialised, or raises on error.
    """
    period_map = {
        "1wk": ("7d",  "1d"),
        "1mo": ("1mo", "1d"),
        "6mo": ("6mo", "1wk"),
    }
    yf_period, interval = period_map.get(period, ("1mo", "1d"))

    ticker = yf.Ticker(symbol)
    info   = ticker.info
    hist   = ticker.history(period=yf_period, interval=interval)

    if hist.empty:
        raise ValueError(f"No data found for symbol '{symbol}'")

    # ---------- price / volume series ----------
    dates   = [d.strftime("%Y-%m-%d") for d in hist.index]
    closes  = [round(float(v), 2) for v in hist["Close"]]
    volumes = [int(v) for v in hist["Volume"]]

    # ---------- current quote ----------
    current_price = info.get("currentPrice") or info.get("regularMarketPrice") or closes[-1]
    prev_close    = info.get("previousClose") or (closes[-2] if len(closes) > 1 else closes[-1])
    change        = round(current_price - prev_close, 2)
    change_pct    = round((change / prev_close) * 100, 2) if prev_close else 0.0

    # ---------- news ----------
    raw_news = ticker.news or []
    news = []
    for n in raw_news[:8]:
        content = n.get("content", {})
        title   = content.get("title") or n.get("title", "")
        summary = content.get("summary") or ""
        pub_raw = content.get("pubDate") or ""
        try:
            pub_dt  = datetime.strptime(pub_raw[:19], "%Y-%m-%dT%H:%M:%S")
            pub_str = pub_dt.strftime("%b %d, %Y")
        except Exception:
            pub_str = pub_raw[:10] if pub_raw else ""

        # canonical URL
        canon = content.get("canonicalUrl", {})
        url   = (canon.get("url") if isinstance(canon, dict) else "") or n.get("link", "#")

        source = content.get("provider", {})
        source_name = (source.get("displayName") if isinstance(source, dict) else "") or "News"

        if title:
            news.append({
                "title":   title,
                "summary": summary,
                "url":     url,
                "date":    pub_str,
                "source":  source_name,
            })

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


def configure_routes_stocks(app, socketio=None):

    @app.route("/stocks")
    def stocks_selector():
        """Landing page — pick a stock symbol."""
        return render_template("stocks.html", popular=POPULAR_STOCKS)

    @app.route("/stocks/dashboard")
    def stocks_dashboard():
        """Dashboard page — symbol comes from query param."""
        symbol = request.args.get("symbol", "AAPL").upper().strip()
        period = request.args.get("period", "1mo")
        return render_template("stocks_dashboard.html",
                               symbol=symbol,
                               period=period,
                               popular=POPULAR_STOCKS)

    @app.route("/stocks/api/data")
    def stocks_api_data():
        """JSON endpoint — called by the dashboard (and auto-refresh)."""
        symbol = request.args.get("symbol", "AAPL").upper().strip()
        period = request.args.get("period", "1mo")
        try:
            data = _fetch_stock_data(symbol, period)
            return jsonify({"status": "success", "data": data})
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 400

    @app.route("/stocks/api/search")
    def stocks_api_search():
        """Lightweight symbol search using yfinance."""
        q = request.args.get("q", "").strip()
        if not q:
            return jsonify({"results": []})
        try:
            results = yf.Search(q, max_results=8)
            quotes  = results.quotes or []
            out = [
                {"symbol": r.get("symbol", ""), "name": r.get("longname") or r.get("shortname") or ""}
                for r in quotes if r.get("symbol")
            ]
            return jsonify({"results": out})
        except Exception as e:
            return jsonify({"results": [], "error": str(e)})
