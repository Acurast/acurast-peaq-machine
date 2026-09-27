// Bundles src/index.ts into the single CommonJS file the Acurast Processor runs (Node 24).
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/bundle.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  minify: true,
  // Optional SDK features (S3 delivery, OWS native wallet) that this PoC never loads.
  external: ["@aws-sdk/*", "@open-wallet-standard/core"],
  // The SDK reads import.meta.url at load time, which CJS output lacks.
  define: { "import.meta.url": "__import_meta_url" },
  banner: { js: "const __import_meta_url=require('url').pathToFileURL(__filename).href;" },
  logLevel: "info",
});
