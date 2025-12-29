import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'
import path from 'path'

import * as babel from '@babel/core'

import legacy from '@vitejs/plugin-legacy'

// Custom plugin to force transpile react-refresh for older browsers
const forceTranspile = () => {
  return {
    name: 'force-transpile',
    enforce: 'post',
    transform(code, id) {
      if (id.includes('react-refresh') || id.includes('vite/dist/client') || id.includes('vite/client')) {
        const result = babel.transformSync(code, {
          presets: [['@babel/preset-env', { targets: { chrome: '79' }, modules: false }]],
          filename: id,
          sourceMaps: true,
        })
        return {
          code: result.code,
          map: result.map,
        }
      }
    },
  }
}

// Custom plugin to generate version.json
const versionPlugin = () => {
  const version = { timestamp: Date.now() };
  return {
    name: 'version-plugin',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/version.json') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(version));
        } else {
          next();
        }
      });
    },
    writeBundle() {
      fs.writeFileSync(
        path.join(process.cwd(), 'dist/version.json'),
        JSON.stringify(version)
      );
    }
  };
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    forceTranspile(),
    react({
      babel: {
        presets: [['@babel/preset-env', { targets: { chrome: '79' }, modules: false }]],
      },
    }),
    tailwindcss(),
    versionPlugin(),
    legacy({
      targets: ['chrome >= 79'],
    }),
  ],
  base: './',
  esbuild: {
    target: 'es2015',
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2015',
    },
  },
  build: {
    target: 'chrome79',
  },
})
