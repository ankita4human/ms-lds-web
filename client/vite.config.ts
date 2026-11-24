import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Set VITE_API_URL (e.g. https://localhost:5001) in .env.local
export default defineConfig({ plugins: [react()] });
