import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
      const fs = require('fs');
      const path = require('path');
      fs.writeFileSync(
        path.resolve(__dirname, 'dist/version.json'),
        JSON.stringify(version)
      );
    }
  };
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), versionPlugin()],
  base: './',
})
