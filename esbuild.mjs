import * as esbuild from 'esbuild'
import { commonifierPlugin } from '@restorecommerce/dev'

await esbuild.build({
  entryPoints: ['./src/start.ts'],
  bundle: true,
  platform: 'node',
  outfile: 'lib/start.cjs',
  minify: true,
  treeShaking: true,
  external: ['@platformatic/wasm-utils'],
  sourcemap: 'linked',
  plugins: [commonifierPlugin],
});

await esbuild.build({
  entryPoints: ['./src/jobs/**/*.ts'],
  bundle: true,
  platform: 'node',
  outdir: 'lib/jobs/',
  minify: true,
  treeShaking: true,
  sourcemap: 'linked',
  external: ['@platformatic/wasm-utils'],
  outExtension: {
    '.js': '.cjs'
  },
  plugins: [commonifierPlugin],
});
