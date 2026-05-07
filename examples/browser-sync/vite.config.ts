import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import path from 'path'

const shim = (name: string) => path.resolve(__dirname, `src/shims/${name}.ts`)

// Custom plugin to resolve node: imports that the polyfills plugin misses
// (linked workspace dist/ files served via /@fs/ bypass the default polyfill resolution)
function nodeShimPlugin(): Plugin {
  const nodeShims: Record<string, string> = {
    'node:child_process': shim('child_process'),
    'node:fs': shim('node-builtins'),
    'node:fs/promises': shim('node-builtins'),
    'node:net': shim('noop'),
    'node:http': shim('noop'),
    'node:url': shim('url'),
  }

  return {
    name: 'node-shim-resolver',
    enforce: 'pre',
    resolveId(source) {
      if (nodeShims[source]) return nodeShims[source]
      return null
    },
  }
}

export default defineConfig({
  plugins: [
    nodeShimPlugin(),
    react(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'path', 'os', 'events', 'util', 'process'],
      globals: { process: true, Buffer: true, global: true },
    }),
  ],
  resolve: {
    alias: {
      '@stripe/sync-logger/progress': shim('logger-progress'),
      '@stripe/sync-logger': shim('logger'),
      'pg': shim('pg'),
      'ws': shim('ws'),
      'https-proxy-agent': shim('noop'),
    },
  },
  define: {
    'process.platform': '"browser"',
    'process.env.NODE_DEBUG': '""',
    'process.env.NODE_ENV': '"development"',
  },
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    exclude: ['@electric-sql/pglite'],
    esbuildOptions: {
      target: 'esnext',
    },
  },
  server: {
    proxy: {
      '/stripe-api': {
        target: 'https://api.stripe.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/stripe-api/, ''),
      },
    },
  },
})
