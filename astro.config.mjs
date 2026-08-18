// @ts-check
import { defineConfig } from 'astro/config';

// Static build - every tool here is 100% client-side (the file you drop never leaves the
// browser), so there is no server and no adapter. The output in `dist/` is plain static
// files; serve it anywhere, including the bundled Docker image.
export default defineConfig({
  site: 'https://getrff.com',
});
