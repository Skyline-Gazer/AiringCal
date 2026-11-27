import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks'
import type { CalendarDay, CollectionItem, CollectionType, BuildInfo } from './types.ts'
import { COLLECTION_TYPES } from './types.ts'
import { fetchCalendar, fetchCollections, fetchHealth, fetchNsfwEnabled } from './api.ts'
import { pageAfterResize, paginationWindow, totalPages, clampPage } from './pagination.ts'
import { resolveSelectedDay, todayWeekdayId } from './weekday.ts'
import { DEFAULT_BROWSE, isStandalonePage, parseBrowseState, writeBrowseState, type ViewKey } from './url-state.ts'
import { useGridCapacity } from './hooks.ts'
import { confirmAge, isAgeConfirmed, leaveSite, subscribeAgeConfirmation } from './gate.ts'
import { AnimeGrid, calendarCard, collectionCard } from '../components/cards.tsx'
import { TypeTabs, ViewTabs, WeekdayTabs } from '../components/nav.tsx'
import { Pagination, AgeGate, StateNotice } from '../components/feedback.tsx'
import { Footer } from '../components/footer.tsx'

interface GateState {
  status: 'loading' | 'ok' | 'error'
  allowed: boolean
}

type Loaded<T> =
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'error'; message: string }

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function App({ gateHost = true }: { gateHost?: boolean }) {
  const idBase = useId()
  const standalone = useMemo(isStandalonePage, [])
  const initial = useMemo(() => (standalone ? parseBrowseState(location.search) : DEFAULT_BROWSE), [standalone])

  const [view, setView] = useState<ViewKey>(initial.view)
  const [type, setType] = useState<CollectionType>(initial.type)
  const [page, setPage] = useState(initial.page)
  const [day, setDay] = useState<number | null>(initial.day)
  const [gate, setGate] = useState<GateState>({ status: 'loading', allowed: false })
  const [confirmed, setConfirmed] = useState(isAgeConfirmed)
  const [collection, setCollection] = useState<Loaded<{ items: CollectionItem[]; total: number }>>({ status: 'loading' })
  const [calendar, setCalendar] = useState<Loaded<CalendarDay[]> | null>(null)
  const [health, setHealth] = useState<{ subjects: number | null; updated: string | null; status: 'loading' | 'ok' | 'error' }>(
    { subjects: null, updated: null, status: 'loading' },
  )
  const [gridElement, setGridElement] = useState<HTMLDivElement | null>(null)
  const capacity = useGridCapacity(gridElement)
  const previousCapacity = useRef<number | null>(null)
  const lastKnownTotal = useRef<number | null>(null)

  const showNsfw = gate.status === 'ok' && gate.allowed && confirmed
  const capacityValue = capacity ?? 12
  const pages = collection.status === 'ok' ? totalPages(collection.data.total, capacity ?? 1) : 0

  useEffect(() => subscribeAgeConfirmation(() => setConfirmed(isAgeConfirmed())), [])

  useEffect(() => {
    const controller = new AbortController()
    fetchNsfwEnabled(controller.signal)
      .then((allowed) => setGate({ status: 'ok', allowed }))
      .catch((error) => {
        if (isAbort(error)) return
        setGate({ status: 'error', allowed: false })
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetchHealth(controller.signal)
      .then((body) => {
        if (!body.ok || !body.data) throw new Error('health unavailable')
        setHealth({
          subjects: body.data.cache.total_subjects,
          updated: body.data.collections.updated_at,
          status: 'ok',
        })
      })
      .catch((error) => {
        if (isAbort(error)) return
        setHealth({ subjects: null, updated: null, status: 'error' })
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (capacity === null) return
    const previous = previousCapacity.current
    previousCapacity.current = capacity
    if (previous === null || previous === capacity) return
    setPage((current) => {
      const mapped = pageAfterResize(current, previous, capacity)
      const lastPage = lastKnownTotal.current === null ? 0 : totalPages(lastKnownTotal.current, capacity)
      return lastPage > 0 ? clampPage(mapped, lastPage) : mapped
    })
  }, [capacity])

  useEffect(() => {
    if (capacity === null) return
    const controller = new AbortController()
    setCollection({ status: 'loading' })
    fetchCollections({ type, page, limit: capacity, nsfw: showNsfw ? 'show' : 'hide' }, controller.signal)
      .then((body) => {
        lastKnownTotal.current = body.total
        setCollection({ status: 'ok', data: { items: body.data, total: body.total } })
        const lastPage = totalPages(body.total, capacity)
        if (lastPage > 0) setPage((current) => clampPage(current, lastPage))
      })
      .catch((error) => {
        if (isAbort(error)) return
        setCollection({ status: 'error', message: error instanceof Error ? error.message : '未知错误' })
      })
    return () => controller.abort()
  }, [type, page, capacity, showNsfw])


  useEffect(() => {
    if (view !== 'calendar' || calendar !== null) return
    setCalendar({ status: 'loading' })
    const controller = new AbortController()
    fetchCalendar(controller.signal)
      .then((days) => setCalendar({ status: 'ok', data: days }))
      .catch((error) => {
        if (isAbort(error)) return
        setCalendar({ status: 'error', message: error instanceof Error ? error.message : '未知错误' })
      })
    // No abort on view change: the response is cached for the next activation.
  }, [view, calendar])

  const availableDays = calendar?.status === 'ok' ? calendar.data.map((entry) => entry.weekday.id) : []
  const today = useMemo(() => todayWeekdayId(), [])
  const selectedDay = resolveSelectedDay(day, availableDays, today)

  useEffect(() => {
    if (calendar?.status !== 'ok' || day === selectedDay) return
    setDay(selectedDay)
  }, [calendar, day, selectedDay])

  useEffect(() => {
    if (!standalone) return
    const search = writeBrowseState(location.search, { view, type, page, day })
    const next = `${location.pathname}${search ? `?${search}` : ''}${location.hash}`
    history.replaceState(history.state, '', next)
  }, [standalone, view, type, page, day])

  const build = (window.__AIRINGCAL_BUILD__ ?? null) as BuildInfo | null
  const panelLabel = COLLECTION_TYPES.find((entry) => entry.key === type)?.label ?? '番组计划'
  const collectionItems = collection.status === 'ok' ? collection.data.items.map(collectionCard) : []

  return (
    <>
      <h1 class="bgm-visually-hidden">AiringCal 番组计划与放送日历</h1>
      <ViewTabs value={view} onChange={setView} idBase={idBase} />

      {gate.status === 'error'
        ? <StateNotice kind="info">NSFW 配置不可用，已隐藏受限内容</StateNotice>
        : null}

      <section
        id={`bgm-panel-${idBase}-collection`}
        role="tabpanel"
        aria-labelledby={`bgm-tab-${idBase}-collection`}
        hidden={view !== 'collection'}
        class="bgm-view"
      >
        <TypeTabs value={type} onChange={(next) => { setType(next); setPage(1) }} />
        <h2 class="bgm-visually-hidden">{panelLabel}列表</h2>
        {collection.status === 'error'
          ? <StateNotice kind="error">加载失败: {collection.message}<br /><small>API: {location.origin}</small></StateNotice>
          : collection.status === 'ok' && collection.data.total === 0
            ? <StateNotice kind="empty">暂无数据 — 同步可能尚未执行，数据尚未发布，请稍后再试</StateNotice>
            : (
              <>
                <AnimeGrid
                  items={collectionItems}
                  loading={collection.status === 'loading'}
                  capacity={capacityValue}
                  gridRef={setGridElement}
                  label={`${panelLabel}列表`}
                />
                {collection.status === 'ok'
                  ? (
                    <Pagination
                      page={clampPage(page, pages)}
                      pages={pages}
                      windowItems={paginationWindow(page, pages)}
                      onSelect={setPage}
                    />
                  )
                  : null}
              </>
            )}
      </section>

      <section
        id={`bgm-panel-${idBase}-calendar`}
        role="tabpanel"
        aria-labelledby={`bgm-tab-${idBase}-calendar`}
        hidden={view !== 'calendar'}
        class="bgm-view"
      >
        {view !== 'calendar'
          ? null
          : calendar?.status === 'error'
            ? <StateNotice kind="error">日历加载失败: {calendar.message}<br /><small>API: {location.origin}</small></StateNotice>
            : calendar?.status === 'ok' && calendar.data.length === 0
              ? <StateNotice kind="empty">暂无日历数据 — 同步可能尚未执行，数据尚未发布，请稍后再试</StateNotice>
              : (
                <>
                  <WeekdayTabs days={calendar?.status === 'ok' ? calendar.data : []} value={selectedDay} onChange={setDay} idBase={idBase} />
                  <DayPanel
                    days={calendar?.status === 'ok' ? calendar.data : []}
                    selected={selectedDay}
                    loading={calendar === null || calendar.status === 'loading'}
                    capacity={capacityValue}
                    showNsfw={showNsfw}
                    idBase={idBase}
                  />
                </>
              )}
      </section>

      <Footer build={build} subjects={health.subjects} lastUpdated={health.updated} status={health.status} />
      {gateHost
        ? (
          <AgeGate
            open={gate.status === 'ok' && gate.allowed && !confirmed}
            onConfirm={confirmAge}
            onLeave={leaveSite}
          />
        )
        : null}
    </>
  )
}

function DayPanel(props: {
  days: CalendarDay[]
  selected: number
  loading: boolean
  capacity: number
  showNsfw: boolean
  idBase: string
}) {
  const { days, selected, loading, capacity, showNsfw, idBase } = props
  const day = days.find((entry) => entry.weekday.id === selected)
  const items = day ? day.items.filter((item) => showNsfw || !item.nsfw) : []
  const label = day ? `${day.weekday.cn}${day.weekday.en ? ` ${day.weekday.en}` : ''}` : '放送日历'
  return (
    <div
      id={`${idBase}-weekday-panel`}
      role="tabpanel"
      aria-label={label}
      aria-labelledby={`${idBase}-weekday-tab-${selected}`}
      class="bgm-weekday"
    >
      <div class="bgm-weekday-head">
        <h2 class="bgm-weekday-title">{label}</h2>
        <span class="bgm-weekday-count">{loading ? '…' : items.length}</span>
      </div>
      {loading
        ? <AnimeGrid items={[]} loading capacity={capacity} label={`${label}加载中`} />
        : items.length === 0
          ? <StateNotice kind="empty">这一天没有放送条目</StateNotice>
          : <AnimeGrid items={items.map(calendarCard)} loading={false} capacity={capacity} label={`${label}放送列表`} />}
    </div>
  )
}
