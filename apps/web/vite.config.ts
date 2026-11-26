import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { apiAddress, permittedBindHost, readConfig } from '../api/src/config.js';
import { env } from 'node:process';

const host = env.IMGBAE_WEB_HOST?.trim() || '127.0.0.1';
if (!permittedBindHost(host)) {
  throw new Error('IMGBAE_WEB_HOST must be loopback or a specific private IPv4 address (not 0.0.0.0 or a public address).');
}

const api = apiAddress(readConfig());
const apiHost = api.host === '::1' ? '[::1]' : api.host;

export default defineConfig({
  plugins: [react()],
  server: {
    host,
    port: 5173,
    strictPort: true,
    proxy: { '/api': `http://${apiHost}:${api.port}` },
  },
});
