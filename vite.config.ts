import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    css: true,
    env: {
      VITE_MEME_API_BASE_URL: 'http://127.0.0.1:3000',
      VITE_MEME_WS_URL: 'ws://127.0.0.1:3000/sapi/v1/meme/stream',
      VITE_AZ_API_BASE_URL: 'http://127.0.0.1:4100',
    },
  },
});
