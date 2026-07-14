(() => {
  const targets = Array.from(document.querySelectorAll('[data-runtime-status]'))
  if (!targets.length) return
  const REFRESH_INTERVAL_MS = 60 * 1000
  let inFlight = false

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  function setTargets(html) {
    for (const target of targets) target.innerHTML = html
  }

  function formatTime(value) {
    if (!value) return ''
    const numeric = Number(value)
    const time = Number.isFinite(numeric) ? numeric * 1000 : value
    const date = new Date(time)
    if (Number.isNaN(date.getTime())) return ''
    return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  }

  function render(data) {
    const health = data && data.data ? data.data : {}
    const cache = health.cache || {}
    const cron = health.cron || {}
    const last = cron.last || {}
    const totalSubjects = Number(cache.total_subjects || 0)
    const nextCron = formatTime(cron.next_at) || 'unknown'
    const lastStatus = last.status ? last.status : 'unknown'
    const lastTime = last.completed_at || last.triggered_at
    const lastSuffix = lastTime ? ' @ ' + formatTime(lastTime) : ''
    setTargets(
      '<span>Subjects ' + totalSubjects + '</span>' +
      '<span>Next cron ' + escapeHtml(nextCron) + '</span>' +
      '<span>Last cron ' + escapeHtml(lastStatus + lastSuffix) + '</span>',
    )
  }

  function refreshRuntimeStatus() {
    if (inFlight) return
    inFlight = true
    fetch('/api/health?t=' + Date.now(), { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText)
        return response.json()
      })
      .then(render)
      .catch((error) => {
        setTargets('<span>Status unavailable: ' + escapeHtml(error && error.message ? error.message : String(error)) + '</span>')
      })
      .finally(() => {
        inFlight = false
      })
  }

  refreshRuntimeStatus()
  setInterval(refreshRuntimeStatus, REFRESH_INTERVAL_MS)
})()
