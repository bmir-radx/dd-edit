import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// Uses electron-vite's conventional entry points:
//   main:     src/main/index.ts
//   preload:  src/preload/index.ts
//   renderer: src/renderer/index.html
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
  },
})
