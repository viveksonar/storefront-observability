import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Longest prefixes first — some proxy stacks match the first rule only.
      '/metrics/forecast': { target: backend, changeOrigin: true },
      '/metrics': { target: backend, changeOrigin: true },
      '/forecast': { target: backend, changeOrigin: true },
      '/simulate': { target: backend, changeOrigin: true },
      '/health': { target: backend, changeOrigin: true },
      '/incidents': { target: backend, changeOrigin: true },
    },
  },
})
