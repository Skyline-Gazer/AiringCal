(function () {
  const config = window.bgmConfig || { apiUrl: '', quote: '' }
  const API = (config.apiUrl || window.location.origin).replace(/\/$/, '')
  const container = document.querySelector('.bgm-container')
  if (!container) return

  const TYPE_NAMES = { want: '想看', watched: '看过', watching: '在看', on_hold: '搁置', dropped: '抛弃' }

  var healthFlight = null
  var calendarLazyObserver = null
  var HEALTH_TTL_MS = 15000

  function fetchHealthJson(force) {
    var now = Date.now()
    if (!force && healthFlight && now - healthFlight.started < HEALTH_TTL_MS) {
      return healthFlight.promise
    }
    var started = Date.now()
    var promise = fetch(API + '/api/health', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText)
        return res.json()
      })
    healthFlight = { started: started, promise: promise }
    return promise
  }

  window.bgmFetchHealth = fetchHealthJson
  window.bgmSubscribeHealth = function (onData, opts) {
    fetchHealthJson(opts && opts.force).then(onData).catch(function () {})
  }

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

  function bgmCoverImageError(img) {
    if (!img) return
    var large = img.getAttribute('data-fallback-large')
    if (large) {
      img.removeAttribute('data-fallback-large')
      img.src = large
      return
    }
    var common = img.getAttribute('data-fallback-common')
    if (common) {
      img.removeAttribute('data-fallback-common')
      img.src = common
    }
  }

  container.addEventListener('error', function(event) {
    var img = event.target
    if (!img || img.tagName !== 'IMG' || !img.classList.contains('bgm-cover-img')) return
    bgmCoverImageError(img)
  }, true)

  // 顶部视图切换：番组计划（收藏列表） / 放送日历（/api/calendar）
  const VIEWS = [
    { key: 'collection', label: '番组计划' },
    { key: 'calendar', label: '放送日历' },
  ]

  // ---------------------------------------------------------------
  // NSFW gate: server policy + ageConfirmed + configStatus
  // ---------------------------------------------------------------
  var nsfwGate = null
  var nsfwGateListeners = []

  function createNsfwGate() {
    var confirmed = false
    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage) {
        confirmed = !!sessionStorage.getItem('bgm-age-confirmed')
      }
    } catch (_) {}
    return {
      configStatus: 'pending',
      nsfwAllowed: false,
      ageConfirmed: confirmed,
    }
  }

  function entriesVisibleUnderGate(gate, entries) {
    var list = entries || []
    var out = []
    for (var i = 0; i < list.length; i++) {
      var entry = list[i]
      if (entry && entry.nsfw) {
        if (gate.configStatus !== 'ok' || !gate.nsfwAllowed || !gate.ageConfirmed) continue
      }
      out.push(entry)
    }
    return out
  }

  function applyNsfwConfigResult(gate, result, storage) {
    var store = storage || sessionStorage
    if (!result || !result.ok) {
      gate.configStatus = 'error'
      gate.nsfwAllowed = false
      return
    }
    gate.configStatus = 'ok'
    gate.nsfwAllowed = result.nsfw === true
    if (!gate.nsfwAllowed) {
      store.removeItem('bgm-age-confirmed')
      gate.ageConfirmed = false
      return
    }
    gate.ageConfirmed = !!store.getItem('bgm-age-confirmed')
  }

  function setAgeModalVisible(visible) {
    var modal = document.getElementById('bgm-age-modal')
    if (!modal) return
    modal.style.display = visible ? 'block' : 'none'
  }

  function syncAgeModalFromGate(gate) {
    var show = gate.configStatus === 'ok' && gate.nsfwAllowed && !gate.ageConfirmed
    setAgeModalVisible(show)
  }

  function notifyNsfwGateChange() {
    for (var i = 0; i < nsfwGateListeners.length; i++) {
      try { nsfwGateListeners[i](nsfwGate) } catch (_) {}
    }
  }

  function onNsfwGateChange(listener) {
    nsfwGateListeners.push(listener)
  }

  nsfwGate = createNsfwGate()

  async function loadNsfwConfig() {
    try {
      var res = await fetch(API + '/api/config?key=nsfw')
      if (!res.ok) throw new Error('HTTP ' + res.status)
      var data = await res.json()
      applyNsfwConfigResult(nsfwGate, { ok: true, nsfw: !!data.nsfw }, sessionStorage)
    } catch (e) {
      applyNsfwConfigResult(nsfwGate, { ok: false }, sessionStorage)
    }
    syncAgeModalFromGate(nsfwGate)
    notifyNsfwGateChange()
    return nsfwGate
  }

  window.bgmConfirmAge = function () {
    sessionStorage.setItem('bgm-age-confirmed', '1')
    nsfwGate.ageConfirmed = true
    setAgeModalVisible(false)
    notifyNsfwGateChange()
  }

  window.bgmLeaveAge = function () {
    window.location.href = 'https://www.google.com'
  }

  function subjectImageRef(images) {
    return images?.large?.uri ? images.large : images?.common
  }

  function subjectImageUrl(images) {
    const ref = subjectImageRef(images)
    return ref?.uri ? safeUrl(API + ref.uri, '') : null
  }

  function subjectImageThumbUrl(images) {
    const large = images?.large
    if (!large?.uri || !large?.hash) return null
    return safeUrl(API + '/image/' + large.hash + '/thumb', '')
  }

  function imageCacheLabel(imageStatus) {
    const status = imageStatus?.common || 'pending_next_cron'
    if (status === 'cached') return ''
    if (status === 'missing_source') return 'image missing source'
    if (status === 'failed') return 'image cache failed'
    if (status === 'queued') return 'image queued'
    return 'image pending'
  }

  function renderCover(images, imageStatus, alt, attrs, coverOpts) {
    const thumbUrl = subjectImageThumbUrl(images)
    const imgUrl = thumbUrl || subjectImageUrl(images)
    if (!imgUrl) {
      return '<span class="bgm-image-cache-failed">' + escapeHtml(imageCacheLabel(imageStatus)) + '</span>'
    }
    var dataAttrs = ''
    if (thumbUrl) {
      var largeUrl = images?.large?.uri ? safeUrl(API + images.large.uri, '') : ''
      var commonUrl = images?.common?.uri ? safeUrl(API + images.common.uri, '') : ''
      if (largeUrl) dataAttrs += ' data-fallback-large="' + escapeAttribute(largeUrl) + '"'
      if (commonUrl && commonUrl !== largeUrl) {
        dataAttrs += ' data-fallback-common="' + escapeAttribute(commonUrl) + '"'
      }
    }
    var loading = coverOpts && coverOpts.priority ? 'eager' : 'lazy'
    var imgAttrs = attrs || ('width="300" height="400" loading="' + loading + '" decoding="async"')
    if (coverOpts && coverOpts.priority) {
      if (imgAttrs.indexOf('loading=') === -1) imgAttrs += ' loading="eager"'
      else imgAttrs = imgAttrs.replace(/loading="(?:lazy|eager)"/, 'loading="eager"')
      if (imgAttrs.indexOf('fetchpriority=') === -1) imgAttrs += ' fetchpriority="high"'
    }
    return '<img class="bgm-cover-img" src="' + escapeAttribute(imgUrl) + '"' + dataAttrs + ' alt="' + escapeAttribute(alt) + '" ' + imgAttrs + '>'
  }

  function renderSubjectCard(card, coverOpts) {
    var subjectId = Math.max(0, Math.trunc(safeNumber(card.subjectId, 0)))
    var html = '<a href="' + escapeAttribute(safeUrl('https://bgm.tv/subject/' + subjectId, '#')) + '" target="_blank" rel="noopener noreferrer" class="bgm-card'
    if (card.nsfw) html += ' bgm-nsfw'
    html += '">' +
      '<div class="bgm-card-cover">' +
        renderCover(card.images, card.imageStatus, card.name, null, coverOpts)
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

  function renderCard(entry, coverOpts) {
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
    }, coverOpts)
  }

  function calendarEpisodeTotal(entry) {
    return entry.total_episodes || entry.eps || entry.eps_count || entry.totalEpisodes || 0
  }

  function formatCalendarEpisodeMeta(entry) {
    const episodeTotal = calendarEpisodeTotal(entry)
    return episodeTotal > 0 ? episodeTotal + ' 话' : '集数待定'
  }

  function renderCalendarCard(entry, coverOpts) {
    return renderSubjectCard({
      subjectId: entry.id,
      images: entry.images,
      imageStatus: entry.image_status,
      name: entry.name_cn || entry.name || '',
      nsfw: entry.nsfw,
      progress: 0,
      score: entry.rating && entry.rating.score,
      meta: formatCalendarEpisodeMeta(entry),
    }, coverOpts)
  }

  function fillWeekdayGrid(gridEl, items, coverOpts) {
    if (!gridEl) return
    var visible = entriesVisibleUnderGate(nsfwGate, items || [])
    var html = ''
    for (var j = 0; j < visible.length; j++) {
      var priority = coverOpts && coverOpts.priorityFirst && j < 2
      html += renderCalendarCard(visible[j], priority ? { priority: true } : null)
    }
    gridEl.innerHTML = html
    gridEl.classList.remove('bgm-grid-pending')
    gridEl.removeAttribute('data-bgm-pending')
  }

  let loadAbort = null
  let loadSeq = 0
  var PAGE_LIMIT = 24
  var PREFETCH_CAP = 8

  function skeletonCardsHtml(count) {
    var n = Math.max(0, Math.trunc(Number(count) || 0))
    var html = ''
    for (var i = 0; i < n; i++) {
      html += '<div class="bgm-card bgm-card-skeleton" aria-hidden="true"><div class="bgm-card-cover"></div><div class="bgm-card-info"><h3>&nbsp;</h3></div></div>'
    }
    return html
  }

  function createPrefetchCache(cap) {
    var max = Math.max(1, Math.trunc(Number(cap) || PREFETCH_CAP))
    var map = new Map()
    function key(type, page) {
      return String(type) + ':' + String(page)
    }
    return {
      get: function (type, page) {
        var k = key(type, page)
        if (!map.has(k)) return null
        var value = map.get(k)
        map.delete(k)
        map.set(k, value)
        return value
      },
      set: function (type, page, data) {
        var k = key(type, page)
        if (map.has(k)) map.delete(k)
        map.set(k, data)
        while (map.size > max) {
          var oldest = map.keys().next().value
          map.delete(oldest)
        }
      },
      size: function () {
        return map.size
      },
    }
  }

  var prefetchCache = createPrefetchCache(PREFETCH_CAP)

  function buildPaginationWindow(current, totalPages) {
    var total = Math.max(0, Math.trunc(Number(totalPages) || 0))
    var cur = Math.min(Math.max(1, Math.trunc(Number(current) || 1)), Math.max(1, total))
    if (total <= 0) return []
    if (total <= 7) {
      var all = []
      for (var i = 1; i <= total; i++) all.push(i)
      return all
    }
    if (cur <= 4) return [1, 2, 3, 4, 5, '…', total]
    if (cur >= total - 3) return [1, '…', total - 4, total - 3, total - 2, total - 1, total]
    return [1, '…', cur - 1, cur, cur + 1, '…', total]
  }

  function renderPaginationControls(paginationEl, page, totalPages, onSelect) {
    paginationEl.innerHTML = ''
    var windowItems = buildPaginationWindow(page, totalPages)
    for (var i = 0; i < windowItems.length; i++) {
      var item = windowItems[i]
      if (item === '…') {
        var dots = document.createElement('span')
        dots.className = 'bgm-pagination-ellipsis'
        dots.textContent = '…'
        dots.setAttribute('aria-hidden', 'true')
        paginationEl.appendChild(dots)
        continue
      }
      var btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = String(item)
      if (item === page) {
        btn.classList.add('active')
        btn.setAttribute('aria-current', 'page')
      }
      ;(function (p) {
        btn.addEventListener('click', function () { onSelect(p) })
      })(item)
      paginationEl.appendChild(btn)
    }
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
    var lastLoadedData = null
    var statusBarEl = null

    function paintCollectionData(data, seq) {
      if (seq != null && seq !== loadSeq) return
      lastLoadedData = data
      if (!data || data.total === 0) {
        grid.innerHTML = '<p class="bgm-empty">暂无数据 — 同步可能尚未执行，数据尚未发布，请稍后再试</p>'
        pagination.innerHTML = ''
        grid.classList.remove('bgm-grid-skeleton')
        grid.style.minHeight = ''
        return
      }

      var visible = entriesVisibleUnderGate(nsfwGate, data.data || [])
      var cardsHtml = ''
      for (var i = 0; i < visible.length; i++) {
        cardsHtml += renderCard(visible[i], i < 2 ? { priority: true } : null)
      }
      grid.innerHTML = cardsHtml
      grid.classList.remove('bgm-grid-skeleton')
      grid.style.minHeight = ''

      var totalPages = Math.ceil(data.total / PAGE_LIMIT)
      renderPaginationControls(pagination, currentPage, totalPages, function (p) {
        currentPage = p
        load(currentType, p)
      })
    }

    function refreshVisibleCards() {
      if (!lastLoadedData) return
      if (grid.childElementCount > 0) {
        grid.style.minHeight = grid.offsetHeight + 'px'
      }
      paintCollectionData(lastLoadedData, null)
    }

    function noteConfigDenied() {
      if (!statusBarEl) return
      if (nsfwGate.configStatus !== 'error') return
      var note = document.createElement('p')
      note.className = 'bgm-status-warn'
      note.setAttribute('data-bgm-config-note', '1')
      note.textContent = 'NSFW 配置不可用，已隐藏受限内容'
      var existing = statusBarEl.querySelector('[data-bgm-config-note]')
      if (existing) existing.remove()
      statusBarEl.appendChild(note)
      statusBarEl.style.opacity = '1'
    }

    async function load(type, page) {
      if (loadAbort) {
        try { loadAbort.abort() } catch (_) {}
      }
      loadAbort = typeof AbortController !== 'undefined' ? new AbortController() : null
      var seq = ++loadSeq
      var signal = loadAbort ? loadAbort.signal : undefined

      if (grid.childElementCount > 0) {
        grid.style.minHeight = grid.offsetHeight + 'px'
      }
      grid.classList.add('bgm-grid-skeleton')
      grid.innerHTML = skeletonCardsHtml(PAGE_LIMIT)

      try {
        var data = prefetchCache.get(type, page)
        if (!data) {
          var fetchOpts = signal ? { signal: signal } : {}
          var res = await fetch(API + '/api/collections?type=' + type + '&page=' + page + '&limit=' + PAGE_LIMIT, fetchOpts)
          if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText)
          data = await res.json()
        }
        if (seq !== loadSeq) return

        paintCollectionData(data, seq)
        if (seq !== loadSeq) return

        var totalPages = Math.ceil((data.total || 0) / PAGE_LIMIT)
        prefetchNextPage(type, page, totalPages)
      } catch (e) {
        if (seq !== loadSeq) return
        if (e && (e.name === 'AbortError' || e.code === 20)) return
        lastLoadedData = null
        grid.innerHTML = '<p class="bgm-error">加载失败: ' + escapeHtml(e.message || '未知错误') + '<br><small>API: ' + escapeHtml(API) + '</small></p>'
        pagination.innerHTML = ''
        grid.classList.remove('bgm-grid-skeleton')
        grid.style.minHeight = ''
      }
    }

    function prefetchNextPage(type, page, totalPages) {
      var next = page + 1
      if (next > totalPages) return
      if (prefetchCache.get(type, next)) return
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null
      var opts = controller ? { signal: controller.signal } : {}
      fetch(API + '/api/collections?type=' + type + '&page=' + next + '&limit=' + PAGE_LIMIT, opts)
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.json()
        })
        .then(function (data) {
          prefetchCache.set(type, next, data)
        })
        .catch(function () {})
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

    onNsfwGateChange(function () {
      noteConfigDenied()
      refreshVisibleCards()
      syncAgeModalFromGate(nsfwGate)
    })

    return {
      el: view,
      refreshVisibleCards: refreshVisibleCards,
      // 首次切换到该视图时再加载（含健康检查）
      async activate() {
        if (loaded) return
        loaded = true
        statusBarEl = document.createElement('div')
        statusBarEl.className = 'bgm-status bgm-status-bar'
        statusBarEl.innerHTML = '<p>正在连接...</p>'
        view.insertBefore(statusBarEl, nav)
        load(currentType, 1)
        noteConfigDenied()
        fetchHealthJson(false).then(function (health) {
          if (health.ok && health.data && health.data.collections) {
            var c = health.data.collections
            statusBarEl.innerHTML = '<p>已连接 | 条目 ' + safeNumber(c.types && c.types._total, 0) + ' | 更新于 ' + escapeHtml((c.updated_at || '?').slice(0, 10)) + '</p>'
          } else if (health.ok) {
            var hint = '数据尚未发布，请稍后再试'
            if (health.data && health.data.last_error) hint += '<br>上次同步错误: ' + escapeHtml(health.data.last_error)
            statusBarEl.innerHTML = '<p class="bgm-status-warn">已连接，但 KV 无数据。' + hint + '</p>'
          } else {
            statusBarEl.innerHTML = '<p class="bgm-status-warn">健康检查失败: ' + escapeHtml(health.error || '') + '</p>'
          }
          noteConfigDenied()
        }).catch(function (e) {
          statusBarEl.innerHTML = '<p class="bgm-status-warn">无法连接 Worker: ' + escapeHtml(e.message || '') + '</p>'
          noteConfigDenied()
        })
        setTimeout(function () { if (statusBarEl) statusBarEl.style.opacity = '0.4' }, 3000)
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
    var lastCalendarDays = null
    // bgm.tv weekday.id: 1=周一 ... 7=周日；JS getDay(): 0=周日
    var todayId = (new Date().getDay() === 0) ? 7 : new Date().getDay()

    function renderCalendar(days) {
      lastCalendarDays = days
      if (calendarLazyObserver) {
        calendarLazyObserver.disconnect()
        calendarLazyObserver = null
      }
      if (!days || !days.length) {
        cal.innerHTML = '<p class="bgm-empty">暂无日历数据 — 同步可能尚未执行，数据尚未发布，请稍后再试</p>'
        return
      }
      cal.innerHTML = ''
      var pendingGrids = []
      for (var i = 0; i < days.length; i++) {
        var day = days[i]
        var wd = day.weekday || {}
        var items = day.items || []
        var visibleCount = entriesVisibleUnderGate(nsfwGate, items).length
        var isToday = wd.id === todayId
        var section = document.createElement('section')
        section.className = 'bgm-weekday' + (isToday ? ' is-today' : '')
        section.innerHTML = '<div class="bgm-weekday-head">' +
          '<span class="cn">' + escapeHtml(wd.cn || '') + '</span>' +
          '<span class="en">' + escapeHtml(wd.en || '') + '</span>' +
          '<span class="count">' + visibleCount + '</span>' +
        '</div>'
        var grid = document.createElement('div')
        grid.className = 'bgm-grid bgm-grid-pending'
        grid.setAttribute('data-bgm-pending', '1')
        section.appendChild(grid)
        cal.appendChild(section)
        if (isToday) {
          fillWeekdayGrid(grid, items, { priorityFirst: true })
        } else if (items.length) {
          pendingGrids.push({ grid: grid, items: items })
        } else {
          grid.classList.remove('bgm-grid-pending')
          grid.removeAttribute('data-bgm-pending')
        }
      }
      if (pendingGrids.length && typeof IntersectionObserver === 'function') {
        calendarLazyObserver = new IntersectionObserver(function (entries) {
          for (var e = 0; e < entries.length; e++) {
            var entry = entries[e]
            if (!entry.isIntersecting) continue
            var target = entry.target
            var payload = target.__bgmWeekdayItems
            if (!payload) continue
            fillWeekdayGrid(target, payload, null)
            calendarLazyObserver.unobserve(target)
            target.__bgmWeekdayItems = null
          }
        }, { root: null, rootMargin: '240px 0px', threshold: 0.01 })
        for (var p = 0; p < pendingGrids.length; p++) {
          pendingGrids[p].grid.__bgmWeekdayItems = pendingGrids[p].items
          calendarLazyObserver.observe(pendingGrids[p].grid)
        }
      } else {
        for (var f = 0; f < pendingGrids.length; f++) {
          fillWeekdayGrid(pendingGrids[f].grid, pendingGrids[f].items, null)
        }
      }
    }

    function refreshCalendarFromGate() {
      if (!lastCalendarDays) return
      renderCalendar(lastCalendarDays)
    }

    onNsfwGateChange(function () {
      refreshCalendarFromGate()
    })

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

    // Concurrent: /api/config + first collections (activate starts load)
    loadNsfwConfig()
    activate('collection')
  }

  render()
})()
