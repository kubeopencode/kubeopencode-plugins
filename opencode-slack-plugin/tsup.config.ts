import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  noExternal: [
    "@slack/web-api",
    "@slack/socket-mode",
    "@slack/types",
    "@slack/logger",
  ],
  external: [
    "ws",
    "http",
    "https",
    "net",
    "tls",
    "crypto",
    "stream",
    "events",
    "url",
    "zlib",
    "bufferutil",
    "utf-8-validate",
  ],
})