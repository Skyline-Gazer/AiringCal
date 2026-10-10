(function () {
  const config = window.bgmConfig || { apiUrl: '', quote: '' }
  const API = (config.apiUrl || window.location.origin).replace(/\/$/, '')
  const container = document.querySelector('.bgm-container')
  if (!container) return

  const TYPE_NAMES = { want: '想看', watched: '看过', watching: '在看', on_hold: '搁置', dropped: '抛弃' }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    })
  }

  function escapeAttribute(value) {
    return escapeHtml(value)
  }

  function safeUrl(value, fallback) {
    try {
      var url = new URL(String(value), location.origin)
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href
    } catch (_) {}
    return fallback || '#'
  }

  function safeNumber(value, fallback) {
    var number = Number(value)
    return Number.isFinite(number) ? number : (fallback || 0)
  }

  function safeScore(value) {
    var score = Number(value)
    return Number.isFinite(score) && score >= 0 && score <= 10 ? score : 0
  }

  container.addEventListener('click', function(event) {
    var overlay = event.target.closest && event.target.closest('.bgm-nsfw-overlay')
    if (!overlay) return
    event.preventDefault()
    var card = overlay.closest('.bgm-card')
    if (card) card.classList.toggle('bgm-nsfw-reveal')
  })

  // 顶部视图切换：番组计划（收藏列表） / 放送日历（/api/calendar）
  const VIEWS = [
    { key: 'collection', label: '番组计划' },
    { key: 'calendar', label: '放送日历' },
  ]

  // ---------------------------------------------------------------
  // NSFW 年龄确认（保持原逻辑不变）
  // ---------------------------------------------------------------
  async function checkNSFW() {
    try {
      const res = await fetch(API + '/api/config?key=nsfw')
      const data = await res.json()
      if (data.nsfw && !sessionStorage.getItem('bgm-age-confirmed')) {
        document.getElementById('bgm-age-modal').style.display = 'block'
      } else if (!data.nsfw) {
        sessionStorage.removeItem('bgm-age-confirmed')
      }
    } catch (e) {}
  }

  window.bgmConfirmAge = function () {
    sessionStorage.setItem('bgm-age-confirmed', '1')
    document.getElementById('bgm-age-modal').style.display = 'none'
  }

  window.bgmLeaveAge = function () {
    window.location.href = 'https://www.google.com'
  }

  function subjectImageUrl(images) {
    return images?.common?.uri
      ? safeUrl(API + images.common.uri, '')
      : null
  }

  function imageCacheLabel(imageStatus) {
    const status = imageStatus?.common || 'pending_next_cron'
    if (status === 'cached') return ''
    if (status === 'missing_source') return 'image missing source'
    if (status === 'failed') return 'image cache failed'
    if (status === 'queued') return 'image queued'
    return 'image pending'
  }

  function renderCover(images, imageStatus, alt, attrs) {
    const imgUrl = subjectImageUrl(images)
    return imgUrl
      ? '<img src="' + escapeAttribute(imgUrl) + '" alt="' + escapeAttribute(alt) + '" ' + attrs + '>'
      : '<span class="bgm-image-cache-failed">' + escapeHtml(imageCacheLabel(imageStatus)) + '</span>'
  }

  function renderSubjectCard(card) {
    var subjectId = Math.max(0, Math.trunc(safeNumber(card.subjectId, 0)))
    var html = '<a href="' + escapeAttribute(safeUrl('https://bgm.tv/subject/' + subjectId, '#')) + '" target="_blank" rel="noopener noreferrer" class="bgm-card'
    if (card.nsfw) html += ' bgm-nsfw'
    html += '">' +
      '<div class="bgm-card-cover">' +
        renderCover(card.images, card.imageStatus, card.name, 'width="300" height="400" loading="lazy"')
    if (card.nsfw) html += '<button type="button" class="bgm-nsfw-overlay">R18</button>'
    html += '</div>' +
      '<div class="bgm-card-info">' +
        '<h3>' + escapeHtml(card.name) + '</h3>'
    if (card.progress > 0) html += '<div class="bgm-progress"><span style="width:' + Math.min(100, Math.max(0, safeNumber(card.progress, 0))) + '%"></span></div>'
    var score = safeScore(card.score)
    if (score > 0) html += '<span class="bgm-score">★ ' + score.toFixed(1) + '</span>'
    if (card.meta) html += '<span class="bgm-ep">' + escapeHtml(card.meta) + '</span>'
    html += '</div>' +
    '</a>'
    return html
  }

  function renderCard(entry) {
    const total = entry.eps || entry.total_episodes || 0
    const progress = total > 0 ? Math.round((entry.ep_status / total) * 100) : 0
    return renderSubjectCard({
      subjectId: entry.subject_id,
      images: entry.images,
      imageStatus: entry.image_status,
      name: entry.name_cn || entry.name || '',
      nsfw: entry.nsfw,
      progress: progress,
      score: null,
      meta: entry.ep_status + '/' + ((entry.eps || entry.total_episodes || '??')),
    })
  }

  function calendarEpisodeTotal(entry) {
    return entry.total_episodes || entry.eps || entry.eps_count || entry.totalEpisodes || 0
  }

  function formatCalendarEpisodeMeta(entry) {
    const episodeTotal = calendarEpisodeTotal(entry)
    return episodeTotal > 0 ? episodeTotal + ' 话' : '集数待定'
  }

  function renderCalendarCard(entry) {
    return renderSubjectCard({
      subjectId: entry.id,
      images: entry.images,
      imageStatus: entry.image_status,
      name: entry.name_cn || entry.name || '',
      nsfw: entry.nsfw,
      progress: 0,
      score: entry.rating && entry.rating.score,
      meta: formatCalendarEpisodeMeta(entry),
    })
  }

  // ---------------------------------------------------------------
  // 收藏视图（原 render 逻辑，封装进一个容器）
  // ---------------------------------------------------------------
  function buildCollectionView() {
    var view = document.createElement('div')
    view.className = 'bgm-view bgm-view-collection'

    var nav = document.createElement('div')
    nav.className = 'bgm-nav'
    var keys = Object.keys(TYPE_NAMES)
    var navHtml = ''
    for (var i = 0; i < keys.length; i++) {
      var navActive = keys[i] === 'watching' ? ' class="active"' : ''
      navHtml += '<button data-type="' + keys[i] + '"' + navActive + '>' + TYPE_NAMES[keys[i]] + '</button>'
    }
    nav.innerHTML = navHtml
    view.appendChild(nav)

    var grid = document.createElement('div')
    grid.className = 'bgm-grid'
    view.appendChild(grid)

    var pagination = document.createElement('div')
    pagination.className = 'bgm-pagination'
    view.appendChild(pagination)

    var currentType = 'watching'
    var currentPage = 1
    var loaded = false

    async function load(type, page) {
      try {
        var res = await fetch(API + '/api/collections?type=' + type + '&page=' + page + '&limit=24')
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText)
        var data = await res.json()
        if (data.total === 0) {
          grid.innerHTML = '<p class="bgm-empty">暂无数据 — 同步可能尚未执行，数据尚未发布，请稍后再试</p>'
          pagination.innerHTML = ''
          return
        }
        var cardsHtml = ''
        for (var i = 0; i < data.data.length; i++) {
          cardsHtml += renderCard(data.data[i])
        }
        grid.innerHTML = cardsHtml

        var totalPages = Math.ceil(data.total / 24)
        pagination.innerHTML = ''
        for (var i = 1; i <= totalPages; i++) {
          var btn = document.createElement('button')
          btn.textContent = i
          if (i === page) btn.classList.add('active')
          ;(function(p) { btn.addEventListener('click', function() { currentPage = p; load(currentType, p) }) })(i)
          pagination.appendChild(btn)
        }
      } catch (e) {
        grid.innerHTML = '<p class="bgm-error">加载失败: ' + escapeHtml(e.message || '未知错误') + '<br><small>API: ' + escapeHtml(API) + '</small></p>'
      }
    }

    nav.addEventListener('click', function(e) {
      if (e.target.tagName === 'BUTTON') {
        var navBtns = nav.querySelectorAll('button')
        for (var n = 0; n < navBtns.length; n++) {
          navBtns[n].classList.toggle('active', navBtns[n] === e.target)
        }
        currentType = e.target.dataset.type
        currentPage = 1
        load(currentType, 1)
      }
    })

    return {
      el: view,
      // 首次切换到该视图时再加载（含健康检查）
      async activate() {
        if (loaded) return
        loaded = true
        var statusBar = document.createElement('div')
        statusBar.className = 'bgm-status'
        statusBar.innerHTML = '<p>正在连接...</p>'
        view.insertBefore(statusBar, nav)
        try {
          var healthRes = await fetch(API + '/api/health')
          var health = await healthRes.json()
          if (health.ok && health.data && health.data.collections) {
            var c = health.data.collections
            statusBar.innerHTML = '<p>已连接 | 条目 ' + safeNumber(c.types && c.types._total, 0) + ' | 更新于 ' + escapeHtml((c.updated_at || '?').slice(0, 10)) + '</p>'
          } else if (health.ok) {
            var hint = '数据尚未发布，请稍后再试'
            if (health.data && health.data.last_error) hint += '<br>上次同步错误: ' + escapeHtml(health.data.last_error)
            statusBar.innerHTML = '<p class="bgm-status-warn">已连接，但 KV 无数据。' + hint + '</p>'
          } else {
            statusBar.innerHTML = '<p class="bgm-status-warn">健康检查失败: ' + escapeHtml(health.error || '') + '</p>'
          }
        } catch (e) {
          statusBar.innerHTML = '<p class="bgm-status-warn">无法连接 Worker: ' + escapeHtml(e.message || '') + '</p>'
        }
        setTimeout(function () { statusBar.style.opacity = '0.4' }, 3000)
        load(currentType, 1)
      },
    }
  }

  // ---------------------------------------------------------------
  // 放送日历视图（新增）：fetch /api/calendar，按星期分组渲染
  // ---------------------------------------------------------------
  function buildCalendarView() {
    var view = document.createElement('div')
    view.className = 'bgm-view bgm-view-calendar'

    var cal = document.createElement('div')
    cal.className = 'bgm-calendar'
    view.appendChild(cal)

    var loaded = false
    // bgm.tv weekday.id: 1=周一 ... 7=周日；JS getDay(): 0=周日
    var todayId = (new Date().getDay() === 0) ? 7 : new Date().getDay()

    function renderCalendar(days) {
      if (!days || !days.length) {
        cal.innerHTML = '<p class="bgm-empty">暂无日历数据 — 同步可能尚未执行，数据尚未发布，请稍后再试</p>'
        return
      }
      var html = ''
      for (var i = 0; i < days.length; i++) {
        var day = days[i]
        var wd = day.weekday || {}
        var items = day.items || []
        var isToday = wd.id === todayId
        html += '<section class="bgm-weekday' + (isToday ? ' is-today' : '') + '">'
        html += '<div class="bgm-weekday-head">' +
          '<span class="cn">' + escapeHtml(wd.cn || '') + '</span>' +
          '<span class="en">' + escapeHtml(wd.en || '') + '</span>' +
          '<span class="count">' + items.length + '</span>' +
        '</div>'
        html += '<div class="bgm-grid">'
        for (var j = 0; j < items.length; j++) {
          html += renderCalendarCard(items[j])
        }
        html += '</div></section>'
      }
      cal.innerHTML = html
    }

    return {
      el: view,
      async activate() {
        if (loaded) return
        loaded = true
        cal.innerHTML = '<p class="bgm-status"><span>正在加载放送日历...</span></p>'
        try {
          var res = await fetch(API + '/api/calendar')
          if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText)
          var days = await res.json()
          renderCalendar(days)
        } catch (e) {
          cal.innerHTML = '<p class="bgm-error">日历加载失败: ' + escapeHtml(e.message || '未知错误') + '<br><small>API: ' + escapeHtml(API) + '</small></p>'
          loaded = false // 允许下次重试
        }
      },
    }
  }

  function statusLabel(s) {
  var map = { watching: '在看', completed: '看过', plan_to_watch: '想看', on_hold: '搁置', dropped: '抛弃' }
  return Object.prototype.hasOwnProperty.call(map, s) ? map[s] : '—'
}
function statusBadgeColor(s) {
  var map = { watching: '#00a1d6', completed: '#4caf50', plan_to_watch: '#9b59b6', on_hold: '#f39c12', dropped: '#e74c3c' }
  return Object.prototype.hasOwnProperty.call(map, s) ? map[s] : '#666'
}

  // ---------------------------------------------------------------
  // 顶层：渲染 tab 切换 + 三个视图
  // ---------------------------------------------------------------
  async function render() {
    var collectionView = buildCollectionView()
    var calendarView = buildCalendarView()
    var views = { collection: collectionView, calendar: calendarView }

    var switcher = document.createElement('div')
    switcher.className = 'bgm-view-switch'
    var btnHtml = ''
    for (var i = 0; i < VIEWS.length; i++) {
      btnHtml += '<button data-view="' + VIEWS[i].key + '">' + VIEWS[i].label + '</button>'
    }
    switcher.innerHTML = btnHtml
    container.appendChild(switcher)
    container.appendChild(collectionView.el)
    container.appendChild(calendarView.el)

    function activate(key) {
      var btns = switcher.querySelectorAll('button')
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].dataset.view === key)
      }
      collectionView.el.style.display = key === 'collection' ? '' : 'none'
      calendarView.el.style.display = key === 'calendar' ? '' : 'none'
      views[key].activate()
    }

    switcher.addEventListener('click', function (e) {
      if (e.target.tagName === 'BUTTON') activate(e.target.dataset.view)
    })

    await checkNSFW()
    activate('collection')
  }

  render()
})()
