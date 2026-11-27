import { defineConfig } from 'vite'

/**
 * Library build: the Embeddable Widget contract is a classic script at
 * `/src/bangumi.js` plus `/src/bangumi.css`, loaded by both the standalone
 * shell and third-party pages. No hashed module output, no index.html.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    lib: {
      entry: 'src/app/main.tsx',
      formats: ['iife'],
      name: 'AiringCal',
      fileName: () => 'bangumi.js',
      cssFileName: 'bangumi',
    },
    rollupOptions: {
      output: { extend: true },
    },
  },
})
