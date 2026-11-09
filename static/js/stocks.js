(() => {
    const byId = id => document.getElementById(id);
    const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
    const number = value => value == null ? '--' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
    const money = value => value == null ? '--' : Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const profitClass = value => value == null ? '' : value >= 0 ? 'gain' : 'loss';
    const icons = () => window.lucide?.createIcons();
    let portfolio = { stocks: [], transactions: [], positions: {}, quotes: {}, realized: [] };
    let period = '1wk';
    let stockMode = 'add';
    let refreshing = false;
    let detailSymbol = null;
    let detailPeriod = '1mo';
    let detailRequest = 0;
    let detailChart = null;
    let analysisSelection = null;
    let analysisRequest = 0;
    const market = new Map();
    const charts = new Map();

    async function api(path, options = {}) {
        const response = await fetch(path, options);
        const result = await response.json();
        if (!response.ok || result.status === 'error') throw new Error(result.message || 'Request failed.');
        return result;
    }
    const post = (path, data) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const position = symbol => portfolio.positions[symbol] || { quantity: 0, cost: 0, average_cost: 0, profit: 0, market_value: 0 };
    const watched = () => portfolio.stocks.filter(stock => stock.tracked);
    const currency = symbol => portfolio.quotes[symbol]?.currency || '--';

    function setupStockSearch(input, results, selectStock, changed) {
        let matches = [];
        let active = -1;
        let timer = null;
        let controller = null;
        let searchRequest = 0;
        function hide() {
            results.hidden = true;
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
        }
        function highlight() {
            results.querySelectorAll('[role="option"]').forEach((button, index) => button.setAttribute('aria-selected', String(index === active)));
            if (active >= 0) input.setAttribute('aria-activedescendant', input.id + '-option-' + active);
        }
        function render(items, message = 'No matches.') {
            matches = items;
            active = items.length ? 0 : -1;
            results.innerHTML = items.length ? items.map((item, index) => `<button type="button" role="option" id="${input.id}-option-${index}" data-index="${index}" aria-selected="${index === active}"><span>${escape(item.name)}</span><small>${escape(item.symbol)}</small></button>`).join('') : `<p>${escape(message)}</p>`;
            results.hidden = false;
            input.setAttribute('aria-expanded', 'true');
            highlight();
        }
        function choose(index) {
            const item = matches[index];
            if (!item) return;
            clearTimeout(timer);
            controller?.abort();
            searchRequest++;
            input.value = `${item.name} (${item.symbol})`;
            hide();
            selectStock(item);
        }
        input.addEventListener('input', () => {
            clearTimeout(timer);
            controller?.abort();
            const requestId = ++searchRequest;
            changed?.();
            const query = input.value.trim();
            if (!query) { hide(); return; }
            const local = portfolio.stocks.filter(stock => stock.symbol.toLowerCase().includes(query.toLowerCase()) || stock.name.toLowerCase().includes(query.toLowerCase())).slice(0, 10);
            render(local, 'Searching...');
            timer = window.setTimeout(async () => {
                controller = new AbortController();
                try {
                    const result = await api('/stocks/api/search?q=' + encodeURIComponent(query), { signal: controller.signal });
                    if (requestId !== searchRequest || document.activeElement !== input) return;
                    render(result.results || [], result.error || 'No matches.');
                } catch (error) {
                    if (requestId === searchRequest && error.name !== 'AbortError') render(local, error.message || 'Search unavailable.');
                }
            }, 300);
        });
        input.addEventListener('keydown', event => {
            if (results.hidden) return;
            if (event.key === 'Escape') { event.preventDefault(); hide(); }
            else if (['ArrowDown', 'ArrowUp'].includes(event.key) && matches.length) {
                event.preventDefault();
                active = (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
                highlight();
                results.querySelectorAll('[role="option"]')[active]?.scrollIntoView({ block: 'nearest' });
            } else if (event.key === 'Enter' && matches.length) {
                event.preventDefault();
                choose(active);
            }
        });
        results.addEventListener('click', event => {
            const button = event.target.closest('[data-index]');
            if (button) choose(Number(button.dataset.index));
        });
        document.addEventListener('pointerdown', event => {
            if (!input.closest('.stock-search').contains(event.target)) hide();
        });
        return () => {
            clearTimeout(timer);
            controller?.abort();
            searchRequest++;
            input.value = '';
            hide();
        };
    }
    const resetStockSearch = setupStockSearch(byId('stockSearch'), byId('stockSearchResults'), item => {
        byId('stockSymbol').value = item.symbol;
        byId('stockName').value = item.name;
    }, () => {
        if (stockMode === 'add') { byId('stockSymbol').value = ''; byId('stockName').value = ''; }
    });

    function renderNews(container, items) {
        container.replaceChildren();
        for (const item of items || []) {
            let url;
            try { url = new URL(item.url); } catch { continue; }
            if (!['http:', 'https:'].includes(url.protocol)) continue;
            const article = document.createElement('article');
            article.innerHTML = `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${escape(item.title)}</a><p>${escape(item.summary || '')}</p><small>${escape(item.source || '')} ${escape(item.date || '')}</small>`;
            container.appendChild(article);
        }
        if (!container.children.length) container.textContent = 'No news available.';
    }

    async function analyzeStock(item) {
        analysisSelection = item;
        const requestId = ++analysisRequest;
        byId('analysisStatus').textContent = 'Analyzing ' + item.symbol + '...';
        byId('analysisContent').hidden = true;
        byId('analysisRefresh').disabled = true;
        byId('analysisAdd').disabled = true;
        try {
            const result = await api('/stocks/api/analyze?symbol=' + encodeURIComponent(item.symbol));
            if (requestId !== analysisRequest) return;
            const data = result.data;
            analysisSelection = { symbol: data.symbol, name: data.name };
            byId('analysisTitle').textContent = data.symbol + ' · ' + data.name;
            byId('analysisBias').textContent = data.bias;
            byId('analysisBias').className = data.bias === 'BUY WATCH' ? 'gain' : data.bias === 'SELL WATCH' ? 'loss' : '';
            byId('analysisRows').innerHTML = data.signals.length ? data.signals.map(signal => `<tr><td>${escape(signal.type)}</td><td class="${signal.action === 'BUY' ? 'gain' : signal.action === 'SELL' ? 'loss' : ''}">${escape({ BUY: 'Buy watch', SELL: 'Sell watch', NEUTRAL: 'Neutral', CONTEXT: 'Context' }[signal.action] || signal.action)}</td><td>${escape(signal.value)}</td><td>${escape(signal.basis)}</td></tr>`).join('') : '<tr><td class="empty" colspan="4">Insufficient market history.</td></tr>';
            byId('analysisMessage').textContent = data.message;
            byId('analysisUpdated').textContent = 'Data fetched: ' + data.fetched_at;
            renderNews(byId('analysisNews'), data.news);
            byId('analysisStatus').textContent = '';
            byId('analysisContent').hidden = false;
            byId('analysisAdd').disabled = watched().some(stock => stock.symbol === data.symbol);
        } catch (error) {
            if (requestId === analysisRequest) byId('analysisStatus').textContent = error.message || 'Analysis unavailable.';
        } finally {
            if (requestId === analysisRequest) byId('analysisRefresh').disabled = false;
        }
    }
    setupStockSearch(byId('analysisSearch'), byId('analysisSearchResults'), analyzeStock, () => {
        analysisRequest++;
        analysisSelection = null;
        byId('analysisContent').hidden = true;
        byId('analysisStatus').textContent = '';
        byId('analysisRefresh').disabled = true;
        byId('analysisAdd').disabled = true;
    });
    byId('analysisRefresh').addEventListener('click', () => { if (analysisSelection) analyzeStock(analysisSelection); });
    byId('analysisAdd').addEventListener('click', async () => {
        if (!analysisSelection) return;
        byId('analysisAdd').disabled = true;
        try {
            await post('/stocks/select/add', analysisSelection);
            await loadPortfolio();
            refreshPrices();
        } catch (error) { byId('analysisStatus').textContent = error.message; byId('analysisAdd').disabled = false; }
    });

    function showView(view) {
        if (!['dashboard', 'transactions', 'summary', 'analysis'].includes(view)) view = 'dashboard';
        document.querySelectorAll('[data-view]').forEach(button => {
            const active = button.dataset.view === view;
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
            byId('view-' + button.dataset.view).hidden = !active;
        });
        const url = new URL(location.href);
        if (view === 'dashboard') url.searchParams.delete('view');
        else url.searchParams.set('view', view);
        history.replaceState({}, '', url);
        charts.forEach(chart => chart.resize());
        detailChart?.resize();
    }
    document.querySelectorAll('[data-view]').forEach(button => {
        button.addEventListener('click', () => showView(button.dataset.view));
        button.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const tabs = Array.from(document.querySelectorAll('[data-view]'));
            const index = tabs.indexOf(button);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            showView(tabs[next].dataset.view);
            tabs[next].focus();
        });
    });

    async function openDetail(symbol, selectedPeriod = detailPeriod, focusModal = true) {
        detailSymbol = symbol;
        detailPeriod = ['1wk', '1mo', '6mo'].includes(selectedPeriod) ? selectedPeriod : '1mo';
        const requestId = ++detailRequest;
        showView('dashboard');
        const url = new URL(location.href);
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('period', detailPeriod);
        history.replaceState({}, '', url);
        const detailDialog = byId('stockDetail');
        byId('detailTitle').textContent = symbol;
        byId('detailStatus').textContent = 'Loading details...';
        byId('detailContent').hidden = true;
        document.querySelectorAll('[data-detail-period]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.detailPeriod === detailPeriod)));
        if (!detailDialog.open) detailDialog.showModal();
        if (focusModal) byId('detailTitle').focus({ preventScroll: true });
        try {
            const [result, latestPortfolio] = await Promise.all([
                api(`/stocks/api/data?symbol=${encodeURIComponent(symbol)}&period=${detailPeriod}`),
                api('/stocks/api/portfolio')
            ]);
            if (requestId !== detailRequest) return;
            portfolio = latestPortfolio;
            const data = result.data;
            const holding = position(symbol);
            byId('detailTitle').textContent = `${data.symbol} · ${data.name}`;
            const currentProfit = Number(data.current_price) * holding.quantity - holding.cost;
            const metrics = [
                ['Price (' + (data.currency || '') + ')', money(data.current_price)],
                ['Daily Change', money(data.change) + ' (' + money(data.change_pct) + '%)'],
                ['Holding', number(holding.quantity)], ['Cost Basis', money(holding.cost)],
                ['Current P/L', money(currentProfit)], ['P/E', number(data.pe_ratio)],
                ['52-Week High', money(data.week_52_high)], ['52-Week Low', money(data.week_52_low)],
                ['Market Cap', number(data.market_cap)], ['Volume', number(data.volumes?.at(-1))]
            ];
            byId('detailMetrics').innerHTML = metrics.map(([label, value]) => `<div><span>${escape(label)}</span><strong${label === 'Current P/L' ? ` class="${profitClass(currentProfit)}"` : ''}>${escape(value)}</strong></div>`).join('');
            byId('detailContent').hidden = false;
            detailChart?.destroy();
            const maximumVolume = Math.max(1, ...(data.volumes || []).filter(value => Number.isFinite(value)));
            if (window.Chart) detailChart = new Chart(byId('detailChart'), {
                type: 'line', data: { labels: data.dates, datasets: [
                    { label: 'Price', data: data.closes, borderColor: '#88d8ab', borderWidth: 2, pointRadius: 0, tension: .2 },
                    { label: 'Volume', type: 'bar', data: data.volumes || [], yAxisID: 'volume', backgroundColor: 'rgba(165,182,170,.18)' }
                ] },
                options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#a5b6aa', maxTicksLimit: 8 }, grid: { display: false } }, y: { ticks: { color: '#a5b6aa' }, grid: { color: '#3b493f' } }, volume: { display: false, beginAtZero: true, max: maximumVolume * 4 } } }
            });
            renderNews(byId('detailNews'), data.news);
            byId('detailStatus').textContent = data.fetched_at ? `Updated ${data.fetched_at}` : '';
        } catch (error) {
            if (requestId === detailRequest) byId('detailStatus').textContent = error.message || 'Could not load details.';
        }
    }
    byId('closeDetail').addEventListener('click', () => byId('stockDetail').close());
    byId('stockDetail').addEventListener('close', () => {
        const closedSymbol = detailSymbol;
        detailRequest++;
        detailSymbol = null;
        detailChart?.destroy();
        detailChart = null;
        const url = new URL(location.href);
        url.searchParams.delete('symbol');
        url.searchParams.delete('period');
        history.replaceState({}, '', url);
        const card = Array.from(byId('stockCards').querySelectorAll('[data-symbol]')).find(item => item.dataset.symbol === closedSymbol);
        card?.querySelector('.card-symbol')?.focus({ preventScroll: true });
    });
    document.querySelectorAll('[data-detail-period]').forEach(button => button.addEventListener('click', () => {
        if (detailSymbol) openDetail(detailSymbol, button.dataset.detailPeriod, false);
    }));

    function renderCards() {
        charts.forEach(chart => chart.destroy());
        charts.clear();
        const stocks = watched().sort((left, right) => {
            const leftProfit = position(left.symbol).profit;
            const rightProfit = position(right.symbol).profit;
            if (leftProfit == null && rightProfit != null) return 1;
            if (rightProfit == null && leftProfit != null) return -1;
            return (rightProfit || 0) - (leftProfit || 0) || left.symbol.localeCompare(right.symbol);
        });
        byId('removeStock').disabled = !stocks.length;
        byId('stockCards').innerHTML = stocks.length ? stocks.map(stock => {
            const holding = position(stock.symbol);
            const quote = portfolio.quotes[stock.symbol];
            const data = market.get(stock.symbol);
            const error = data?.error;
            return `<article class="stock-card" data-symbol="${escape(stock.symbol)}"><div class="card-heading"><div><a class="card-symbol" href="/stocks/detail/${encodeURIComponent(stock.symbol)}">${escape(stock.symbol)}</a><div class="stock-name">${escape(stock.name)}</div></div><div class="price"><strong>${money(quote?.price)}</strong><span class="change">${escape(quote?.currency || '')}${data?.pct != null ? ` ${money(data.pct)}%` : ''}</span></div><button type="button" data-remove-stock="${escape(stock.symbol)}" title="Remove ${escape(stock.symbol)} from shortlist" aria-label="Remove ${escape(stock.symbol)} from shortlist"><i data-lucide="minus" aria-hidden="true"></i></button></div>${data?.closes ? `<a class="chart-link" href="/stocks/detail/${encodeURIComponent(stock.symbol)}" aria-label="View ${escape(stock.symbol)} chart"><canvas id="chart-${escape(stock.symbol)}"></canvas></a>` : `<div class="card-error">${escape(error || 'Loading prices...')}</div>`}<div class="card-metrics"><div><span>Holding</span><strong>${number(holding.quantity)}</strong></div><div><span>Cost Basis</span><strong>${money(holding.cost)}</strong></div><div><span>Current P/L</span><strong class="${profitClass(holding.profit)}">${money(holding.profit)}</strong></div></div></article>`;
        }).join('') : '<p class="empty">No stocks in the shortlist.</p>';
        icons();
        if (!window.Chart) return;
        stocks.forEach(stock => {
            const data = market.get(stock.symbol);
            const canvas = byId('chart-' + stock.symbol);
            if (!canvas || !data?.closes) return;
            const maximumVolume = Math.max(1, ...(data.volumes || []).filter(value => Number.isFinite(value)));
            charts.set(stock.symbol, new Chart(canvas, {
                type: 'line',
                data: { labels: data.dates, datasets: [
                    { label: 'Price', data: data.closes, borderColor: '#88d8ab', backgroundColor: 'rgba(136,216,171,.07)', borderWidth: 2, pointRadius: 0, tension: .2, fill: true, order: 1 },
                    { label: 'Volume', type: 'bar', data: data.volumes || [], yAxisID: 'volume', backgroundColor: '#6b98cc', order: 2 }
                ] },
                options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#a5b6aa', maxTicksLimit: 5 }, grid: { display: false } }, y: { ticks: { color: '#a5b6aa', maxTicksLimit: 5 }, grid: { color: '#3b493f' } }, volume: { display: false, beginAtZero: true, max: maximumVolume * 4 } } }
            }));
        });
    }
    function renderTables() {
        const filter = byId('tradeFilter').value.trim().toUpperCase();
        const trades = portfolio.transactions.filter(trade => trade.symbol.includes(filter)).slice().reverse();
        byId('transactionRows').innerHTML = trades.length ? trades.map(trade => `<tr><td>${escape(trade.trade_date)}</td><td>${escape(trade.symbol)}</td><td class="${trade.side === 'BUY' ? 'gain' : 'loss'}">${escape(trade.side)}</td><td class="number">${number(trade.quantity)}</td><td class="number">${money(trade.price)}</td><td class="number">${trade.side === 'BUY' ? number(trade.holding) : ''}</td><td class="note">${escape(trade.note)}</td><td><button type="button" data-delete-trade="${trade.id}" title="Delete transaction" aria-label="Delete transaction"><i data-lucide="trash-2" aria-hidden="true"></i></button></td></tr>`).join('') : '<tr><td class="empty" colspan="8">No transactions.</td></tr>';
        const realized = (portfolio.realized_summary || []).slice().sort((left, right) => right.profit - left.profit);
        byId('realizedRows').innerHTML = realized.length ? realized.map(trade => `<tr><td>${escape(trade.symbol)}</td><td>${escape(currency(trade.symbol))}</td><td class="number">${number(trade.quantity)}</td><td class="number">${money(trade.cost)}</td><td class="number">${money(trade.proceeds)}</td><td class="number ${profitClass(trade.profit)}">${money(trade.profit)}</td></tr>`).join('') : '<tr><td class="empty" colspan="6">No realized profit or loss.</td></tr>';
        const holdings = Object.entries(portfolio.positions).filter(([, holding]) => holding.quantity > 0).sort((left, right) => (right[1].profit || 0) - (left[1].profit || 0));
        byId('currentRows').innerHTML = holdings.length ? holdings.map(([symbol, holding]) => {
            const quote = portfolio.quotes[symbol];
            return `<tr><td>${escape(symbol)}</td><td>${escape(currency(symbol))}</td><td class="number">${number(holding.quantity)}</td><td class="number">${money(holding.average_cost)}</td><td class="number">${money(holding.cost)}</td><td class="number">${money(quote?.price)}</td><td class="number">${money(holding.market_value)}</td><td class="number ${profitClass(holding.profit)}">${money(holding.profit)}</td><td>${quote ? escape(new Date(quote.fetched_at).toLocaleString()) : '--'}</td></tr>`;
        }).join('') : '<tr><td class="empty" colspan="9">No open holdings.</td></tr>';
        byId('stockSymbols').innerHTML = portfolio.stocks.map(stock => `<option value="${escape(stock.symbol)}">${escape(stock.name)}</option>`).join('');
        icons();
    }
    async function loadPortfolio() {
        portfolio = await api('/stocks/api/portfolio');
        renderCards();
        renderTables();
    }
    async function refreshPrices() {
        if (refreshing) return;
        refreshing = true;
        byId('refreshStocks').disabled = true;
        byId('quoteStatus').textContent = 'Refreshing prices...';
        try {
            await loadPortfolio();
            const symbols = [...new Set([...watched().map(stock => stock.symbol), ...Object.keys(portfolio.positions).filter(symbol => position(symbol).quantity > 0)])];
            const failed = [];
            for (let index = 0; index < symbols.length; index += 4) {
                await Promise.all(symbols.slice(index, index + 4).map(async symbol => {
                    try {
                        const result = await api(`/stocks/api/spark?symbol=${encodeURIComponent(symbol)}&period=${period}`);
                        market.set(symbol, result.data);
                    } catch (error) {
                        failed.push(symbol);
                        market.set(symbol, { error: error.message });
                    }
                }));
            }
            await loadPortfolio();
            byId('quoteStatus').textContent = `${failed.length ? `Unavailable: ${failed.join(', ')}. ` : ''}Updated ${new Date().toLocaleTimeString()}`;
        } catch (error) {
            byId('stockStatus').textContent = error.message;
            byId('quoteStatus').textContent = 'Price refresh failed.';
        } finally {
            refreshing = false;
            byId('refreshStocks').disabled = false;
        }
    }
    function stockDialog(mode, symbol = '') {
        stockMode = mode;
        byId('stockForm').reset();
        byId('stockSymbol').value = symbol;
        byId('stockSymbol').readOnly = mode === 'add';
        byId('stockSearchWrap').hidden = mode === 'remove';
        resetStockSearch();
        byId('stockNameLabel').hidden = mode === 'remove';
        byId('stockDialogTitle').textContent = mode === 'remove' ? 'Remove Stock' : 'Add Stock';
        byId('stockSave').textContent = mode === 'remove' ? 'Remove' : 'Add';
        byId('stockDialogStatus').textContent = '';
        byId('stockDialog').showModal();
        byId(mode === 'add' ? 'stockSearch' : 'stockSymbol').focus();
    }
    byId('addStock').addEventListener('click', () => stockDialog('add'));
    byId('removeStock').addEventListener('click', () => stockDialog('remove', watched()[0]?.symbol || ''));
    byId('stockCards').addEventListener('click', event => {
        const button = event.target.closest('[data-remove-stock]');
        if (button) {
            stockDialog('remove', button.dataset.removeStock);
            return;
        }
        const link = event.target.closest('.card-symbol, .chart-link');
        if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            openDetail(link.closest('[data-symbol]').dataset.symbol);
        }
    });
    byId('stockForm').addEventListener('submit', async event => {
        event.preventDefault();
        byId('stockSave').disabled = true;
        try {
            if (stockMode === 'add' && !byId('stockSymbol').value) throw new Error('Choose a stock from the search results.');
            await post('/stocks/select/' + stockMode, { symbol: byId('stockSymbol').value, name: byId('stockName').value });
            await loadPortfolio();
            byId('stockDialog').close();
            if (stockMode === 'add') refreshPrices();
        } catch (error) { byId('stockDialogStatus').textContent = error.message; }
        finally { byId('stockSave').disabled = false; }
    });
    byId('addTransaction').addEventListener('click', () => {
        byId('tradeForm').reset();
        const today = new Date();
        byId('tradeDate').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        byId('tradeDate').max = byId('tradeDate').value;
        byId('tradeDialogStatus').textContent = '';
        updateHolding();
        byId('tradeDialog').showModal();
    });
    function updateHolding() {
        const buy = byId('tradeSide').value === 'BUY';
        byId('tradeHoldingLabel').hidden = !buy;
        byId('tradeHolding').value = buy ? byId('tradeQuantity').value : '';
    }
    byId('tradeSide').addEventListener('change', updateHolding);
    byId('tradeQuantity').addEventListener('input', updateHolding);
    byId('tradeForm').addEventListener('submit', async event => {
        event.preventDefault();
        const data = { trade_date: byId('tradeDate').value, symbol: byId('tradeSymbol').value.trim().toUpperCase(), side: byId('tradeSide').value, quantity: byId('tradeQuantity').value, price: byId('tradePrice').value, note: byId('tradeNote').value };
        if (data.side === 'SELL' && Number(data.quantity) > position(data.symbol).quantity) {
            byId('tradeDialogStatus').textContent = `Cannot sell ${data.quantity} ${data.symbol}; only ${number(position(data.symbol).quantity)} held.`;
            return;
        }
        byId('tradeSave').disabled = true;
        try {
            await post('/stocks/api/transactions', data);
            await loadPortfolio();
            byId('tradeDialog').close();
            refreshPrices();
        } catch (error) { byId('tradeDialogStatus').textContent = error.message; }
        finally { byId('tradeSave').disabled = false; }
    });
    byId('transactionRows').addEventListener('click', async event => {
        const button = event.target.closest('[data-delete-trade]');
        if (!button || !confirm('Delete this transaction? Holdings and FIFO profit will be recalculated.')) return;
        button.disabled = true;
        try {
            await api('/stocks/api/transactions/' + button.dataset.deleteTrade, { method: 'DELETE' });
            await loadPortfolio();
        } catch (error) { byId('stockStatus').textContent = error.message; button.disabled = false; }
    });
    document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => byId(button.dataset.close).close()));
    document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => {
        period = button.dataset.period;
        document.querySelectorAll('[data-period]').forEach(choice => choice.setAttribute('aria-pressed', String(choice === button)));
        market.clear();
        refreshPrices();
    }));
    byId('tradeFilter').addEventListener('input', renderTables);
    byId('refreshStocks').addEventListener('click', refreshPrices);
    icons();
    showView(new URL(location.href).searchParams.get('view'));
    refreshPrices();
    const initialUrl = new URL(location.href);
    if (initialUrl.searchParams.get('symbol')) openDetail(initialUrl.searchParams.get('symbol').toUpperCase(), initialUrl.searchParams.get('period') || '1mo');
    window.setInterval(() => { if (!document.hidden) refreshPrices(); }, 60000);
})();