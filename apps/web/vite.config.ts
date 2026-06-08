import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [preact()],
  optimizeDeps: {
    exclude: ['@xmtp/browser-sdk', '@xmtp/wasm-bindings'],
  },
  server: {
    port: 5173,
  },
});
