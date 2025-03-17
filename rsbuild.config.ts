import { defineConfig } from '@rsbuild/core';
import { RsdoctorRspackPlugin } from '@rsdoctor/rspack-plugin';
import { readdirSync } from 'node:fs';

const jobs: Record<string, string> = {};

readdirSync('./src/jobs').forEach(file => {
  if (file.endsWith('.ts')) {
    jobs['./jobs/' + file.replace(/\.ts$/, '')] = `./src/jobs/${file}`;
  }
});

export default defineConfig({
  mode: 'production',
  tools: {
    rspack(config, { appendPlugins }) {
      if (process.env.RSDOCTOR === 'true') {
        appendPlugins(
          new RsdoctorRspackPlugin({
            supports: {
              banner: true,
              parseBundle: true,
              generateTileGraph: true
            }
          })
        )
      }
    }
  },
  source: {
    entry: {
      './start': './src/start.ts',
      ...jobs
    },
  },
  output: {
    target: "node",
    minify: true,
    sourceMap: {
      js: 'inline-cheap-source-map'
    },
    filename: {
      js: '[name].cjs'
    },
    distPath: {
      root: 'lib'
    },
    legalComments: 'linked'
  },
  performance: {
    chunkSplit: {
      strategy: 'all-in-one'
    },
  }
});
