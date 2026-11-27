import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Two ways to reach the API:
//  1) set VITE_API_URL (e.g. http://localhost:5080) in .env.local: the browser calls the API directly (CORS must allow this site), or
//  2) leave it unset: requests to /api are forwarded to the API below, so the browser only talks to this dev server (no CORS needed).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': { target: process.env.API_PROXY ?? 'http://localhost:5080', changeOrigin: true } } },
});
