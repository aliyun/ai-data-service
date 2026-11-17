import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const gatewayPort = process.env.OPEN_ADA_PORT ?? '8787'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.OPEN_ADA_DEV_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${gatewayPort}`, changeOrigin: false } },
  },
})
