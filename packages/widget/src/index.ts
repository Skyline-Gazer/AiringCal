import { generatedBuildInfo, generatedWidgetCss, generatedWidgetJs } from './generated-assets.ts'

export const packageBoundary = '@airing-cal/widget'

export const widgetCss = generatedWidgetCss

export const widgetJs = generatedWidgetJs

/** Artifact build time (UTC) and the digest of the exact shipped bytes. */
export const buildInfo = generatedBuildInfo

/**
 * Standalone shell. The app itself renders inside `.bgm-container`; the shell
 * only carries the build stamp for the footer and the two asset URLs that the
 * Embeddable Widget contract has always exposed.
 */
export function renderIndexPage(options: { commitSha?: string } = {}): string {
  const stamp = JSON.stringify({
    commitSha: options.commitSha?.trim() || undefined,
    builtAt: generatedBuildInfo.builtAt,
    contentHash: generatedBuildInfo.contentHash,
  }).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/src/bangumi.css">
  <title>AiringCal</title>
</head>
<body class="bgm-page">
  <div class="bgm-container" data-bgm-standalone="1"></div>
  <script>window.__AIRINGCAL_BUILD__=${stamp}</script>
  <script src="/src/bangumi.js"></script>
</body>
</html>`
}
