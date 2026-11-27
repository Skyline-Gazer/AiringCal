import { useEffect, useRef } from 'preact/hooks'
import type { ComponentChildren } from 'preact'

export function Pagination(props: {
  page: number
  pages: number
  windowItems: Array<number | '…'>
  onSelect: (page: number) => void
}) {
  const { page, pages, windowItems, onSelect } = props
  if (pages <= 1) return null
  return (
    <nav class="bgm-pagination" aria-label="分页">
      <button
        type="button"
        class="bgm-page-btn"
        aria-label="上一页"
        disabled={page <= 1}
        onClick={() => onSelect(page - 1)}
      >
        ‹
      </button>
      {windowItems.map((item, index) => item === '…'
        ? <span class="bgm-pagination-ellipsis" aria-hidden="true" key={`gap-${index}`}>…</span>
        : (
          <button
            type="button"
            class={item === page ? 'bgm-page-btn active' : 'bgm-page-btn'}
            aria-label={`第 ${item} 页`}
            aria-current={item === page ? 'page' : undefined}
            onClick={() => onSelect(item)}
            key={item}
          >
            {item}
          </button>
        ))}
      <button
        type="button"
        class="bgm-page-btn"
        aria-label="下一页"
        disabled={page >= pages}
        onClick={() => onSelect(page + 1)}
      >
        ›
      </button>
    </nav>
  )
}

export function AgeGate(props: {
  open: boolean
  onConfirm: () => void
  onLeave: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (props.open && !element.open) element.showModal()
    if (!props.open && element.open) element.close()
  }, [props.open])
  return (
    <dialog class="bgm-dialog" ref={dialog} aria-labelledby="bgm-age-title">
      <h2 id="bgm-age-title">内容警告</h2>
      <p>本页面包含成人内容（R18），您是否已满 18 岁？</p>
      <div class="bgm-dialog-actions">
        <button type="button" class="bgm-btn bgm-btn-primary" onClick={props.onConfirm}>确认已满 18 岁</button>
        <button type="button" class="bgm-btn" onClick={props.onLeave}>退出</button>
      </div>
    </dialog>
  )
}

export function StateNotice(props: { kind: 'empty' | 'error' | 'info'; children: ComponentChildren }) {
  const role = props.kind === 'error' ? 'alert' : 'status'
  return <p class={`bgm-${props.kind}`} role={role}>{props.children}</p>
}
