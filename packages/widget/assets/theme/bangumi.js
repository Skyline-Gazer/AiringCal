(function () {
  const config = window.bgmConfig || { apiUrl: '', quote: '' }
  const API = (config.apiUrl || window.location.origin).replace(/\/$/, '')
  const container = document.querySelector('.bgm-container')
  if (!container) return

  const TYPE_NAMES = { want: '想看', watched: '看过', watching: '在看', on_hold: '搁置', dropped: '抛弃' }

  // 顶部视图切换：番组计划（收藏列表） / 放送日历（/api/calendar） / 动画同步
  const VIEWS = [
    { key: 'collection', label: '番组计划' },
    { key: 'calendar', label: '放送日历' },
    { key: 'sync', label: '动画同步' },
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
      ? API + images.common.uri
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
      ? '<img src="' + imgUrl + '" alt="' + alt + '" ' + attrs + '>'
      : '<span class="bgm-image-cache-failed">' + imageCacheLabel(imageStatus) + '</span>'
  }

  function renderSubjectCard(card) {
    var html = '<a href="https://bgm.tv/subject/' + card.subjectId + '" target="_blank" class="bgm-card'
    if (card.nsfw) html += ' bgm-nsfw'
    html += '">' +
      '<div class="bgm-card-cover">' +
        renderCover(card.images, card.imageStatus, card.name, 'width="300" height="400" loading="lazy"')
    if (card.nsfw) html += '<div class="bgm-nsfw-overlay" onclick="event.preventDefault();this.parentElement.parentElement.classList.toggle(\'bgm-nsfw-reveal\')">R18</div>'
    html += '</div>' +
      '<div class="bgm-card-info">' +
        '<h3>' + card.name + '</h3>'
    if (card.progress > 0) html += '<div class="bgm-progress"><span style="width:' + card.progress + '%"></span></div>'
    if (card.score) html += '<span class="bgm-score">★ ' + Number(card.score).toFixed(1) + '</span>'
    html += '<span class="bgm-ep">' + card.meta + '</span>' +
      '</div>' +
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

  function renderCalendarCard(entry) {
    return renderSubjectCard({
      subjectId: entry.id,
      images: entry.images,
      imageStatus: entry.image_status,
      name: entry.name_cn || entry.name || '',
      nsfw: entry.nsfw,
      progress: 0,
      score: entry.rating && entry.rating.score,
      meta: ((entry.eps || entry.total_episodes) || '??') + ' 话',
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
          grid.innerHTML = '<p class="bgm-empty">暂无数据 — 同步可能尚未执行，请在动画同步视图配置 token 并触发同步</p>'
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
          ;(function(p) { btn.onclick = function() { currentPage = p; load(currentType, p) } })(i)
          pagination.appendChild(btn)
        }
      } catch (e) {
        grid.innerHTML = '<p class="bgm-error">加载失败: ' + (e.message || '未知错误') + '<br><small>API: ' + API + '</small></p>'
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
            statusBar.innerHTML = '<p>已连接 | 条目 ' + (c.types && c.types._total) + ' | 更新于 ' + (c.updated_at || '?').slice(0, 10) + '</p>'
          } else if (health.ok) {
            var hint = '请在动画同步视图配置 token 并触发同步'
            if (health.data && health.data.last_error) hint += '<br>上次同步错误: ' + health.data.last_error
            statusBar.innerHTML = '<p class="bgm-status-warn">已连接，但 KV 无数据。' + hint + '</p>'
          } else {
            statusBar.innerHTML = '<p class="bgm-status-warn">健康检查失败: ' + (health.error || '') + '</p>'
          }
        } catch (e) {
          statusBar.innerHTML = '<p class="bgm-status-warn">无法连接 Worker: ' + (e.message || '') + '</p>'
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
        cal.innerHTML = '<p class="bgm-empty">暂无日历数据 — 同步可能尚未执行，请在动画同步视图配置 token 并触发同步</p>'
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
          '<span class="cn">' + (wd.cn || '') + '</span>' +
          '<span class="en">' + (wd.en || '') + '</span>' +
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
          cal.innerHTML = '<p class="bgm-error">日历加载失败: ' + (e.message || '未知错误') + '<br><small>API: ' + API + '</small></p>'
          loaded = false // 允许下次重试
        }
      },
    }
  }

  // ---------------------------------------------------------------
  // 动画同步视图（多账户对比 + 同步）
  // ---------------------------------------------------------------
  function buildSyncView() {
    var view = document.createElement('div')
    view.className = 'bgm-view bgm-view-sync'

    // ── Token area ──
    var tok = document.createElement('div')
    tok.className = 'sync-token-area'
    tok.innerHTML = '<h3>多账户动画同步</h3>' +
      '<p class="muted" style="font-size:12px;margin-bottom:8px;">粘贴 <a href="https://bgm.tv/dev" target="_blank">bgm.tv Access Token</a>，两个账号各一个；同步动画条目、状态、评分和章节进度</p>'
    view.appendChild(tok)

    function buildTokenRow(side, idSuffix) {
      var row = document.createElement('div')
      row.className = 'sync-token-row'
      var saved = sessionStorage.getItem('sync-token' + idSuffix) || ''
      if (saved) {
        row.innerHTML = '<span class="sync-token-ok">\u2713 ' + side + ' token 已就绪</span>' +
          ' <button class="sync-token-clear" data-side="' + idSuffix + '">清除</button>'
      } else {
        row.innerHTML = '<div class="sync-token-fields">' +
          '<label class="sync-token-label sync-token-label-grow">' + side + ' Token' +
          '<input type="password" class="sync-token-input" data-side="' + idSuffix + '" placeholder="Access Token"></label>' +
          '<label class="sync-token-label">平台<select class="sync-platform" data-side="' + idSuffix + '"><option value="bgm">bgm.tv</option></select></label>' +
          '</div>'
      }
      return row
    }

    var rowA = buildTokenRow('Account A', 'A')
    var rowB = buildTokenRow('Account B', 'B')
    tok.appendChild(rowA)
    tok.appendChild(rowB)

    var compareBtn = document.createElement('button')
    compareBtn.id = 'sync-compare-btn'
    compareBtn.className = 'bgm-nav-button'
    compareBtn.textContent = '对比收藏'
    compareBtn.style.cssText = 'margin-top:8px;width:100%;'
    tok.appendChild(compareBtn)

    // ── Result area ──
    var resultArea = document.createElement('div')
    resultArea.id = 'sync-result'
    view.appendChild(resultArea)

    var loaded = false
    var syncState = { tokenA: '', tokenB: '', data: null, page: 1, filter: 'all', search: '' }
    var SYNC_BATCH_SIZE = 5

    // ── Token clear handler ──
    tok.addEventListener('click', function(e) {
      if (e.target.classList.contains('sync-token-clear')) {
        var side = e.target.dataset.side
        sessionStorage.removeItem('sync-token' + side)
        var row = e.target.closest('.sync-token-row')
        var newRow = buildTokenRow(side === 'A' ? 'Account A' : 'Account B', side)
        row.parentNode.replaceChild(newRow, row)
      }
    })

    // ── Card renderer ──
    function getTitle(entry) {
      return entry.title || entry.name_cn || entry.name || '#' + (entry.externalId || entry.subject_id)
    }

    function canSyncSection(dir, section) {
      if (section === 'diff') return true
      if (section === 'onlyA') return dir === 'A->B'
      if (section === 'onlyB') return dir === 'B->A'
      return false
    }

    function getFilteredEntries(filter, search) {
      var data = syncState.data; if (!data) return
      var all = []
      function push(d, section) {
        if (search && getTitle(d).toLowerCase().indexOf(search.toLowerCase()) === -1) return
        var entry = Object.assign({}, d)
        entry._section = section
        all.push(entry)
      }

      if (filter === 'all' || filter === 'diff') {
        ;(data.differences || []).forEach(function(d) { push(d, 'diff') })
      }
      if (filter === 'all' || filter === 'onlyA') {
        ;(data.onlyA || []).forEach(function(d) { push(d, 'onlyA') })
      }
      if (filter === 'all' || filter === 'onlyB') {
        ;(data.onlyB || []).forEach(function(d) { push(d, 'onlyB') })
      }
      if (filter === 'same') {
        ;(data.same || []).forEach(function(d) { push(d, 'same') })
      }
      return all
    }

    function renderCards(filter, page, pageSize, search) {
      var data = syncState.data; if (!data) return
      var nameA = (data.userA && data.userA.name) || 'A'
      var nameB = (data.userB && data.userB.name) || 'B'
      var dir = (document.getElementById('sync-direction') || {}).value || 'A->B'
      var all = getFilteredEntries(filter, search) || []

      var tp = Math.ceil(all.length / pageSize) || 1
      var start = (page - 1) * pageSize
      var pageItems = all.slice(start, start + pageSize)

      var h = ''
      h += '<div class="sync-cards">'
      if (!pageItems.length) {
        h += '<p class="bgm-empty" style="padding:20px;text-align:center;">无匹配条目</p>'
      } else {
        pageItems.forEach(function(d) {
          var isDiff = d._section === 'diff'
          var isOnlyA = d._section === 'onlyA'
          var isOnlyB = d._section === 'onlyB'
          var isSame = d._section === 'same'; if (isSame) { d.statusA = d.statusB = d.status; d.progressA = d.progressB = d.progress; d.scoreA = d.scoreB = d.score; }
          var canSync = canSyncSection(dir, d._section)

          var borderColor = ''
          if (isDiff && d.statusA !== d.statusB) borderColor = '#e94560'
          else if (isDiff && d.progressA !== d.progressB) borderColor = '#ff9800'
          else if (isOnlyA || isOnlyB) borderColor = '#4caf50'

          h += '<div class="sync-card" style="' + (borderColor ? 'border-left:4px solid ' + borderColor : '') + '">'

          // Title row
          var highScore = Math.max(d.scoreA || 0, d.scoreB || 0, d.score || 0)
          var highEp = Math.max(d.totalEpisodes || d.progressA || d.progressB || d.progress || 0)
          var titleExtras = ''
          if (highEp > 0 || highScore > 0) {
            titleExtras = '<span class="sync-card-meta">'
            if (highEp > 0) titleExtras += highEp + '话'
            if (highScore > 0) titleExtras += (highEp > 0 ? ' / ' : '') + '\u2605 ' + highScore
            titleExtras += '</span>'
          }
          var titleName = getTitle(d)
          h += '<div class="sync-card-title">' + titleName + titleExtras + '</div>'

          // Side-by-side columns
          h += '<div class="sync-card-cols">'

          // Column A
          h += '<div class="sync-card-col">'
          h += '<div class="sync-col-label">' + nameA + '</div>'
          if (isOnlyB) {
            h += '<div class="sync-col-empty">\u2014</div>'
          } else {
            h += '<span class="sync-badge" style="background:' + statusBadgeColor(d.statusA) + '">' + statusLabel(d.statusA) + '</span>'
            var pctA = (d.totalEpisodes || d.progressA) > 0 ? Math.round(d.progressA / Math.max(d.totalEpisodes || d.progressA, 1) * 100) : 0
            h += '<div class="sync-progress-bar"><span style="width:' + pctA + '%"></span></div>'
            h += '<span class="sync-progress-text">' + d.progressA + '话</span>'
            if (d.scoreA > 0) {
              var arrow = (d.scoreA > d.scoreB) ? ' <span style="color:#e94560;">\u2191</span>' : ''
              h += '<span class="sync-score">\u2605 ' + d.scoreA + arrow + '</span>'
            }
          }
          h += '</div>'

          // Column B
          h += '<div class="sync-card-col">'
          h += '<div class="sync-col-label">' + nameB + '</div>'
          if (isOnlyA) {
            h += '<div class="sync-col-empty">\u2014</div>'
          } else {
            h += '<span class="sync-badge" style="background:' + statusBadgeColor(d.statusB) + '">' + statusLabel(d.statusB) + '</span>'
            var pctB = (d.totalEpisodes || d.progressB) > 0 ? Math.round(d.progressB / Math.max(d.totalEpisodes || d.progressB, 1) * 100) : 0
            h += '<div class="sync-progress-bar"><span style="width:' + pctB + '%"></span></div>'
            h += '<span class="sync-progress-text">' + d.progressB + '话</span>'
            if (d.scoreB > 0) {
              var arrowB = (d.scoreB > d.scoreA) ? ' <span style="color:#e94560;">\u2191</span>' : ''
              h += '<span class="sync-score">\u2605 ' + d.scoreB + arrowB + '</span>'
            }
          }
          h += '</div>'

          h += '</div>' // sync-card-cols

          // Checkbox row
          if (canSync) {
            var cid = d.externalId || d.subject_id
            h += '<div class="sync-card-check"><label><input type="checkbox" checked data-id="' + cid + '"> \u540c\u6b65\u6b64\u9879</label></div>'
          } else if (!isSame) {
            h += '<div class="sync-card-check"><span class="sync-card-nosync">\u5f53\u524d\u65b9\u5411\u4e0d\u53ef\u540c\u6b65</span></div>'
          }

          h += '</div>' // sync-card
        })
      }
      h += '</div>' // sync-cards

      // Pagination
      if (tp > 1) {
        h += '<div class="sync-pagination">'
        var pages = [1]
        for (var p = Math.max(2, page - 2); p <= Math.min(tp - 1, page + 2); p++) pages.push(p)
        pages.push(tp)
        pages.forEach(function(p, i) {
          if (i > 0 && pages[i-1] !== '...' && p - pages[i-1] > 1) h += '<span>...</span>'
          if (p === page) h += '<span class="sync-pg-active">' + p + '</span>'
          else h += '<button class="sync-pg-btn" data-pg="' + p + '">' + p + '</button>'
        })
        h += '</div>'
      }

      resultArea.querySelector('.sync-cards-wrap').innerHTML = h

      // Wire pagination
      resultArea.querySelectorAll('.sync-pg-btn').forEach(function(b) {
        b.addEventListener('click', function() {
          syncState.page = parseInt(this.dataset.pg)
          renderCards(syncState.filter, syncState.page, parseInt(document.getElementById('sync-pagesize').value), syncState.search)
        })
      })
    }

    function renderCompareResult(data) {
      var nameA = (data.userA && data.userA.name) || 'A'
      var nameB = (data.userB && data.userB.name) || 'B'
      var sameLen = (data.same || []).length
      var diffLen = (data.differences || []).length
      var onlyALen = (data.onlyA || []).length
      var onlyBLen = (data.onlyB || []).length
      var allLen = diffLen + onlyALen + onlyBLen

      syncState.data = data
      syncState.filter = 'all'
      syncState.page = 1
      syncState.search = ''

      var h = ''

      // Pill navigation
      h += '<div class="sync-pills">'
      h += '<button class="sync-pill active" data-filter="all">\u5168\u90e8 ' + allLen + '</button>'
      if (diffLen) h += '<button class="sync-pill" data-filter="diff">\u5dee\u5f02 ' + diffLen + '</button>'
      if (onlyALen) h += '<button class="sync-pill" data-filter="onlyA">\u4ec5' + nameA + ' ' + onlyALen + '</button>'
      if (onlyBLen) h += '<button class="sync-pill" data-filter="onlyB">\u4ec5' + nameB + ' ' + onlyBLen + '</button>'
      if (sameLen) h += '<button class="sync-pill" data-filter="same">\u76f8\u540c ' + sameLen + '</button>'
      h += '</div>'

      // Progress bar (top)
      h += '<div id="sync-progress" style="display:none;margin-bottom:12px;"><div class="bgm-progress"><span id="sync-progress-fill" style="width:0%"></span></div>' +
        '<p id="sync-progress-text" class="muted" style="font-size:12px;margin-top:4px;"></p></div>'

      // Toolbar
      h += '<div class="sync-toolbar">'
      h += '<button id="sync-sel-all" class="sync-tool-btn">\u5168\u9009</button>'
      h += '<button id="sync-sel-rev" class="sync-tool-btn">\u53cd\u9009</button>'
      h += '<select id="sync-pagesize" class="sync-select"><option value="20">20/\u9875</option><option value="50">50/\u9875</option><option value="100">100/\u9875</option></select>'
      h += '<input type="text" id="sync-search" class="sync-search" placeholder="\u641c\u7d22\u6761\u76ee...">'
      h += '<span style="flex:1;"></span>'
      h += '<select id="sync-direction" class="sync-select">'
      h += '<option value="A->B">' + nameA + ' \u2192 ' + nameB + '</option>'
      h += '<option value="B->A">' + nameB + ' \u2192 ' + nameA + '</option></select>'
      h += '<button id="sync-full-btn" class="sync-tool-btn sync-tool-btn-primary">\u540c\u6b65\u7b5b\u9009\u5168\u90e8</button>'
      h += '<button id="sync-sel-btn" class="sync-tool-btn">\u9009\u4e2d\u540c\u6b65</button>'
      h += '</div>'

      // Cards container
      h += '<div class="sync-cards-wrap"></div>'

      resultArea.innerHTML = h

      // Wire events
      resultArea.querySelectorAll('.sync-pill').forEach(function(pill) {
        pill.addEventListener('click', function() {
          resultArea.querySelectorAll('.sync-pill').forEach(function(p) { p.classList.remove('active') })
          this.classList.add('active')
          syncState.filter = this.dataset.filter
          syncState.page = 1
          renderCards(syncState.filter, 1, parseInt(document.getElementById('sync-pagesize').value), syncState.search)
        })
      })

      document.getElementById('sync-pagesize').addEventListener('change', function() {
        syncState.page = 1
        renderCards(syncState.filter, 1, parseInt(this.value), syncState.search)
      })

      document.getElementById('sync-search').addEventListener('input', function() {
        syncState.search = this.value
        syncState.page = 1
        renderCards(syncState.filter, 1, parseInt(document.getElementById('sync-pagesize').value), this.value)
      })

      document.getElementById('sync-sel-all').addEventListener('click', function() {
        resultArea.querySelectorAll('input[type=checkbox]').forEach(function(c) { c.checked = true })
      })
      document.getElementById('sync-sel-rev').addEventListener('click', function() {
        resultArea.querySelectorAll('input[type=checkbox]').forEach(function(c) { c.checked = !c.checked })
      })
      document.getElementById('sync-direction').addEventListener('change', function() {
        renderCards(syncState.filter, 1, parseInt(document.getElementById('sync-pagesize').value), syncState.search)
      })

      document.getElementById('sync-full-btn').addEventListener('click', function() { doSyncOp('full', []) })
      document.getElementById('sync-sel-btn').addEventListener('click', function() {
        var ids = Array.from(resultArea.querySelectorAll('input[type=checkbox]:checked')).map(function(c) { return c.dataset.id })
        if (!ids.length) return alert('\u8bf7\u81f3\u5c11\u9009\u4e2d\u4e00\u4e2a\u6761\u76ee')
        doSyncOp('partial', ids)
      })

      renderCards('all', 1, 20, '')
    }

    function getEntryId(entry) {
      return entry && (entry.externalId || entry.subject_id)
    }

    function uniqueIds(entries) {
      var seen = {}
      var ids = []
      entries.forEach(function(entry) {
        var id = String(getEntryId(entry) || '')
        if (!id || seen[id]) return
        seen[id] = true
        ids.push(id)
      })
      return ids
    }

    function getSyncableFilteredIds(dir, filter, search) {
      return uniqueIds((getFilteredEntries(filter, search) || []).filter(function(entry) {
        return canSyncSection(dir, entry._section)
      }))
    }

    function escapeSyncHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    function formatEpisodeProgress(progress) {
      if (!progress) return ''
      var delta = progress.after - progress.before
      var suffix = delta === 0 ? '\u65e0\u53d8\u5316' : ((delta > 0 ? '+' : '') + delta)
      if (progress.total > 0) return progress.before + '/' + progress.total + ' -> ' + progress.after + '/' + progress.total + ' (' + suffix + ')'
      return progress.before + ' -> ' + progress.after + ' (' + suffix + ')'
    }

    function formatFieldChange(change) {
      if (!change) return ''
      var before = change.before == null ? '\u2014' : change.before
      var after = change.after == null ? '\u2014' : change.after
      return before + ' -> ' + after
    }

    function buildSyncBaseline(dir, ids) {
      var wanted = {}
      ids.forEach(function(id) { wanted[String(id)] = true })
      return (getFilteredEntries(syncState.filter, syncState.search) || []).filter(function(entry) {
        return wanted[String(getEntryId(entry) || '')]
      }).map(function(entry) {
        var targetIsB = dir === 'A->B'
        return {
          externalId: String(getEntryId(entry) || ''),
          status: targetIsB ? entry.statusB : entry.statusA,
          score: targetIsB ? entry.scoreB : entry.scoreA,
          progress: targetIsB ? entry.progressB : entry.progressA,
          totalEpisodes: entry.totalEpisodes || Math.max(entry.progressA || 0, entry.progressB || 0),
        }
      })
    }

    function renderInlineSyncLog(results, operationLinks) {
      var rows = results.map(function(r) {
        var cls = r.status === 'ok' ? 'ok' : 'error'
        return '<tr>' +
          '<td>' + escapeSyncHtml(r.externalId) + '</td>' +
          '<td>' + escapeSyncHtml(r.title || '') + '</td>' +
          '<td class="' + cls + '">' + escapeSyncHtml(r.status) + '</td>' +
          '<td>' + escapeSyncHtml(formatFieldChange(r.collectionStatus)) + '</td>' +
          '<td>' + escapeSyncHtml(formatFieldChange(r.scoreChange)) + '</td>' +
          '<td>' + escapeSyncHtml(formatEpisodeProgress(r.episodeProgress)) + '</td>' +
          '<td>' + escapeSyncHtml(r.error || '') + '</td>' +
          '</tr>'
      }).join('')
      var links = operationLinks.length ? '<div class="sync-log-links">\u5b8c\u6574\u65e5\u5fd7: ' + operationLinks.map(function(url, index) {
        return '<a href="' + url + '" target="_blank" rel="noreferrer">#' + (index + 1) + '</a>'
      }).join(' ') + '</div>' : ''
      return '<div class="sync-inline-log"><h4>\u672c\u6b21\u64cd\u4f5c\u65e5\u5fd7</h4>' + links +
        '<table><thead><tr><th>Subject ID</th><th>\u6807\u9898</th><th>\u7ed3\u679c</th><th>\u6536\u85cf\u72b6\u6001</th><th>\u8bc4\u5206</th><th>\u7ae0\u8282\u8fdb\u5ea6</th><th>\u9519\u8bef</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="7">\u6ca1\u6709\u8fd4\u56de\u6761\u76ee</td></tr>') +
        '</tbody></table></div>'
    }

    async function doSyncOp(mode, subjectIds) {
      var dir = document.getElementById('sync-direction').value
      var fromToken = dir === 'A->B' ? syncState.tokenA : syncState.tokenB
      var toToken = dir === 'A->B' ? syncState.tokenB : syncState.tokenA
      var nameA = (syncState.data && syncState.data.userA && syncState.data.userA.name) || 'Account A'
      var nameB = (syncState.data && syncState.data.userB && syncState.data.userB.name) || 'Account B'
      var fromUser = dir === 'A->B' ? nameA : nameB
      var toUser = dir === 'A->B' ? nameB : nameA
      var ids = mode === 'full' ? getSyncableFilteredIds(dir, syncState.filter, syncState.search) : subjectIds
      var expected = ids.length
      var platformA = (resultArea.querySelector('.sync-platform[data-side="A"]') || {}).value || 'bgm'
      var platformB = (resultArea.querySelector('.sync-platform[data-side="B"]') || {}).value || 'bgm'
      var allResults = []
      var operationLinks = []

      if (!ids.length) return alert('\u6ca1\u6709\u53ef\u540c\u6b65\u7684\u6761\u76ee')

      document.getElementById('sync-progress').style.display = ''
      document.getElementById('sync-progress-fill').style.width = '0%'
      document.getElementById('sync-progress-text').textContent = '\u6b63\u5728\u540c\u6b65... \u6a21\u5f0f ' + mode + '\uff0c\u9884\u8ba1 ' + expected + ' \u9879'

      try {
        for (var start = 0; start < ids.length; start += SYNC_BATCH_SIZE) {
          var chunk = ids.slice(start, start + SYNC_BATCH_SIZE)
          var baseline = buildSyncBaseline(dir, chunk)
          var res = await fetch(API + '/api/sync/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tokenA: fromToken, platformA: platformA, from: fromUser, tokenB: toToken, platformB: platformB, to: toUser, mode: 'partial', subject_ids: chunk, baseline: baseline }),
          })
          var operationId = res.headers.get('X-Sync-Operation-Id')
          if (operationId) operationLinks.push('/api/check/' + operationId)
          var batchResults = await res.json().catch(function() { return null })
          if (!res.ok) {
            var errMsg = (batchResults && batchResults.error && batchResults.error.message) || ('HTTP ' + res.status + ' ' + res.statusText)
            document.getElementById('sync-progress-fill').style.width = '0%'
            document.getElementById('sync-progress-text').innerHTML = '<span style="color:#e94560;">\u540c\u6b65\u5931\u8d25: ' + errMsg + '</span>'
            return
          }
          if (!Array.isArray(batchResults)) throw new Error('Invalid response')
          allResults = allResults.concat(batchResults)
          var done = Math.min(start + chunk.length, expected)
          document.getElementById('sync-progress-fill').style.width = Math.round(done / expected * 100) + '%'
          document.getElementById('sync-progress-text').textContent = '\u6b63\u5728\u540c\u6b65... \u6a21\u5f0f ' + mode + '\uff0c' + done + '/' + expected + ' \u9879'
        }
        var results = allResults
        var ok = results.filter(function(r) { return r.status === 'ok' }).length
        var err = results.filter(function(r) { return r.status === 'error' }).length
        document.getElementById('sync-progress-fill').style.width = '100%'
        var msg = '\u540c\u6b65\u5b8c\u6210\uff1a' + ok + ' \u6210\u529f\uff0c' + err + ' \u5931\u8d25'
        msg += '<br><small>\u8bf7\u6c42\u6a21\u5f0f: ' + mode + '\uff1b\u9884\u8ba1: ' + expected + '\uff1b\u540e\u7aef\u8fd4\u56de: ' + results.length + '</small>'
        msg += renderInlineSyncLog(results, operationLinks)
        if (err > 0) {
          var failed = results.filter(function(r) { return r.status === 'error' }).slice(0, 3).map(function(r) { return (r.title || r.externalId) + ': ' + (r.error || 'unknown') }).join('; ')
          msg += '<br><small style="color:#e94560;">\u5931\u8d25\u6761\u76ee: ' + failed + (err > 3 ? ' \u7b49' + err + '\u9879' : '') + '</small>'
        }
        document.getElementById('sync-progress-text').innerHTML = msg
      } catch (e) {
        document.getElementById('sync-progress-fill').style.width = '0%'
        document.getElementById('sync-progress-text').innerHTML = '<span style="color:#e94560;">\u540c\u6b65\u5931\u8d25: ' + (e.message || '\u672a\u77e5\u9519\u8bef') + '</span>'
      }
    }

    return {
      el: view,
      activate: function() {
        if (loaded) return
        loaded = true
        compareBtn.addEventListener('click', async function() {
          var inputA = tok.querySelector('.sync-token-input[data-side="A"]')
          var inputB = tok.querySelector('.sync-token-input[data-side="B"]')
          var selA = tok.querySelector('.sync-platform[data-side="A"]')
          var selB = tok.querySelector('.sync-platform[data-side="B"]')
          var ta = inputA ? inputA.value.trim() : ''
          var tb = inputB ? inputB.value.trim() : ''
          if (!ta && sessionStorage.getItem('sync-tokenA')) ta = sessionStorage.getItem('sync-tokenA')
          if (!tb && sessionStorage.getItem('sync-tokenB')) tb = sessionStorage.getItem('sync-tokenB')
          if (!ta || !tb) return alert('\u8bf7\u586b\u5199\u4e24\u4e2a\u8d26\u53f7\u7684 Access Token')

          syncState.tokenA = ta; syncState.tokenB = tb

          resultArea.innerHTML = '<p class="bgm-status">\u6b63\u5728\u52a0\u8f7d\u53cc\u65b9\u6536\u85cf\u6570\u636e...</p>'
          try {
            var platformA = selA ? selA.value : 'bgm'
            var platformB = selB ? selB.value : 'bgm'
            var res = await fetch(API + '/api/sync/compare', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tokenA: ta, platformA: platformA, tokenB: tb, platformB: platformB }),
            })
            var data = await res.json()
            if (!res.ok) throw new Error(data.error || '\u8bf7\u6c42\u5931\u8d25')

            // Save tokens
            sessionStorage.setItem('sync-tokenA', ta)
            sessionStorage.setItem('sync-tokenB', tb)
            // Update token row display
            var rows = tok.querySelectorAll('.sync-token-row')
            if (rows[0]) { var nrA = buildTokenRow('Account A', 'A'); rows[0].parentNode.replaceChild(nrA, rows[0]) }
            if (rows[1]) { var nrB = buildTokenRow('Account B', 'B'); rows[1].parentNode.replaceChild(nrB, rows[1]) }

            renderCompareResult(data)
          } catch (e) {
            resultArea.innerHTML = '<p class="bgm-error">\u5bf9\u6bd4\u5931\u8d25: ' + (e.message || '\u672a\u77e5\u9519\u8bef') + '</p>'
          }
        })
      },
    }
  }
  function statusLabel(s) {
  var map = { watching: '在看', completed: '看过', plan_to_watch: '想看', on_hold: '搁置', dropped: '抛弃' }
  return map[s] || s || '—'
}
function statusBadgeColor(s) {
  return { watching: '#00a1d6', completed: '#4caf50', plan_to_watch: '#9b59b6', on_hold: '#f39c12', dropped: '#e74c3c' }[s] || '#666'
}

  // ---------------------------------------------------------------
  // 顶层：渲染 tab 切换 + 三个视图
  // ---------------------------------------------------------------
  async function render() {
    var collectionView = buildCollectionView()
    var calendarView = buildCalendarView()
    var syncView = buildSyncView()
    var views = { collection: collectionView, calendar: calendarView, sync: syncView }

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
    container.appendChild(syncView.el)

    function activate(key) {
      var btns = switcher.querySelectorAll('button')
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].dataset.view === key)
      }
      collectionView.el.style.display = key === 'collection' ? '' : 'none'
      calendarView.el.style.display = key === 'calendar' ? '' : 'none'
      syncView.el.style.display = key === 'sync' ? '' : 'none'
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
