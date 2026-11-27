#!/usr/bin/env node
/**
 * E2E fixture server for the frontend acceptance suite.
 *
 * Seeds a deterministic public store, boots the portable read gateway on 8790,
 * and serves a second-origin host page on 8791 that embeds the widget twice.
 * No credentials, no network, no remote deployment.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_PORT = Number(process.env.E2E_APP_PORT ?? 8790)
const HOST_PORT = Number(process.env.E2E_HOST_PORT ?? 8791)
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`
const HOST_ORIGIN = `http://127.0.0.1:${HOST_PORT}`
const publicDir = mkdtempSync(join(tmpdir(), 'airingcal-frontend-e2e-'))

function gitShortSha() {
  const fromEnv = process.env.BANGUMI_GIT_COMMIT_SHA?.trim()
  if (fromEnv) return fromEnv.slice(0, 7)
  const out = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
  return out.status === 0 ? out.stdout.trim() : 'dev'
}

const hostHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Third-party host</title>
  <link rel="stylesheet" href="${APP_ORIGIN}/src/bangumi.css">
  <style>
    body { background: #ffffff; color: #333333; font-family: Georgia, serif; margin: 24px; }
    h1 { font-size: 22px; color: #c00000; }
    .host-between { padding: 12px 0; border-top: 1px solid #ccc; }
  </style>
</head>
<body>
  <h1 class="host-note">A third-party blog</h1>
  <div class="bgm-container"></div>
  <p class="host-between">Host content between two widget instances.</p>
  <div class="bgm-container"></div>
  <script>window.bgmConfig = { apiUrl: '${APP_ORIGIN}' }</script>
  <script src="${APP_ORIGIN}/src/bangumi.js"></script>
</body>
</html>`

const seed = spawnSync(
  'pnpm',
  ['exec', 'tsx', 'packages/v3-read/scripts/seed-frontend-fixture.ts', publicDir],
  { encoding: 'utf8' },
)
if (seed.status !== 0) {
  console.error(seed.stderr || seed.stdout)
  process.exit(1)
}

const app = spawn('pnpm', ['exec', 'tsx', 'packages/v3-read/src/serve-node.ts'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    AIRINGCAL_PUBLIC_READ_DIR: publicDir,
    AIRINGCAL_CORS_ORIGINS: HOST_ORIGIN,
    BANGUMI_GIT_COMMIT_SHA: gitShortSha(),
    PORT: String(APP_PORT),
    NSFW_SHOW: 'true',
  },
})

const host = createServer((request, response) => {
  if (request.url === '/favicon.ico') {
    response.writeHead(204).end()
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(hostHtml)
})
host.listen(HOST_PORT, '127.0.0.1')

let stopping = false
function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  app.kill('SIGTERM')
  host.close()
  try {
    rmSync(publicDir, { recursive: true, force: true })
  } catch {
    // best effort
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
app.on('exit', (code) => {
  if (!stopping) shutdown(code ?? 1)
})
