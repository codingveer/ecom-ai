import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/agents': { target: 'http://localhost:8100', ws: true },
      '/session': 'http://localhost:8100',
    },
  },
  build: {
    outDir: '../app/public',
    emptyOutDir: false,
  },
});
