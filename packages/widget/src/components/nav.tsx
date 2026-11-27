import { COLLECTION_TYPES, type CollectionType } from '../app/types.ts'
import type { ViewKey } from '../app/url-state.ts'
import { shortWeekdayLabel } from '../app/weekday.ts'

const VIEWS: { key: ViewKey; label: string }[] = [
  { key: 'collection', label: '番组计划' },
  { key: 'calendar', label: '放送日历' },
]

export function ViewTabs({ value, onChange }: { value: ViewKey; onChange: (view: ViewKey) => void }) {
  return (
    <div class="bgm-view-switch" role="tablist" aria-label="视图">
      {VIEWS.map((view) => (
        <button
          type="button"
          role="tab"
          id={`bgm-tab-${view.key}`}
          aria-selected={value === view.key}
          aria-controls={`bgm-panel-${view.key}`}
          class={value === view.key ? 'bgm-tab active' : 'bgm-tab'}
          onClick={() => onChange(view.key)}
        >
          {view.label}
        </button>
      ))}
    </div>
  )
}

export function TypeTabs({ value, onChange }: { value: CollectionType; onChange: (type: CollectionType) => void }) {
  return (
    <div class="bgm-nav" role="group" aria-label="收藏分类">
      {COLLECTION_TYPES.map((entry) => (
        <button
          type="button"
          class={entry.key === value ? 'bgm-type active' : 'bgm-type'}
          aria-pressed={entry.key === value}
          onClick={() => onChange(entry.key)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  )
}

function weekdayButtonId(id: number): string {
  return `bgm-weekday-tab-${id}`
}

export function WeekdayTabs(props: {
  days: Array<{ weekday: { id: number; cn: string; en: string } }>
  value: number
  onChange: (id: number) => void
}) {
  const { days, value, onChange } = props
  const move = (event: KeyboardEvent, direction: 1 | -1 | 'home' | 'end') => {
    event.preventDefault()
    const ids = days.map((day) => day.weekday.id)
    const index = Math.max(0, ids.indexOf(value))
    const nextId = direction === 'home'
      ? ids[0]
      : direction === 'end'
        ? ids[ids.length - 1]
        : ids[(index + direction + ids.length) % ids.length]
    if (nextId === undefined) return
    onChange(nextId)
    requestAnimationFrame(() => document.getElementById(weekdayButtonId(nextId))?.focus())
  }
  return (
    <div class="bgm-weekday-nav" role="tablist" aria-label="按星期切换">
      {days.map((day) => {
        const selected = day.weekday.id === value
        return (
          <button
            type="button"
            role="tab"
            id={weekdayButtonId(day.weekday.id)}
            aria-selected={selected}
            aria-controls="bgm-weekday-panel"
            tabIndex={selected ? 0 : -1}
            class={selected ? 'bgm-weekday-tab active' : 'bgm-weekday-tab'}
            onClick={() => onChange(day.weekday.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') move(event, 1)
              else if (event.key === 'ArrowLeft') move(event, -1)
              else if (event.key === 'Home') move(event, 'home')
              else if (event.key === 'End') move(event, 'end')
            }}
          >
            {shortWeekdayLabel(day.weekday, day.weekday.id)}
          </button>
        )
      })}
    </div>
  )
}
