import { useEffect, useState } from 'preact/hooks'
import { pageCapacity } from './pagination.ts'

/**
 * Capacity = CSS grid columns × rows. Columns are derived from the same
 * custom properties the grid uses, so JS and layout cannot disagree.
 * Pass the mounted grid element: it re-measures when the node attaches.
 */
export function useGridCapacity(element: HTMLElement | null): number | null {
  const [capacity, setCapacity] = useState<number | null>(null)

  useEffect(() => {
    if (!element) return
    let frame = 0
    const measure = () => {
      const style = getComputedStyle(element)
      const minWidth = Number.parseFloat(style.getPropertyValue('--nb-grid-min')) || 140
      const gap = Number.parseFloat(style.getPropertyValue('--nb-grid-gap')) || 18
      const rows = Number.parseInt(style.getPropertyValue('--nb-rows-per-page'), 10) || 2
      if (element.clientWidth === 0) return
      const columns = Math.max(1, Math.floor((element.clientWidth + gap) / (minWidth + gap)))
      const next = pageCapacity(columns, rows)
      setCapacity((current) => (current === next ? current : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [element])

  return capacity
}
