/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLOUDFLARE_API_BASE_URL?: string;
  readonly VITE_PUBLIC_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected from package.json by vite.config.ts and vitest.config.ts. */
declare const __APP_VERSION__: string;
