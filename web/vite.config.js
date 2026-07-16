import { defineConfig } from "vite";

export default defineConfig({
  base: "/Cookie-Tray/",
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["replicad", "replicad-opencascadejs"],
  },
});
