import { defineConfig } from "vite";

// Tauri expects a fixed dev server port, and wants the output in ../dist (src-tauri/frontendDist).
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
