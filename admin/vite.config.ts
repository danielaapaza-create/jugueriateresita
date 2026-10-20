import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// VITE_BASE_PATH permite publicar en GitHub Pages (https://usuario.github.io/repositorio/).
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH ?? "/",
});
