import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@stripe/sync-logger/progress': path.resolve(__dirname, 'src/shims/logger-progress.ts'),
      '@stripe/sync-logger': path.resolve(__dirname, 'src/shims/logger.ts'),
      'pg': path.resolve(__dirname, 'src/shims/pg.ts'),
      'ws': path.resolve(__dirname, 'src/shims/ws.ts'),
      'https-proxy-agent': path.resolve(__dirname, 'src/shims/noop.ts'),
    },
  },
  define: {
    'process.env': '{}',
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
