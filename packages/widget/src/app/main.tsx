import { render } from 'preact'
import { App } from './app.tsx'
import './styles.css'

/**
 * Embeddable entry: mounts into every `.bgm-container` on the page, including
 * the standalone shell. Re-executing the script must not double-mount.
 * Only the first instance owns the age dialog; consent is page-global.
 */
const containers = Array.from(document.querySelectorAll<HTMLElement>('.bgm-container'))
containers.forEach((container, index) => {
  if (container.dataset.bgmMounted === '1') return
  container.dataset.bgmMounted = '1'
  render(<App gateHost={index === 0} />, container)
})
