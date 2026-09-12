// TEMPORARY component-test config. Removed at the end of this pass.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  root: process.cwd(),
  // file:// needs relative asset paths — an absolute /assets/… resolves
  // to the filesystem root and the module silently never loads.
  base: './',
  plugins: [react()],
  build: {
    outDir: 'out/harness',
    emptyOutDir: true,
    rollupOptions: { input: 'harness/index.html' }
  }
})
