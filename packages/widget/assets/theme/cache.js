(() => {
  const targets = Array.from(document.querySelectorAll('[data-runtime-status]'))
  function time(value) {
    if (value === null || value === undefined) return '尚无'
    return new Date(typeof value === 'number' ? value * 1000 : value).toLocaleString()
  }
  window.addEventListener('bgm-public-state', (event) => {
    const { manifest, status, error } = event.detail
    const parts = [
      '采集 ' + (status ? status.status + ' / ' + status.stage : '等待首次运行'),
      '最近采集 ' + time(status && status.observed_at || manifest && manifest.source_observed_at),
      '快照发布 ' + time(manifest && manifest.published_at),
    ]
    if (status && status.error_code) parts.push(status.error_code)
    if (error) parts.push(error)
    for (const target of targets) target.textContent = parts.join(' | ')
  })
})()
