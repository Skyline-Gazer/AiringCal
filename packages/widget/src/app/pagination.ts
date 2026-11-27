/** Page capacity is `columns × rows` measured from the rendered grid. */
export function pageCapacity(columns: number, rows: number): number {
  const cols = Math.max(1, Math.trunc(columns) || 1)
  const rowCount = Math.max(1, Math.trunc(rows) || 1)
  return Math.min(100, cols * rowCount)
}

export function totalPages(total: number, capacity: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.ceil(total / Math.max(1, capacity))
}

export function clampPage(page: number, pages: number): number {
  const safePage = Math.max(1, Math.trunc(page) || 1)
  return pages <= 0 ? 1 : Math.min(safePage, pages)
}

/** Keep the first visible item in view when the page capacity changes. */
export function pageAfterResize(page: number, previousCapacity: number, nextCapacity: number): number {
  const firstIndex = (Math.max(1, Math.trunc(page) || 1) - 1) * Math.max(1, previousCapacity)
  return Math.floor(firstIndex / Math.max(1, nextCapacity)) + 1
}

export function paginationWindow(current: number, pages: number): Array<number | '…'> {
  const total = Math.max(0, Math.trunc(pages) || 0)
  if (total <= 0) return []
  const cur = clampPage(current, total)
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)
  if (cur <= 4) return [1, 2, 3, 4, 5, '…', total]
  if (cur >= total - 3) return [1, '…', total - 4, total - 3, total - 2, total - 1, total]
  return [1, '…', cur - 1, cur, cur + 1, '…', total]
}
