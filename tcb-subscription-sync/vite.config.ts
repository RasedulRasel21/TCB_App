import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig, type PluginOption } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// CORS plugin for handling preflight requests
function corsPlugin(): PluginOption {
  return {
    name: "cors-plugin",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Add CORS headers to all responses
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
        res.setHeader("Access-Control-Max-Age", "86400");

        // Handle OPTIONS preflight requests
        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    corsPlugin(),
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
