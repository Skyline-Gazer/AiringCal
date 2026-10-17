import { createServer } from 'node:http'
import { FilesystemPublicStore } from '@airing-cal/v3-core'
import { handlePortableReadRequest } from './portable-read-handler.ts'

async function writeNodeResponse(res: import('node:http').ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  res.writeHead(response.status, headers)
  if (response.body) {
    res.end(Buffer.from(await response.arrayBuffer()))
  } else {
    res.end()
  }
}

function readPublicDir(): string {
  const dir = process.env.AIRINGCAL_PUBLIC_READ_DIR?.trim()
    || process.env.AIRINGCAL_BUILDER_PUBLIC_DIR?.trim()
  if (!dir) {
    throw new Error('AIRINGCAL_PUBLIC_READ_DIR or AIRINGCAL_BUILDER_PUBLIC_DIR is required')
  }
  return dir
}

export function startPortableReadServer(options: {
  publicDir?: string
  port?: number
  nsfwShow?: boolean
  packageVersion?: string
} = {}) {
  const publicDir = options.publicDir ?? readPublicDir()
  const port = options.port ?? Number(process.env.PORT ?? 8787)
  const publicStore = new FilesystemPublicStore(publicDir)
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '127.0.0.1'
      const url = new URL(req.url ?? '/', `http://${host}`)
      const response = await handlePortableReadRequest(new Request(url.toString(), { method: req.method ?? 'GET' }), {
        publicStore,
        nsfwShow: options.nsfwShow ?? process.env.NSFW_SHOW !== 'false',
        packageVersion: options.packageVersion ?? process.env.npm_package_version,
      })
      await writeNodeResponse(res, response)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal_error'
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message } }))
    }
  })
  server.listen(port)
  return { server, publicDir, port }
}

if (process.argv[1]?.endsWith('serve-node.ts')) {
  const { port, publicDir } = startPortableReadServer()
  console.log(JSON.stringify({ status: 'info', stage: 'portable_read_listen', port, publicDir }))
}
