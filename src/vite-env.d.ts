/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_REACT_SCAN?: string;
  readonly VITE_QDRANT_ENABLED?: string;
  readonly VITE_QDRANT_URL?: string;
  readonly VITE_QDRANT_API_KEY?: string;
  readonly VITE_QDRANT_COLLECTION?: string;
  readonly VITE_LYRICS_NCM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
