/** bgm.tv weekday ids: 1 = Monday … 7 = Sunday. */
export interface WeekdayLabel {
  id: number
  cn: string
  en: string
}

export const WEEKDAYS: WeekdayLabel[] = [
  { id: 1, cn: '星期一', en: 'Mon' },
  { id: 2, cn: '星期二', en: 'Tue' },
  { id: 3, cn: '星期三', en: 'Wed' },
  { id: 4, cn: '星期四', en: 'Thu' },
  { id: 5, cn: '星期五', en: 'Fri' },
  { id: 6, cn: '星期六', en: 'Sat' },
  { id: 7, cn: '星期日', en: 'Sun' },
]

/** Local calendar day mapped to the bgm.tv id (JS getDay: 0 = Sunday). */
export function todayWeekdayId(date: Date = new Date()): number {
  const day = date.getDay()
  return day === 0 ? 7 : day
}

export function weekdayLabel(id: number): WeekdayLabel {
  return WEEKDAYS.find((day) => day.id === id) ?? WEEKDAYS[0]!
}

export function shortWeekdayLabel(label: { cn?: string; en?: string }, id: number): string {
  const cn = label.cn?.trim()
  return cn ? cn.replace('星期', '周') : weekdayLabel(id).en
}

/** Selection survives re-renders; only an unknown day id falls back. */
export function resolveSelectedDay(selected: number | null, available: number[], today: number): number {
  if (selected !== null && available.includes(selected)) return selected
  if (available.includes(today)) return today
  return available[0] ?? today
}
