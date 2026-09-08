import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Deliberately separate from electron-vite: no main process, preload or native services.
export default defineConfig(({ command }) => {
  if (command !== 'serve') throw new Error('Web Mode is a local development preview; use npm run dev:web.')
  return {
    root: resolve('src/renderer/web'),
    cacheDir: resolve('node_modules/.vite-web'),
    envDir: false,
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
      fs: { allow: [resolve('src/renderer'), resolve('src/shared'), resolve('node_modules')] }
    }
  }
})
