import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { defineConfig, type ProxyOptions } from "vite";

import { snapshotApi } from "./snapshot-api";

const apiOrigin = process.env.SYMPP_API_ORIGIN || "http://127.0.0.1:19998";
const snapshotDashboardPort = 20011;
const operatorProxy: Record<string, string | ProxyOptions> = {
  "/api": localOperatorProxy(),
  "/mcp": apiOrigin,
  "/sympp/board/session": localOperatorProxy(),
  "/sympp/work-packages": localOperatorProxy(),
};

function parseDashboardPort(value: string | undefined, fallback: number) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : fallback;
}

function localOperatorProxy(): ProxyOptions {
  return {
    target: apiOrigin,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq) => {
        proxyReq.setHeader("origin", apiOrigin);
      });
    },
  };
}

function manualChunks(id: string) {
  const normalized = id.replaceAll("\\", "/");
  if (normalized.includes("/node_modules/react/") || normalized.includes("/node_modules/react-dom/")) return "vendor-react";
}

// `vite --mode snapshot` serves the operator API from a captured snapshot instead of a backend.
export default defineConfig(({ mode }) => {
  const snapshot = mode === "snapshot";
  const dashboardPort = parseDashboardPort(process.env.SYMPP_DASHBOARD_PORT, snapshot ? snapshotDashboardPort : 19999);

  return {
    plugins: [...(snapshot ? [snapshotApi()] : []), tailwindcss(), react()],
    server: {
      host: "127.0.0.1",
      port: dashboardPort,
      strictPort: true,
      allowedHosts: ["spp.localhost"],
      proxy: snapshot ? undefined : operatorProxy,
    },
    preview: {
      host: "127.0.0.1",
      port: dashboardPort,
      strictPort: true,
      allowedHosts: ["spp.localhost"],
      proxy: operatorProxy,
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    build: {
      outDir: "../priv/static",
      emptyOutDir: false,
      manifest: true,
      rollupOptions: {
        output: {
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
          manualChunks,
        },
      },
    },
  };
});
