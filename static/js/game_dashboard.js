(() => {
    const buttons = Array.from(document.querySelectorAll('[data-tv-selection]'));
    const status = document.getElementById('gameTvStatus');
    let starting = false;

    buttons.forEach(button => button.addEventListener('click', async () => {
        if (starting) return;
        starting = true;
        buttons.forEach(control => { control.disabled = true; });
        status.textContent = 'Starting ' + button.dataset.tvName + ' on TV...';
        try {
            const response = await fetch('/mm/api/remote/tv/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selection: Number(button.dataset.tvSelection) })
            });
            const text = await response.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch {
                throw new Error(`Server returned HTTP ${response.status}${response.status === 504 ? ' (gateway timeout)' : ''} instead of JSON. Check the NAS container logs.`);
            }
            if (!response.ok || !data.success) throw new Error(data.error || 'TV command failed.');
            status.textContent = 'TV wake command sent; FunHub opened ' + button.dataset.tvName + '.';
        } catch (error) {
            status.textContent = error.message || 'TV connection failed.';
        } finally {
            starting = false;
            buttons.forEach(control => { control.disabled = false; });
        }
    }));
})();