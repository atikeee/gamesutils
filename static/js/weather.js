(() => {
    const bootstrap = JSON.parse(document.getElementById('weatherBootstrap').textContent);
    const sourceColors = ['#148575', '#d95f4c', '#426fbb', '#b78320'];
    const chartDefinitions = [
        { key: 'temp_f', title: 'Temperature', unit: '°F', dailyAverage: true },
        { key: 'rain_precipitation_mm', dailyKey: 'rain_precipitation_sum_mm', title: 'Precipitation', unit: 'mm' },
        { key: 'rain_probability_pct', dailyKey: 'rain_probability_max_pct', title: 'Precipitation chance', unit: '%' },
        { key: 'wind_speed_kmh', dailyKey: 'wind_speed_max_kmh', title: 'Wind speed', unit: 'mph' },
        { key: 'fog_visibility_km', dailyKey: 'fog_visibility_avg_km', title: 'Visibility', unit: 'km' },
        { key: 'cloud_coverage_pct', dailyKey: 'cloud_coverage_avg_pct', title: 'Cloud cover', unit: '%' }
    ];
    const locationSelect = document.getElementById('locationSelect');
    const chartScroll = document.getElementById('chartScroll');
    const chartGrid = document.getElementById('chartGrid');
    const emptyState = document.getElementById('emptyState');
    const message = document.getElementById('forecastMessage');
    const updatedLabel = document.getElementById('forecastUpdated');
    const locationLabel = document.getElementById('forecastLocation');
    const dialog = document.getElementById('locationsDialog');
    const rows = document.getElementById('locationRows');
    const loadingIndicator = document.getElementById('forecastLoading');
    let locations = bootstrap.locations || [];
    let selectedId = bootstrap.selectedId || '';
    let forecast = bootstrap.forecast || null;
    let chartInstances = [];
    let pending = false;
    let loading = Boolean(bootstrap.loading);
    let pollGeneration = 0;

    function currentLocation() {
        return locations.find(location => location.id === selectedId) || null;
    }

    function showMessage(text, isError = false) {
        message.textContent = text || '';
        message.hidden = !text;
        message.classList.toggle('is-error', isError);
    }

    function formatTimestamp(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    }

    function syncHeader() {
        locationSelect.replaceChildren(...locations.map(location => new Option(location.name, location.id)));
        locationSelect.value = selectedId;
        locationSelect.disabled = locations.length === 0 || pending;
        locationLabel.textContent = currentLocation()?.name || 'No location selected';
        updatedLabel.textContent = forecast?.timestamp ? `Updated ${formatTimestamp(forecast.timestamp)}` : 'Waiting for forecast';
        loadingIndicator.hidden = !loading;
        emptyState.hidden = Boolean(forecast);
        chartScroll.hidden = !forecast;
    }

    function xLabel(record, horizon, index) {
        if (horizon === '10_day') {
            const date = new Date(`${record.date}T12:00:00`);
            return Number.isNaN(date.getTime()) ? record.date : date.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
        }
        const date = new Date(record.time);
        if (Number.isNaN(date.getTime())) return String(index + 1);
        return date.toLocaleTimeString([], { hour: 'numeric', timeZone: 'America/Los_Angeles' });
    }

    function metricValue(record, metric, source, horizon) {
        const key = horizon === '10_day' ? metric.dailyKey || metric.key : metric.key;
        const value = record[key]?.[source];
        if (metric.key === 'temp_f' && horizon === '10_day') return value?.avg ?? null;
        if (metric.key === 'wind_speed_kmh' && typeof value === 'number') return value * 0.621371;
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    function buildChartCard(metric, horizon, records) {
        const card = document.createElement('article');
        card.className = 'chart-panel';
        card.dataset.horizon = horizon;

        const heading = document.createElement('div');
        heading.className = 'chart-heading';
        const title = document.createElement('h2');
        title.textContent = metric.title;
        const unit = document.createElement('span');
        unit.className = 'chart-unit';
        unit.textContent = metric.unit;
        const headingTools = document.createElement('div');
        headingTools.className = 'chart-heading-tools';
        headingTools.appendChild(unit);
        let precipitationZoomButton = null;
        if (metric.key === 'rain_precipitation_mm') {
            precipitationZoomButton = document.createElement('button');
            precipitationZoomButton.type = 'button';
            precipitationZoomButton.className = 'chart-zoom-button';
            precipitationZoomButton.setAttribute('aria-label', 'Change precipitation chart vertical scale');
            headingTools.appendChild(precipitationZoomButton);
        }
        heading.append(title, headingTools);

        const canvasWrap = document.createElement('div');
        canvasWrap.className = 'chart-canvas-wrap';
        const canvas = document.createElement('canvas');
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `${metric.title} forecast from four weather sources`);
        canvasWrap.appendChild(canvas);
        card.append(heading, canvasWrap);

        const sources = ['0', '1', '2', '3'];
        const precipitationZoomed = metric.key === 'rain_precipitation_mm' && horizon === '48hr';
        const chart = new Chart(canvas, {
            type: 'line',
            data: {
                labels: records.map((record, index) => xLabel(record, horizon, index)),
                datasets: sources.map((source, index) => ({
                    label: bootstrap.sourceNames[source],
                    data: records.map(record => metricValue(record, metric, source, horizon)),
                    borderColor: sourceColors[index],
                    backgroundColor: `${sourceColors[index]}88`,
                    borderWidth: 2,
                    pointStyle: ['circle', 'triangle', 'rectRot', 'rect'][index],
                    pointRadius: horizon === '48hr' ? 4 + index : 5 + index,
                    pointHoverRadius: 8 + index,
                    pointBorderWidth: 1.5,
                    tension: 0.22,
                    spanGaps: true
                }))
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: item => `${item.dataset.label}: ${item.formattedValue || '—'} ${metric.unit}` } }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: {
                            autoSkip: false,
                            minRotation: 0,
                            maxRotation: 0,
                            color: '#65756f',
                            font: { family: 'IBM Plex Mono', size: 10 }
                        }
                    },
                    y: {
                        ...(metric.key === 'rain_precipitation_mm' ? {
                            min: 0,
                            ...(precipitationZoomed ? { max: 1 } : {})
                        } : {}),
                        grid: { color: '#e8eeeb' },
                        ticks: { color: '#65756f', font: { family: 'IBM Plex Mono', size: 10 } }
                    }
                }
            }
        });
        chartInstances.push(chart);
        if (precipitationZoomButton) {
            let zoomed = precipitationZoomed;
            const updateZoomButton = () => {
                precipitationZoomButton.textContent = zoomed ? 'Auto range' : '0-1 mm';
                precipitationZoomButton.title = zoomed ? 'Show the full precipitation range' : 'Zoom precipitation to 0-1 mm';
                precipitationZoomButton.setAttribute('aria-pressed', String(zoomed));
            };
            updateZoomButton();
            precipitationZoomButton.addEventListener('click', () => {
                zoomed = !zoomed;
                chart.options.scales.y.max = zoomed ? 1 : undefined;
                chart.update();
                updateZoomButton();
            });
        }
        return card;
    }

    function renderCharts() {
        chartInstances.forEach(chart => chart.destroy());
        chartInstances = [];
        const horizon = document.querySelector('input[name="horizon"]:checked')?.value || '48hr';
        const records = forecast?.[horizon] || [];
        chartGrid.replaceChildren();
        chartGrid.dataset.horizon = horizon;
        if (!records.length) {
            chartScroll.hidden = true;
            emptyState.hidden = false;
            return;
        }
        chartScroll.hidden = false;
        emptyState.hidden = true;
        chartGrid.style.width = `${records.length * (horizon === '48hr' ? 66 : 100)}px`;
        chartDefinitions.forEach(metric => chartGrid.appendChild(buildChartCard(metric, horizon, records)));
    }

    function startForecastPolling(identifier) {
        const generation = ++pollGeneration;
        void pollForecastStatus(identifier, generation);
    }

    async function pollForecastStatus(identifier, generation) {
        while (generation === pollGeneration && selectedId === identifier && loading) {
            await new Promise(resolve => window.setTimeout(resolve, 2000));
            if (generation !== pollGeneration || selectedId !== identifier) return;
            try {
                const response = await fetch(`/weather/api/status?selected_id=${encodeURIComponent(identifier)}`, { cache: 'no-store' });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Could not check forecast status.');
                if (generation !== pollGeneration || selectedId !== identifier) return;
                if (result.forecast) forecast = result.forecast;
                loading = Boolean(result.loading);
                syncHeader();
                if (forecast) renderCharts();
                showMessage(result.warning || '', Boolean(result.warning));
            } catch (error) {
                showMessage(error.message, true);
            }
        }
    }

    async function selectLocation(identifier) {
        if (!identifier || pending) return;
        pollGeneration++;
        pending = true;
        selectedId = identifier;
        syncHeader();
        showMessage('Loading forecast…');
        try {
            const response = await fetch('/weather/api/selection', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selected_id: identifier })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Could not load this location.');
            selectedId = result.location.id;
            forecast = result.forecast || null;
            loading = Boolean(result.loading);
            syncHeader();
            renderCharts();
            showMessage(result.warning || '', Boolean(result.warning));
            if (loading) startForecastPolling(selectedId);
        } catch (error) {
            forecast = null;
            loading = false;
            syncHeader();
            renderCharts();
            showMessage(error.message, true);
        } finally {
            pending = false;
            syncHeader();
        }
    }

    function appendLocationRow(location = {}) {
        const row = document.createElement('tr');
        const nameCell = document.createElement('td');
        const name = document.createElement('input');
        name.type = 'text';
        name.name = 'name';
        name.maxLength = 80;
        name.required = true;
        name.placeholder = 'Location name';
        name.value = location.name || '';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove-row';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove ${location.name || 'location row'}`);
        remove.addEventListener('click', () => row.remove());
        nameCell.append(name, remove);
        row.appendChild(nameCell);

        for (const [field, placeholder] of [['longitude', '-122.9898'], ['latitude', '45.5229']]) {
            const cell = document.createElement('td');
            const input = document.createElement('input');
            input.type = 'number';
            input.name = field;
            input.step = 'any';
            input.required = true;
            input.placeholder = placeholder;
            input.value = location[field] ?? '';
            input.setAttribute('aria-label', `${field} for ${location.name || 'new location'}`);
            cell.appendChild(input);
            row.appendChild(cell);
        }
        rows.appendChild(row);
    }

    function openLocationsEditor() {
        rows.replaceChildren();
        locations.forEach(appendLocationRow);
        if (!locations.length) appendLocationRow();
        document.getElementById('locationFormMessage').hidden = true;
        dialog.showModal();
    }

    document.getElementById('manageLocations').addEventListener('click', openLocationsEditor);
    document.getElementById('closeLocations').addEventListener('click', () => dialog.close());
    document.getElementById('cancelLocations').addEventListener('click', () => dialog.close());
    document.getElementById('addLocationRow').addEventListener('click', () => appendLocationRow());
    locationSelect.addEventListener('change', event => selectLocation(event.target.value));
    document.querySelectorAll('input[name="horizon"]').forEach(input => input.addEventListener('change', renderCharts));

    document.getElementById('locationsForm').addEventListener('submit', async event => {
        event.preventDefault();
        const formMessage = document.getElementById('locationFormMessage');
        const nextLocations = [...rows.querySelectorAll('tr')].map(row => ({
            name: row.querySelector('[name="name"]').value.trim(),
            longitude: row.querySelector('[name="longitude"]').value,
            latitude: row.querySelector('[name="latitude"]').value
        }));
        try {
            const response = await fetch('/weather/api/locations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ locations: nextLocations, selected_id: selectedId })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Could not save locations.');
            locations = result.locations;
            selectedId = result.selected_id;
            dialog.close();
            syncHeader();
            if (selectedId) await selectLocation(selectedId);
            else {
                forecast = null;
                renderCharts();
                syncHeader();
                showMessage('Add a location to load a forecast.');
            }
        } catch (error) {
            formMessage.textContent = error.message;
            formMessage.hidden = false;
        }
    });

    syncHeader();
    if (forecast) renderCharts();
    else if (!locations.length) renderCharts();
    if (bootstrap.warning) showMessage(bootstrap.warning, true);
    if (loading && selectedId) startForecastPolling(selectedId);
})();