// Local preview of the built page, wrapped the way the artifact viewer wraps it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 5199;
const page = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'jacks.html');

createServer(async (_request, response) => {
  try {
    const html = await readFile(page, 'utf8');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(
      '<!doctype html><html lang="en-GB"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
        '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}' +
        'body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style>' +
        `</head><body>${html}</body></html>`,
    );
  } catch {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('Run "npm run build" first.');
  }
}).listen(PORT, () => console.log(`Jacks preview on http://localhost:${PORT}`));
