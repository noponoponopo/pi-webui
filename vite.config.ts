import { defineConfig } from 'vite';
import { DEFAULT_PORT, readRuntime } from './server/local-runtime';

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/, replacement: 'preact/compat' },
      { find: /^react-dom$/, replacement: 'preact/compat' },
      { find: /^react-dom\/client$/, replacement: 'preact/compat/client' },
      { find: /^react\/jsx-runtime$/, replacement: 'preact/jsx-runtime' },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: 'preact/jsx-dev-runtime',
      },
    ],
  },
  server: {
    proxy: {
      '/api': {
        target:
          readRuntime()?.url ??
          `http://127.0.0.1:${process.env.PI_WEBUI_PORT ?? process.env.PORT ?? DEFAULT_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
