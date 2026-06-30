(function () {
  const config = window.bgmConfig || { apiUrl: '', quote: '' }
  const API = (config.apiUrl || window.location.origin).replace(/\/$/, '')
  const container = document.querySelector('.bgm-container')
  if (!container) return

  const TYPE_NAMES = { want: '想看', watched: '看过', watching: '在看', on_hold: '搁置', dropped: '抛弃' }

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
      if (data.nsfw && !localStorage.getItem('bgm-age-confirmed')) {
        document.getElementById('bgm-age-modal').style.display = 'block'
      } else if (!data.nsfw) {
        localStorage.removeItem('bgm-age-confirmed')
      }
    } catch (e) {}
  }

  window.bgmConfirmAge = function () {
    localStorage.setItem('bgm-age-confirmed', '1')
    document.getElementById('bgm-age-modal').style.display = 'none'
  }

  window.bgmLeaveAge = function () {
    window.location.href = 'https://www.google.com'
  }

  // ---------------------------------------------------------------
  const COVER_PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" fill="#333"><rect width="300" height="400"/></svg>')

  function subjectImageUrl(images) {
    return images?.common?.uri
      ? API + images.common.uri
      : COVER_PLACEHOLDER
  }

  // 收藏卡片：用 images.common.uri 走 worker 图片代理 + 观看进度
  // ---------------------------------------------------------------
  function renderCard(entry) {
    const imgUrl = subjectImageUrl(entry.images)

    const progress = entry.total_episodes > 0
      ? Math.round((entry.ep_status / entry.total_episodes) * 100)
      : 0

    var html = '<a href="https://bgm.tv/subject/' + entry.subject_id + '" target="_blank" class="bgm-card';
    if (entry.nsfw) html += ' bgm-nsfw';
    html += '">' +
      '<div class="bgm-card-cover">' +
        '<img src="' + imgUrl + '" alt="' + (entry.name_cn || entry.name) + '" loading="lazy">';
    if (entry.nsfw) html += '<div class="bgm-nsfw-overlay" onclick="event.preventDefault();this.parentElement.parentElement.classList.toggle(\'bgm-nsfw-reveal\')">R18</div>';
    html += '</div>' +
      '<div class="bgm-card-info">' +
        '<h3>' + (entry.name_cn || entry.name) + '</h3>';
    if (progress > 0) html += '<div class="bgm-progress"><span style="width:' + progress + '%"></span></div>';
    html += '<span class="bgm-ep">' + entry.ep_status + '/' + (entry.total_episodes || '??') + '</span>' +
      '</div>' +
    '</a>';
    return html;
  }

  // ---------------------------------------------------------------
  // 放送日历卡片（新增）：items 是 BgmSlimSubject
  // 字段与收藏不同：用 id、images.common（bgm.tv 原图）、rating.score
  // ---------------------------------------------------------------
  function renderCalendarCard(entry) {
    const imgUrl = subjectImageUrl(entry.images)
    const name = entry.name_cn || entry.name || ''
    const score = entry.rating && entry.rating.score

    var html = '<a href="https://bgm.tv/subject/' + entry.id + '" target="_blank" class="bgm-card';
    if (entry.nsfw) html += ' bgm-nsfw';
    html += '">' +
      '<div class="bgm-card-cover">' +
        '<img src="' + imgUrl + '" alt="' + name + '" loading="lazy" referrerpolicy="no-referrer">';
    if (entry.nsfw) html += '<div class="bgm-nsfw-overlay" onclick="event.preventDefault();this.parentElement.parentElement.classList.toggle(\'bgm-nsfw-reveal\')">R18</div>';
    html += '</div>' +
      '<div class="bgm-card-info">' +
        '<h3>' + name + '</h3>';
    if (score) html += '<span class="bgm-score">★ ' + Number(score).toFixed(1) + '</span>';
    html += '<span class="bgm-ep">' + (entry.total_episodes || entry.eps || '??') + ' 话</span>' +
      '</div>' +
    '</a>';
    return html;
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
          grid.innerHTML = '<p class="bgm-empty">暂无数据 — 同步可能尚未执行，请等待 sync-worker 定时同步完成</p>'
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
            var hint = '请等待 sync-worker 定时同步完成'
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
        cal.innerHTML = '<p class="bgm-empty">暂无日历数据 — 同步可能尚未执行，请等待 sync-worker 定时同步完成</p>'
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
  // 顶层：渲染 tab 切换 + 两个视图
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
