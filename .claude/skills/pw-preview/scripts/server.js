// Tiny static file server for public/ — reads every file fresh off disk on
// each request (no caching), so edits to app.js/index.html/styles.css show
// up on the next page load without restarting this server. Serves the SPA's
// static assets only; every /api/* call must be mocked in the Playwright
// script itself via page.route (see fixtures.js + example.js in this skill).
//
// Usage: node server.js [port]   (default port 8901)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 8901;
// Resolve public/ relative to the repo root, wherever this script is invoked
// from — this file lives at .claude/skills/pw-preview/scripts/server.js.
const PUBLIC_DIR = path.join(__dirname, '..', '..', '..', '..', 'public');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

http
  .createServer((req, res) => {
    let reqPath = req.url.split('?')[0];
    if (reqPath === '/') reqPath = '/index.html';
    const filePath = path.join(PUBLIC_DIR, reqPath);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`pw-preview static server listening on ${PORT} (serving ${PUBLIC_DIR})`));
