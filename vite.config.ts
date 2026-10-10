import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
const env = loadEnv(mode, '.', '');
const proxy = {
  '/sapi/v1/meme': { target: env.MEME_API_UPSTREAM ?? 'http://127.0.0.1:3000', ws: true },
  '/az-auth': { target: env.AZ_AUTH_UPSTREAM ?? 'http://127.0.0.1:4100' },
  '/sapi/v4/fund': { target: env.AZ_FUND_UPSTREAM ?? 'http://127.0.0.1:4100' },
};
return {
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy, allowedHosts: ['dopemac-mini.tailc44fad.ts.net'] },
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
};
});
