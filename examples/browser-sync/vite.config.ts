import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import path from 'path'

const shim = (name: string) => path.resolve(__dirname, `src/shims/${name}.ts`)

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'path', 'os', 'events', 'util', 'process'],
    }),
  ],
  resolve: {
    alias: {
      '@stripe/sync-logger/progress': shim('logger-progress'),
      '@stripe/sync-logger': shim('logger'),
      'pg': shim('pg'),
      'ws': shim('ws'),
      'https-proxy-agent': shim('noop'),
      'node:child_process': shim('child_process'),
      'node:net': shim('noop'),
      'node:http': shim('noop'),
    },
  },
  define: {
    'process.platform': '"browser"',
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
