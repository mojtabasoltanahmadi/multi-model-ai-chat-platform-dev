import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  plugins: [vue()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  server: {
    // IPv4 loopback binding: works with http://localhost:5200 everywhere.
    host: '127.0.0.1',

    port: 5200,

    proxy: {
      // Avoids CORS issues in development: /api is forwarded to the backend.
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});