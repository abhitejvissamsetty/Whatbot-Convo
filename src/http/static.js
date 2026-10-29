import { readFile } from 'node:fs/promises';

const publicDirectory = new URL('../../public/', import.meta.url);
const types = { html: 'text/html; charset=utf-8', js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };

export async function staticResponse(path, method) {
  if (!['GET', 'HEAD'].includes(method)) return null;
  const filename = path === '/' ? 'index.html' : /^\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:js|css)$/.test(path) ? path.slice(1) : null;
  if (!filename) return null;
  try {
    const content = await readFile(new URL(filename, publicDirectory));
    return { status: 200, body: method === 'HEAD' ? '' : content, headers: { 'Content-Type': types[filename.split('.').at(-1)], 'Content-Length': String(content.length) } };
  } catch (error) {
    const missing = error.code === 'ENOENT';
    const message = missing ? 'Frontend asset not found. Restart the application and verify the deployed public files.' : 'Frontend asset could not be read. Check the application file permissions.';
    return { status: missing ? 404 : 503, body: method === 'HEAD' ? '' : message, headers: { 'Content-Type': 'text/plain; charset=utf-8' } };
  }
}
