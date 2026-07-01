(() => {
  const root = document.getElementById('bgm-cache-root')
  if (!root) return

  function row(label, counts) {
    const total = Object.values(counts || {}).reduce((sum, value) => sum + Number(value || 0), 0)
    return '<tr><th>' + label + '</th><td>' + total + '</td><td>' +
      ['cached', 'pending_next_cron', 'queued', 'failed', 'missing_source'].map((key) => key + ': ' + Number((counts || {})[key] || 0)).join('<br>') +
      '</td></tr>'
  }

  fetch('/api/cache')
    .then((response) => response.json())
    .then((data) => {
      root.innerHTML = '<p>Total subjects: ' + Number(data.total_subjects || 0) + '</p>' +
        '<table class="bgm-cache-table"><tbody>' + row('common', data.common) + row('large', data.large) + '</tbody></table>'
    })
    .catch((error) => {
      root.textContent = 'Cache statistics unavailable: ' + (error && error.message ? error.message : String(error))
    })
})()
