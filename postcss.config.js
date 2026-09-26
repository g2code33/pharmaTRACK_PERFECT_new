/**
 * Tailwind v4 runs through the `@tailwindcss/vite` plugin (see vite.config.ts),
 * so this project needs NO postcss plugins — this file exists purely to STOP
 * postcss's upward directory search here, at the project root.
 *
 * Without it, postcss-load-config keeps walking up the filesystem in search of
 * a config and can pick up a stray `postcss.config.js` from a parent folder
 * (e.g. an old Tailwind v3 setup left in the user's home directory). That old
 * v3 plugin then chokes on Tailwind v4 syntax with:
 *   `@layer base` is used but no matching `@tailwind base` directive is present.
 *
 * Removing this file would re-expose the project to that failure mode.
 */
export default {
  plugins: [],
};
