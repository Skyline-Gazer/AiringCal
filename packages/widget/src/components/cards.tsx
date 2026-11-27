import { useState } from 'preact/hooks'
import type { CollectionItem, CalendarItem } from '../app/types.ts'
import { subjectFallbackUrl, subjectThumbUrl } from '../app/api.ts'

interface CardModel {
  id: number
  name: string
  images: CollectionItem['images']
  nsfw: boolean
  progress: number
  score: number
  meta: string
}
function progressWidth(item: CollectionItem): number {
  const total = item.total_episodes || item.eps || 0
  return total > 0 ? Math.min(100, Math.max(0, Math.round((item.ep_status / total) * 100))) : 0
}
export function collectionCard(item: CollectionItem): CardModel {
  const total = item.eps || item.total_episodes || 0
  return {
    id: item.subject_id,
    name: item.name_cn || item.name,
    images: item.images,
    nsfw: item.nsfw,
    progress: progressWidth(item),
    score: 0,
    meta: `${item.ep_status}/${total || '??'}`,
  }
}

export function calendarCard(item: CalendarItem): CardModel {
  const total = item.total_episodes || item.eps || 0
  return {
    id: item.id,
    name: item.name_cn || item.name,
    images: item.images,
    nsfw: item.nsfw,
    progress: 0,
    score: item.rating?.score ?? 0,
    meta: total > 0 ? `${total} 话` : '集数待定',
  }
}

function Cover({ model, priority }: { model: CardModel; priority: boolean }) {
  const [source, setSource] = useState(() => subjectThumbUrl(model.images) ?? subjectFallbackUrl(model.images))
  if (!source) return <span class="bgm-image-missing">image pending</span>
  return (
    <img
      class="bgm-cover-img"
      src={source}
      alt={model.name}
      width="300"
      height="400"
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      fetchpriority={priority ? 'high' : undefined}
      onError={() => setSource((current) => {
        const fallback = subjectFallbackUrl(model.images)
        return fallback && fallback !== current ? fallback : null
      })}
    />
  )
}

export function AnimeCard({ model, priority = false }: { model: CardModel; priority?: boolean }) {
  return (
    <a
      class={`bgm-card${model.nsfw ? ' bgm-nsfw' : ''}`}
      href={`https://bgm.tv/subject/${model.id}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      <div class="bgm-card-cover">
        <Cover model={model} priority={priority} />
      </div>
      <div class="bgm-card-info">
        <h3>{model.name}</h3>
        {model.progress > 0 ? (
          <div class="bgm-progress">
            <span style={{ width: `${model.progress}%` }} />
          </div>
        ) : null}
        {model.score > 0 ? <span class="bgm-score">★ {model.score.toFixed(1)}</span> : null}
        <span class="bgm-ep">{model.meta}</span>
      </div>
    </a>
  )
}

export function AnimeGrid(props: {
  items: CardModel[]
  loading: boolean
  capacity: number
  gridRef?: (element: HTMLDivElement | null) => void
  label: string
}) {
  const { items, loading, capacity, gridRef, label } = props
  return (
    <div class="bgm-grid" ref={gridRef} aria-busy={loading} aria-label={label}>
      {loading
        ? Array.from({ length: Math.max(1, capacity) }, (_, index) => (
          <div class="bgm-card bgm-card-skeleton" aria-hidden="true" key={`skeleton-${index}`}>
            <div class="bgm-card-cover" />
            <div class="bgm-card-info"><h3>&nbsp;</h3></div>
          </div>
        ))
        : items.map((model, index) => (
          <AnimeCard key={`${model.id}-${index}`} model={model} priority={index < 2} />
        ))}
    </div>
  )
}
