/**
 * Centralized wizard documentation links (#205 UX-003 / UX-007).
 *
 * The Owner has not published the Blog guides yet: every Blog URL is a
 * CONFIGURABLE placeholder (env override) and is omitted entirely when unset —
 * the wizard then falls back to the repository guide plus the verified official
 * provider pages. Replacing a placeholder never requires touching the engine.
 */

export const OFFICIAL_LINKS = Object.freeze({
  /** Cloudflare API Token management (official; the dashboard rejects non-browser clients with 403). */
  cloudflareTokens: 'https://dash.cloudflare.com/profile/api-tokens',
  /** Bangumi Personal Access Token management (official, reachable). */
  bangumiTokens: 'https://next.bgm.tv/demo/access-token',
})

export const REPOSITORY_GUIDE = 'docs/DEPLOYMENT.md'

/** Configurable Blog placeholders — deliberately unset until the Owner publishes them. */
export const DOC_ENV_KEYS = Object.freeze({
  cloudflareSetupGuide: 'AIRINGCAL_DOC_CLOUDFLARE_SETUP_GUIDE_URL',
  bangumiSetupGuide: 'AIRINGCAL_DOC_BANGUMI_SETUP_GUIDE_URL',
  deploymentGuide: 'AIRINGCAL_DOC_DEPLOYMENT_GUIDE_URL',
})

function cleanUrl(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  // Never render a fake/broken placeholder as a live destination.
  if (/example\.(com|org|net)|PLACEHOLDER|<.*>|\{\{.*\}\}/i.test(text)) return null
  try {
    const url = new URL(text)
    return url.protocol === 'https:' ? url.href.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

export function resolveDocumentation(env = process.env) {
  return {
    cloudflareSetupGuide: cleanUrl(env[DOC_ENV_KEYS.cloudflareSetupGuide]),
    bangumiSetupGuide: cleanUrl(env[DOC_ENV_KEYS.bangumiSetupGuide]),
    deploymentGuide: cleanUrl(env[DOC_ENV_KEYS.deploymentGuide]),
    official: OFFICIAL_LINKS,
    repositoryGuide: REPOSITORY_GUIDE,
  }
}

/** Links shown for one credential section (Blog first when configured, then official). */
export function credentialLinks(kind, docs = resolveDocumentation()) {
  if (kind === 'cloudflare') {
    return [
      ...(docs.cloudflareSetupGuide ? [{ label: 'Setup guide', url: docs.cloudflareSetupGuide }] : []),
      { label: 'Cloudflare API Tokens', url: docs.official.cloudflareTokens },
      { label: 'Repository deployment guide', url: docs.repositoryGuide, local: true },
    ]
  }
  if (kind === 'bangumi') {
    return [
      ...(docs.bangumiSetupGuide ? [{ label: 'Setup guide', url: docs.bangumiSetupGuide }] : []),
      { label: 'Bangumi Access Tokens', url: docs.official.bangumiTokens },
      { label: 'Repository deployment guide', url: docs.repositoryGuide, local: true },
    ]
  }
  throw new Error(`Unknown credential kind: ${kind}`)
}

/** Deployment process explainer for the summary screen (Blog when configured). */
export function deploymentGuideLink(docs = resolveDocumentation()) {
  return docs.deploymentGuide
    ? { label: 'How deployment works', url: docs.deploymentGuide }
    : { label: 'How deployment works', url: docs.repositoryGuide, local: true }
}
