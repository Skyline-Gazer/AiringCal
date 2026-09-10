import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function stage(source, name) {
  const match = source.match(new RegExp(`FROM [^\\n]+ AS ${name}\\n([\\s\\S]*?)(?=\\nFROM |$)`))
  assert.ok(match, `IMAGE_STAGE_MISSING:${name}`)
  return match[1]
}

export function verifyVpsSyncImage(directory = root) {
  const dockerfile = readFileSync(`${directory}/Dockerfile.vps-sync`, 'utf8')
  const ignored = readFileSync(`${directory}/.dockerignore`, 'utf8')
  const build = stage(dockerfile, 'build')
  const productionDependencies = stage(dockerfile, 'production-dependencies')
  const production = stage(dockerfile, 'production')
  const debug = stage(dockerfile, 'debug')

  assert.match(dockerfile, /^FROM node:alpine AS deps$/m)
  assert.match(build, /pnpm -F @airing-cal\/vps-sync build/)
  assert.match(productionDependencies, /npm install --omit=dev --ignore-scripts --no-package-lock @aws-sdk\/client-s3@3\.1124\.0 @sentry\/node@10\.73\.0 pg@8\.23\.0/)
  assert.match(production, /apk add --no-cache ca-certificates postgresql18-client/)
  assert.match(production, /COPY --from=build \/workspace\/apps\/vps-sync\/dist \.\/dist/)
  assert.match(production, /COPY --from=production-dependencies \/app\/node_modules \.\/node_modules/)
  assert.match(production, /^USER node$/m)
  assert.match(production, /^CMD \["node", "dist\/runtime\.js"\]$/m)
  assert.doesNotMatch(production, /\b(?:curl|git|jq|python|bind-tools|netcat|procps|make|g\+\+)\b/)
  assert.doesNotMatch(production, /\b(?:src|test)\b/)
  assert.doesNotMatch(production, /^EXPOSE\b/m)
  assert.match(debug, /^USER root$/m)
  assert.match(debug, /apk add --no-cache curl bind-tools netcat-openbsd procps-ng jq/)
  assert.match(debug, /^USER node$/m)
  for (const pattern of ['.git', 'node_modules', 'dist', '.env']) assert.match(ignored, new RegExp(`^${pattern.replace('.', '\\.')}`, 'm'))

  return { production: 'verified', debug: 'verified' }
}
