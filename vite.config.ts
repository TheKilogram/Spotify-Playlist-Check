import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react(), basicSsl()],
  server: {
    https: true,
    host: 'localhost',
    port: 5173,
  },
});
