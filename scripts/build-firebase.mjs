// Bundles the Firebase sign-in SDK into one self-hosted file, so the inbox doesn't load
// scripts from a third-party CDN. The output is committed; servers don't need to run this.
import { build } from 'esbuild';
await build({
  entryPoints: ['client/firebase-auth.entry.js'],
  outfile: 'public/vendor/firebase-auth.js',
  bundle: true, format: 'esm', minify: true, target: 'es2020',
  legalComments: 'none', logLevel: 'info',
  banner: { js: '/* Firebase JS SDK (Apache-2.0), https://github.com/firebase/firebase-js-sdk */' },
});
