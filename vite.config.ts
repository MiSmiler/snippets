import { defineConfig } from "vite";

// Tauri expects a fixed dev server port, and wants the output in ../dist (src-tauri/frontendDist).
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Never watch Rust build artifacts: cargo holds them locked while
    // compiling/running, and fs.watch on a locked file crashes on Windows.
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
