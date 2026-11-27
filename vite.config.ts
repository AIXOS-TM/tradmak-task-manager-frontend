import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/**
 * In `npm run dev`, serves the files in ./api the way Vercel does in production
 * (e.g. api/extract-action-items.ts → POST /api/extract-action-items).
 * Server-only variables like OPENAI_API_KEY are read from .env / .env.local here,
 * and they stay on the server: only VITE_ / NEXT_PUBLIC_ variables reach the browser.
 */
function devApi(): Plugin {
  return {
    name: 'dev-api',
    apply: 'serve',
    configureServer(server) {
      const env = loadEnv(server.config.mode, server.config.root, '')
      for (const [k, v] of Object.entries(env)) process.env[k] ??= v

      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        const match = /^\/api\/([a-z0-9-]+)$/.exec(path)
        if (!match) return next()
        try {
          const mod = (await server.ssrLoadModule(`/api/${match[1]}.ts`)) as Record<string, (r: Request) => Promise<Response>>
          const handler = mod[req.method ?? 'GET']
          if (!handler) {
            res.statusCode = 405
            res.end()
            return
          }
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const headers = new Headers()
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
          const request = new Request(`http://localhost${req.url}`, {
            method: req.method,
            headers,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
          })
          const response = await handler(request)
          res.statusCode = response.status
          response.headers.forEach((v, k) => res.setHeader(k, v))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (err) {
          server.config.logger.error(`[dev-api] ${String(err)}`)
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'The dev API failed. See the terminal.' }))
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), devApi()],
  // Vite only exposes env variables with these prefixes to the browser (via import.meta.env).
  // NEXT_PUBLIC_ is added so the Supabase variables can use that naming. Anything with either
  // prefix ends up in the public JS bundle, so NEVER give a secret (e.g. the service_role key
  // or OPENAI_API_KEY) one.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
})
