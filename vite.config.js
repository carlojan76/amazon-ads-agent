import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base DEVE combaciare col nome del repo per GitHub Pages:
// il sito è servito su https://carlojan76.github.io/amazon-ads-agent/
export default defineConfig({
  plugins: [react()],
  base: '/amazon-ads-agent/',
})
