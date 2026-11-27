import type { BuildInfo } from '../app/types.ts'
import { formatUtcStamp, shortCommit } from '../app/format.ts'

export function Footer(props: {
  build: BuildInfo | null
  subjects: number | null
  lastUpdated: string | null
  status: 'loading' | 'ok' | 'error'
}) {
  const { build, subjects, lastUpdated, status } = props
  const sha = shortCommit(build?.commitSha)
  const builtAt = formatUtcStamp(build?.builtAt)
  const updated = formatUtcStamp(lastUpdated)
  const buildText = sha ? (builtAt ? `Build ${sha} · ${builtAt}` : `Build ${sha}`) : null

  return (
    <footer class="bgm-footer">
      {buildText ? <span class="bgm-footer-group">{buildText}</span> : null}
      {subjects !== null
        ? (
          <>
            {buildText ? <span class="bgm-footer-sep" aria-hidden="true">|</span> : null}
            <span class="bgm-footer-group">SUBJECTS <strong>{subjects}</strong></span>
          </>
        )
        : null}
      {updated
        ? (
          <>
            <span class="bgm-footer-sep" aria-hidden="true">|</span>
            <span class="bgm-footer-group">LAST UPDATED <strong>{updated}</strong></span>
          </>
        )
        : status === 'error'
          ? (
            <>
              <span class="bgm-footer-sep" aria-hidden="true">|</span>
              <span class="bgm-footer-group bgm-footer-warn" role="status">数据状态不可用</span>
            </>
          )
          : null}
    </footer>
  )
}
