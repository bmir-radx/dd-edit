import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
// Geist Mono (YAML preview), bundled as local .woff2 — never fetched remotely.
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import './app.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
