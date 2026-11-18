/**
 * Where the local layer finds its binary assets.
 *
 * The built game is served from one directory with `models/` next to `index.html`, possibly under a
 * path prefix, so the game page resolves models relative to itself. The Vite dev server serves the
 * public directory at the root for every page, including the development pages under `/dev/`,
 * where a document-relative URL would miss and be answered with the HTML fallback page.
 */
const ROOT = import.meta.env.DEV ? '/' : './';

/** URL of `models/<key>.glb`. */
export const modelUrl = (key: string): string => `${ROOT}models/${key}.glb`;
