import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    remix({
      ignoredRouteFiles: ["**/.*"],
    }),
    tsconfigPaths(),
  ],
  server: {
    port: Number(process.env.PORT || 3000),
    host: "localhost",
    allowedHosts: [".trycloudflare.com"],
    hmr: {
      protocol: "ws",
      host: "localhost",
    },
  },
});
