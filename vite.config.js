import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: "./", // relative asset paths: works on GitHub Pages regardless of repo name
  server: {
    port: 3000,
    open: true,
  },
})
