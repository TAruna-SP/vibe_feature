import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { comlink } from "vite-plugin-comlink";

// https://vitejs.dev/config/
export default defineConfig({
  worker: {
    format: 'es',
    plugins: () => [comlink()],
    rollupOptions: {
      output: {
        entryFileNames: 'worker/[name]-[hash].js',
        chunkFileNames: 'worker/[name]-[hash].js',
        assetFileNames: 'worker/[name]-[hash][ext]',
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      // Proxy API requests to local backend to avoid CORS issues.
      // Override at runtime with VITE_API_TARGET (defaults to 3141
      // to match backend's APP_PORT).
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3141',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
});
