(() => {
  const targets = Array.from(document.querySelectorAll('[data-cache-stats]'))
  if (!targets.length) return

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

  function render(data) {
    const failures = Number((data.common && data.common.failed) || 0) + Number((data.large && data.large.failed) || 0)
    setTargets(
      '<span>Subjects ' + Number(data.total_subjects || 0) + '</span>' +
      '<span>Common cached ' + Number((data.common && data.common.cached) || 0) + '</span>' +
      '<span>Large cached ' + Number((data.large && data.large.cached) || 0) + '</span>' +
      '<span>Failures ' + failures + '</span>',
    )
  }

  fetch('/api/cache')
    .then((response) => {
      if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText)
      return response.json()
    })
    .then(render)
    .catch((error) => {
      setTargets('<span>Cache unavailable: ' + escapeHtml(error && error.message ? error.message : String(error)) + '</span>')
    })
})()
