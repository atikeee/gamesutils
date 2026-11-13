# Stocks

All routes and data helpers are in `routes/routes_stocks.py`. The SQLite database
is `data/stock.db`, created when Stocks first opens. The old `popular_stocks.json`
is read once to import symbols and names only; its quantities/prices are not
migrated, as requested. The JSON file remains unchanged as a backup and is no
longer used for ongoing updates. Enter dated trades to establish holdings.

## Views

- Charts: the icon tab shows the selected shortlist. Plus adds/restores a stock;
  minus removes it from charts without deleting its transaction history. Charts
  are 230px tall and ordered by current profit, highest first.
  Green lines show price; blue bars show daily volume on a separate scale, also
  available in chart tooltips. Add searches by company name or symbol and fills
  both fields when a result is selected. The full company name is saved.
- Transactions: plus opens an entry form for date, symbol, Buy/Sell, quantity,
  price, and optional notes. Fractional shares are supported. Holding is calculated
  for buy lots only; sell rows leave it blank. Delete recalculates all holdings.
- Profit: realized profit is grouped by stock; current profit shows open positions,
  remaining FIFO cost basis, latest quote, market value, and quote timestamp.
- Analyze: search by company name or symbol for an experimental technical screen.
  Trend (SMA20/50), RSI14, MACD, a prior 20-day closing range, and relative daily
  volume are shown with their rules. Available news headlines get a keyword
  context screen, excluded from the technical bias. Results are Buy Watch, Sell
  Watch, or Mixed/Neutral, not automatic trades or guaranteed predictions.
  At least 60 daily bars are required; flat-price RSI is treated as undefined.
  These rules have no backtested confidence score and are not investment advice.

`stock_symbols` caches symbol/name pairs separately from the shortlist. Searches
use SQLite first, then Yahoo Finance when no local match is found, caching new
results. Market fetches also fill names. It is a progressively built catalog,
not a preloaded directory of every listed stock. Browsing or analyzing a cached
symbol does not add it to the shortlist; use Plus to track it.

Sales consume the earliest purchases first (FIFO), ordered by transaction date
then entry ID for same-day trades. A sell with zero shares or too many shares is
rejected, and backdated transactions are checked against the full chronological
ledger. Deleting a buy that would make a later sell invalid is also rejected.
Failed changes roll back; trade data is not lost.

Example: buy 50 MCD at 200, then 100 at 225, then sell 75 at 250. FIFO cost of
the sale is 15,625, proceeds 18,750, and realized profit 3,125. The remaining
75 shares cost 16,875. At a current price of 250, current profit is 1,875.
Fees, dividends, tax adjustments, currency conversion, and corporate actions
are not included. A stock split requires appropriate adjustments to the ledger;
this is a tracking tool, not a tax statement. Different currencies are displayed
per stock rather than combined into a misleading total.

## Daily Closing Prices

`daily_closes` stores one unadjusted close per symbol/trading date, using an upsert
so repeated syncs do not create duplicates. Chart/detail price requests save
historical completed-day closes automatically. Today's close is saved only when
the provider reports a post-market/closed market state; otherwise it waits until
the next day. Live quotes are stored separately in `quotes`, never substituted
for a final daily close.

For reliable daily collection, schedule this command in Ugreen's Task Scheduler
after the relevant market closes (for US stocks, around 18:00 America/New_York):

```sh
docker exec gamesutils flask --app app stocks-sync-closes
```

The command refreshes watched stocks and all open holdings, including holdings
removed from the shortlist, and backfills up to six months of missed trading days.
Non-trading days do not get fabricated rows. Match the NAS schedule timezone to
the exchange, including daylight saving time. Provider delays or failures may
require retrying later; this command reports failures with a nonzero exit code.

The Analyze screen requires `ta`, now included in `requirements.txt`, alongside
the existing yfinance/Python SQLite runtime. Install the updated requirements and
restart Flask. Docker's startup pip step installs it when the container restarts;
no extra operating-system package or Compose change is needed. Back up `stock.db`
regularly and keep runtime databases out of release commits.