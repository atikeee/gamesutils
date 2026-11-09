from flask import render_template, request, jsonify, redirect, url_for
from dashboard import dashboard_tile
import json
import os
import sqlite3
from collections import deque
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation
from pathlib import Path
import yfinance as yf
from datetime import date, datetime, timezone
import math

STOCK_DB_PATH = Path(__file__).resolve().parents[1] / 'data' / 'stock.db'
POPULAR_STOCKS_FILE = STOCK_DB_PATH.parent / 'popular_stocks.json'


# ── Watchlist helpers ─────────────────────────────────────────────────────────

@contextmanager
def _stock_database():
    STOCK_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(STOCK_DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA foreign_keys = ON')
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _stock_symbol(value):
    import re
    symbol = str(value or '').strip().upper()
    if not re.fullmatch(r'[A-Z0-9^][A-Z0-9.^=\-]{0,19}', symbol):
        raise ValueError('Enter a valid stock symbol.')
    return symbol


def _positive_number(value, field):
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError(f'{field} must be a positive number.')
    if not number.is_finite() or number <= 0 or number > Decimal('1000000000000'):
        raise ValueError(f'{field} must be a positive number.')
    return number


def _initialize_stock_db():
    with _stock_database() as connection:
        connection.executescript('''
            CREATE TABLE IF NOT EXISTS stocks (symbol TEXT PRIMARY KEY, name TEXT NOT NULL,
                tracked INTEGER NOT NULL DEFAULT 1 CHECK(tracked IN (0,1)), sort_order INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL REFERENCES stocks(symbol), trade_date TEXT NOT NULL,
                side TEXT NOT NULL CHECK(side IN ('BUY','SELL')), quantity TEXT NOT NULL,
                price TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
            CREATE INDEX IF NOT EXISTS trade_order ON transactions(trade_date,id);
            CREATE TABLE IF NOT EXISTS quotes (symbol TEXT PRIMARY KEY REFERENCES stocks(symbol),
                price TEXT NOT NULL, currency TEXT NOT NULL, fetched_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS daily_closes (symbol TEXT NOT NULL REFERENCES stocks(symbol),
                trade_date TEXT NOT NULL, close TEXT NOT NULL, currency TEXT NOT NULL,
                PRIMARY KEY(symbol,trade_date));
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS stock_symbols (symbol TEXT PRIMARY KEY, name TEXT NOT NULL);
        ''')
        if not connection.execute("SELECT 1 FROM metadata WHERE key='symbols_imported'").fetchone():
            if POPULAR_STOCKS_FILE.is_file():
                with POPULAR_STOCKS_FILE.open(encoding='utf-8') as source:
                    entries = json.load(source)
                for index, entry in enumerate(entries if isinstance(entries, list) else []):
                    if isinstance(entry, dict) and entry.get('symbol'):
                        connection.execute('INSERT OR IGNORE INTO stocks VALUES (?,?,1,?)',
                            (_stock_symbol(entry['symbol']), str(entry.get('name') or entry['symbol']), index))
            connection.execute("INSERT INTO metadata VALUES ('symbols_imported','symbols_only')")
        connection.execute('INSERT OR IGNORE INTO stock_symbols SELECT symbol,name FROM stocks')


def _cache_stock_symbols(entries):
    _initialize_stock_db()
    with _stock_database() as connection:
        for entry in entries:
            try:
                symbol = _stock_symbol(entry.get('symbol'))
            except ValueError:
                continue
            name = str(entry.get('name') or symbol).strip()
            connection.execute('INSERT INTO stock_symbols VALUES (?,?) ON CONFLICT(symbol) DO UPDATE SET name=excluded.name', (symbol, name))
            connection.execute('UPDATE stocks SET name=? WHERE symbol=? AND name=symbol', (name, symbol))


def _fifo_portfolio(transactions, prices=None):
    prices = prices or {}
    trades = [dict(trade) for trade in transactions]
    lots, realized, remaining_by_buy = {}, [], {}
    realized_summary = {}
    for trade in sorted(trades, key=lambda item: (item['trade_date'], item['id'])):
        symbol = trade['symbol']
        quantity, price = Decimal(str(trade['quantity'])), Decimal(str(trade['price']))
        queue = lots.setdefault(symbol, deque())
        if trade['side'] == 'BUY':
            queue.append({'id': trade['id'], 'remaining': quantity, 'price': price})
            continue
        available = sum((lot['remaining'] for lot in queue), Decimal(0))
        if quantity > available:
            raise ValueError(f"{symbol}: cannot sell {quantity} shares on {trade['trade_date']}; only {available} held.")
        remaining, cost = quantity, Decimal(0)
        while remaining:
            lot = queue[0]
            consumed = min(remaining, lot['remaining'])
            cost += consumed * lot['price']
            remaining -= consumed
            lot['remaining'] -= consumed
            if not lot['remaining']:
                queue.popleft()
        proceeds = quantity * price
        totals = realized_summary.setdefault(symbol, {'symbol': symbol, 'quantity': Decimal(0), 'cost': Decimal(0), 'proceeds': Decimal(0), 'profit': Decimal(0)})
        totals['quantity'] += quantity
        totals['cost'] += cost
        totals['proceeds'] += proceeds
        totals['profit'] += proceeds - cost
        realized.append({**trade, 'quantity': float(quantity), 'price': float(price),
                         'cost': float(cost), 'proceeds': float(proceeds), 'profit': float(proceeds - cost)})
    positions = {}
    for symbol, queue in lots.items():
        quantity = sum((lot['remaining'] for lot in queue), Decimal(0))
        cost = sum((lot['remaining'] * lot['price'] for lot in queue), Decimal(0))
        current = Decimal(str(prices[symbol])) if symbol in prices else None
        positions[symbol] = {'quantity': float(quantity), 'cost': float(cost),
            'average_cost': float(cost / quantity) if quantity else 0,
            'market_value': float(quantity * current) if current is not None else None,
            'profit': float(quantity * current - cost) if current is not None else None}
        remaining_by_buy.update({lot['id']: float(lot['remaining']) for lot in queue})
    for trade in trades:
        trade.update(quantity=float(trade['quantity']), price=float(trade['price']),
                     holding=remaining_by_buy.get(trade['id'], 0) if trade['side'] == 'BUY' else None)
    summary = [{key: float(value) if isinstance(value, Decimal) else value for key, value in totals.items()}
               for totals in realized_summary.values()]
    return {'transactions': trades, 'positions': positions, 'realized': realized, 'realized_summary': summary}


def _portfolio():
    _initialize_stock_db()
    with _stock_database() as connection:
        stocks = [dict(row) for row in connection.execute('SELECT * FROM stocks ORDER BY sort_order,symbol')]
        transactions = connection.execute('SELECT * FROM transactions ORDER BY trade_date,id').fetchall()
        quotes = {row['symbol']: dict(row) for row in connection.execute('SELECT * FROM quotes')}
    result = _fifo_portfolio(transactions, {symbol: quote['price'] for symbol, quote in quotes.items()})
    result.update(stocks=stocks, quotes=quotes)
    return result


def _add_transaction(data):
    _initialize_stock_db()
    symbol = _stock_symbol(data.get('symbol'))
    trade_date = str(data.get('trade_date') or '')
    parsed_date = date.fromisoformat(trade_date)
    if parsed_date.isoformat() != trade_date or parsed_date > date.today():
        raise ValueError('Enter a valid transaction date that is not in the future.')
    side = str(data.get('side') or '').upper()
    if side not in {'BUY', 'SELL'}:
        raise ValueError('Choose Buy or Sell.')
    quantity = _positive_number(data.get('quantity'), 'Quantity')
    price = _positive_number(data.get('price'), 'Price')
    with _stock_database() as connection:
        connection.execute('BEGIN IMMEDIATE')
        connection.execute('INSERT OR IGNORE INTO stocks(symbol,name) VALUES (?,?)', (symbol, symbol))
        cursor = connection.execute('INSERT INTO transactions(symbol,trade_date,side,quantity,price,note) VALUES (?,?,?,?,?,?)',
            (symbol, trade_date, side, str(quantity), str(price), str(data.get('note') or '').strip()))
        _fifo_portfolio(connection.execute('SELECT * FROM transactions').fetchall())
        return cursor.lastrowid


def _delete_transaction(trade_id):
    _initialize_stock_db()
    with _stock_database() as connection:
        connection.execute('BEGIN IMMEDIATE')
        if not connection.execute('DELETE FROM transactions WHERE id=?', (trade_id,)).rowcount:
            raise ValueError('Transaction not found.')
        _fifo_portfolio(connection.execute('SELECT * FROM transactions').fetchall())


def _load_watchlist():
    portfolio = _portfolio()
    return [{**stock, 'quantity': portfolio['positions'].get(stock['symbol'], {}).get('quantity', 0),
             'price': portfolio['positions'].get(stock['symbol'], {}).get('average_cost', 0)}
            for stock in portfolio['stocks'] if stock['tracked']]


def _save_watchlist(entries):
    _initialize_stock_db()
    with _stock_database() as connection:
        connection.execute('BEGIN IMMEDIATE')
        connection.execute('UPDATE stocks SET tracked=0')
        for index, entry in enumerate(entries):
            symbol = _stock_symbol(entry.get('symbol'))
            connection.execute('INSERT INTO stocks VALUES (?,?,1,?) ON CONFLICT(symbol) DO UPDATE SET name=excluded.name,tracked=1,sort_order=excluded.sort_order',
                (symbol, str(entry.get('name') or symbol), index))
    return True


def _save_market_history(symbol, price, currency, history, include_today=False):
    _initialize_stock_db()
    today = datetime.now(history.index.tz).date() if history.index.tz is not None else date.today()
    with _stock_database() as connection:
        if not connection.execute('SELECT 1 FROM stocks WHERE symbol=?', (symbol,)).fetchone():
            return
        if price is not None:
            connection.execute('INSERT INTO quotes VALUES (?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET price=excluded.price,currency=excluded.currency,fetched_at=excluded.fetched_at',
                (symbol, str(_positive_number(price, 'Quote')), currency, datetime.now(timezone.utc).isoformat()))
        for timestamp, close in history['Close'].items():
            if math.isfinite(float(close)) and float(close) > 0 and (timestamp.date() < today or include_today):
                connection.execute('INSERT INTO daily_closes VALUES (?,?,?,?) ON CONFLICT(symbol,trade_date) DO UPDATE SET close=excluded.close,currency=excluded.currency',
                    (symbol, timestamp.date().isoformat(), str(close), currency))


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
    hist   = ticker.history(period=yf_period, interval=interval, auto_adjust=False)

    if hist.empty:
        raise ValueError(f"No data found for symbol '{symbol}'")

    dates   = [d.strftime("%Y-%m-%d") for d in hist.index]
    closes  = [round(float(v), 2) if not math.isnan(float(v)) else None for v in hist["Close"]]
    volumes = [int(v) if not math.isnan(float(v)) else 0 for v in hist["Volume"]]

    current_price = info.get("currentPrice") or info.get("regularMarketPrice") or closes[-1]
    prev_close    = info.get("previousClose") or (closes[-2] if len(closes) > 1 else closes[-1])
    change        = round(current_price - prev_close, 2)
    change_pct    = round((change / prev_close) * 100, 2) if prev_close else 0.0
    _save_market_history(symbol, current_price, info.get('currency', 'USD'), hist,
                         include_today=info.get('marketState') in {'POST', 'POSTPOST', 'CLOSED'})
    _cache_stock_symbols([{'symbol': symbol, 'name': info.get('longName') or info.get('shortName') or symbol}])

    try:
        raw_news = ticker.news or []
    except Exception:
        raw_news = []
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
    hist   = ticker.history(period=yf_period, interval="1d", auto_adjust=False)
    daily_hist = ticker.history(period="5d", interval="1d", auto_adjust=False)

    if hist.empty:
        raise ValueError(f"No data for '{symbol}'")

    closes  = [round(float(v), 2) if not math.isnan(float(v)) else None for v in hist["Close"]]
    dates   = [d.strftime("%b %d") for d in hist.index]
    current = info.get("currentPrice") or info.get("regularMarketPrice") or closes[-1]
    daily_closes = [round(float(v), 2) for v in daily_hist["Close"] if not math.isnan(float(v))]
    prev    = info.get("previousClose") or (daily_closes[-2] if len(daily_closes) > 1 else current)
    change  = round(current - prev, 2)
    pct     = round((change / prev) * 100, 2) if prev else 0.0
    _save_market_history(symbol, current, info.get('currency', 'USD'), hist,
                         include_today=info.get('marketState') in {'POST', 'POSTPOST', 'CLOSED'})
    _cache_stock_symbols([{'symbol': symbol, 'name': info.get('longName') or info.get('shortName') or symbol}])

    return {
        "symbol":   symbol.upper(),
        "name":     info.get("longName") or info.get("shortName") or symbol,
        "price":    round(float(current), 2),
        "change":   change,
        "pct":      pct,
        "currency": info.get("currency", "USD"),
        "dates":    dates,
        "closes":   closes,
        "volumes":  [int(value) if math.isfinite(float(value)) else 0 for value in hist['Volume']],
    }


def _analyze_stock(data):
    import re
    import pandas as pd
    from ta.momentum import RSIIndicator
    from ta.trend import MACD, SMAIndicator

    history = pd.DataFrame({'close': data['closes'], 'volume': data['volumes']}).dropna(subset=['close'])
    if len(history) < 60:
        return {'symbol': data['symbol'], 'name': data['name'], 'bias': 'INSUFFICIENT DATA',
                'signals': [], 'news': data.get('news', []), 'fetched_at': data['fetched_at'],
                'message': 'At least 60 daily bars are required for this signal screen.'}
    closes = history['close'].astype(float)
    volumes = history['volume'].astype(float)
    fast = SMAIndicator(closes, window=20).sma_indicator()
    slow = SMAIndicator(closes, window=50).sma_indicator()
    rsi = float(RSIIndicator(closes, window=14).rsi().iloc[-1])
    macd = MACD(closes).macd_diff()
    current = float(data['current_price'])
    signals = []

    def signal(kind, action, value, basis):
        signals.append({'type': kind, 'action': action, 'value': value, 'basis': basis})

    trend = 'BUY' if current > fast.iloc[-1] > slow.iloc[-1] else 'SELL' if current < fast.iloc[-1] < slow.iloc[-1] else 'NEUTRAL'
    crossover = 'New bullish crossover. ' if fast.iloc[-1] > slow.iloc[-1] and fast.iloc[-2] <= slow.iloc[-2] else 'New bearish crossover. ' if fast.iloc[-1] < slow.iloc[-1] and fast.iloc[-2] >= slow.iloc[-2] else ''
    signal('Trend', trend, f'SMA20 {fast.iloc[-1]:.2f} / SMA50 {slow.iloc[-1]:.2f}', crossover + 'Price above both averages in order is bullish; below both in order is bearish.')
    flat_price = closes.nunique() == 1
    signal('RSI', 'NEUTRAL' if flat_price else 'BUY' if rsi < 30 else 'SELL' if rsi > 70 else 'NEUTRAL', 'Undefined (flat price)' if flat_price else f'{rsi:.1f}', 'Below 30 is an oversold watch; above 70 is an overbought watch. Neither guarantees a reversal.')
    histogram = float(macd.iloc[-1])
    signal('MACD', 'BUY' if histogram > 0 else 'SELL' if histogram < 0 else 'NEUTRAL', f'{histogram:.3f}', 'Histogram above zero indicates bullish momentum; below zero indicates bearish momentum.')
    previous = closes.iloc[-21:-1]
    signal('20-Day Range', 'BUY' if current > previous.max() else 'SELL' if current < previous.min() else 'NEUTRAL', f'{previous.min():.2f} - {previous.max():.2f}', 'Current price above prior closing highs or below prior closing lows flags a breakout watch.')
    average_volume = float(volumes.iloc[-21:-1].mean())
    ratio = float(volumes.iloc[-1] / average_volume) if average_volume > 0 else None
    signal('Volume', 'CONTEXT', f'{ratio:.2f}x' if ratio is not None else 'Unavailable', 'Last daily-bar volume versus the prior 20-bar average; 1.5x or more adds activity context, not direction. Intraday volume may be incomplete.')
    positive = {'beat', 'beats', 'upgrade', 'growth', 'raises', 'record'}
    negative = {'miss', 'misses', 'downgrade', 'cuts', 'lawsuit', 'loss'}
    titles = [str(item.get('title') or '') for item in data.get('news', [])]
    words = [set(re.findall(r'[a-z]+', title.lower())) for title in titles]
    positive_count = sum(bool(title & positive) for title in words)
    negative_count = sum(bool(title & negative) for title in words)
    signal('Headlines', 'CONTEXT', f'{positive_count} positive / {negative_count} negative matches', 'Keyword screen of available headlines only. Not full sentiment analysis; context and negation can be missed. Excluded from the technical bias.')
    buys = sum(item['action'] == 'BUY' for item in signals)
    sells = sum(item['action'] == 'SELL' for item in signals)
    bias = 'BUY WATCH' if buys >= 2 and buys > sells else 'SELL WATCH' if sells >= 2 and sells > buys else 'MIXED / NEUTRAL'
    return {'symbol': data['symbol'], 'name': data['name'], 'bias': bias, 'signals': signals,
            'news': data.get('news', []), 'fetched_at': data['fetched_at'],
            'message': 'Experimental rule-based signals, not investment advice. No backtested confidence score; signals can conflict and market data may be delayed.'}


# ── Route registration ────────────────────────────────────────────────────────

def configure_routes_stocks(app, socketio=None):

    @app.route("/stocks")
    @dashboard_tile(section="tools", title="Stocks", description="View the stock watchlist and market dashboard.", icon="stocks", order=50)
    def stocks_dashboard():
        watchlist = _load_watchlist()
        return render_template("stocks/stocks_dashboard.html", watchlist=watchlist)

    @app.route("/stocks/detail/<symbol>")
    def stocks_detail(symbol):
        period = request.args.get("period", "1mo")
        return redirect(url_for('stocks_dashboard', symbol=symbol.upper(), period=period))

    @app.route("/stocks/select", methods=["GET"])
    def stocks_select():
        return redirect(url_for('stocks_dashboard', view='transactions'))

    @app.route("/stocks/select/add", methods=["POST"])
    def stocks_select_add():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify(status='error', message='Stock fields required.'), 400
        try:
            symbol = _stock_symbol(data.get('symbol'))
            watchlist = _load_watchlist()
            if not any(stock['symbol'] == symbol for stock in watchlist):
                previous_name = next((stock['name'] for stock in _portfolio()['stocks'] if stock['symbol'] == symbol), symbol)
                watchlist.append({'symbol': symbol, 'name': str(data.get('name') or previous_name)})
                _save_watchlist(watchlist)
            return jsonify(status='success')
        except ValueError as error:
            return jsonify(status='error', message=str(error)), 400

    @app.route("/stocks/select/save", methods=["POST"])
    def stocks_select_save():
        return jsonify(status='error', message='Holdings and costs are calculated from transactions.'), 400

    @app.route("/stocks/select/remove", methods=["POST"])
    def stocks_select_remove():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify(status='error', message='Stock symbol required.'), 400
        try:
            symbol = _stock_symbol(data.get('symbol'))
            _save_watchlist([stock for stock in _load_watchlist() if stock['symbol'] != symbol])
            return jsonify(status='success')
        except ValueError as error:
            return jsonify(status='error', message=str(error)), 400

    @app.route("/stocks/select/reorder", methods=["POST"])
    def stocks_select_reorder():
        data    = request.json or {}
        symbols = data.get("symbols", [])
        wl      = _load_watchlist()
        lookup  = {s["symbol"]: s for s in wl}
        _save_watchlist([lookup[sym] for sym in dict.fromkeys(symbols) if sym in lookup] + [stock for stock in wl if stock['symbol'] not in symbols])
        return jsonify({"status": "success"})

    @app.route('/stocks/api/portfolio')
    def stocks_api_portfolio():
        return jsonify(status='success', **_portfolio())

    @app.route('/stocks/api/transactions', methods=['POST'])
    def stocks_api_add_transaction():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify(status='error', message='Transaction fields required.'), 400
        try:
            return jsonify(status='success', id=_add_transaction(data)), 201
        except (ValueError, TypeError) as error:
            return jsonify(status='error', message=str(error)), 400

    @app.route('/stocks/api/transactions/<int:trade_id>', methods=['DELETE'])
    def stocks_api_delete_transaction(trade_id):
        try:
            _delete_transaction(trade_id)
            return jsonify(status='success')
        except ValueError as error:
            return jsonify(status='error', message=str(error)), 400

    @app.cli.command('stocks-sync-closes')
    def stocks_sync_closes():
        import click
        portfolio = _portfolio()
        failed = []
        for stock in portfolio['stocks']:
            if not stock['tracked'] and not portfolio['positions'].get(stock['symbol'], {}).get('quantity'):
                continue
            try:
                _fetch_spark(stock['symbol'], '6mo')
                click.echo(f"Saved daily closes: {stock['symbol']}")
            except Exception:
                failed.append(stock['symbol'])
        if failed:
            raise click.ClickException('Could not sync: ' + ', '.join(failed))

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
        if len(q) > 80:
            return jsonify(results=[], error='Search must be at most 80 characters.'), 400
        _initialize_stock_db()
        with _stock_database() as connection:
            cached = [dict(row) for row in connection.execute('''
                SELECT symbol,name FROM stock_symbols
                WHERE instr(lower(symbol),lower(?))>0 OR instr(lower(name),lower(?))>0
                ORDER BY CASE WHEN symbol=upper(?) THEN 0 ELSE 1 END,name LIMIT 10
            ''', (q, q, q))]
        if cached:
            return jsonify(results=cached, source='database')
        try:
            results = yf.Search(q, max_results=8)
            quotes  = results.quotes or []
            out = [{"symbol": r.get("symbol", ""),
                    "name":   r.get("longname") or r.get("shortname") or ""}
                   for r in quotes if r.get("symbol")]
            _cache_stock_symbols(out)
            return jsonify(results=out, source='finance')
        except Exception as e:
            return jsonify({"results": [], "error": str(e)})

    @app.route('/stocks/api/analyze')
    def stocks_api_analyze():
        try:
            symbol = _stock_symbol(request.args.get('symbol'))
            return jsonify(status='success', data=_analyze_stock(_fetch_stock_data(symbol, '6mo')))
        except ImportError:
            return jsonify(status='error', message='Install the updated requirements.txt, including ta.'), 503
        except (ValueError, TypeError, KeyError) as error:
            return jsonify(status='error', message=str(error)), 400
        except Exception:
            return jsonify(status='error', message='Analysis data is unavailable. Try again later.'), 502

    @app.route("/stocks/api/watchlist")
    def stocks_api_watchlist():
        return jsonify({"status": "success", "watchlist": _load_watchlist()})