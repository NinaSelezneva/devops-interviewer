#!/usr/bin/env node
// Локальный сервер без зависимостей: раздаёт web/ и проксирует AI-интервьюера в LLM API.
// Настройки LLM берутся из переменных окружения или файла .env (он в .gitignore) и в браузер не попадают.
// Значений по умолчанию нет намеренно: провайдер и модель задаются только секретами.
//   LAMA_API      — ключ API
//   LAMA_URL      — базовый URL OpenAI-совместимого API (…/v1)
//   LAMA_MODEL    — модель
//   PORT          — порт, по умолчанию 8080
//   ALLOW_ORIGIN  — origin фронтенда, если он размещён отдельно (например, GitHub Pages)
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interview, QUESTIONS, HttpError } from './interviewer.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'web');

// Минимальный парсер .env: KEY=value, комментарии через #. Переменные окружения важнее файла.
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trimStart().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const config = {
  apiKey: process.env.LAMA_API,
  apiUrl: process.env.LAMA_URL,
  model: process.env.LAMA_MODEL,
};
const port = Number(process.env.PORT) || 8080;
const allowOrigin = process.env.ALLOW_ORIGIN || '';
const missing = ['LAMA_API', 'LAMA_URL', 'LAMA_MODEL'].filter((k) => !process.env[k]);
const configured = !missing.length;
if (!configured) console.warn(`⚠ Не заданы ${missing.join(', ')}: AI-интервьюер будет отвечать ошибкой. Создайте .env по образцу .env.example`);

// Простой лимит запросов на IP, чтобы публичный прокси не превратился в бесплатный доступ к LLM
const WINDOW = 10 * 60_000;
const MAX_PER_WINDOW = 60;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > WINDOW) { hits.set(ip, { start: now, n: 1 }); return false; }
  return ++h.n > MAX_PER_WINDOW;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function readBody(req, max = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new HttpError(413, 'Слишком большой запрос');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Некорректный JSON'); }
}

async function handleApi(req, res, path) {
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (path === '/api/health' && req.method === 'GET') { sendJson(res, 200, { ok: configured }); return; }
  if (path !== '/api/interview' || req.method !== 'POST') { sendJson(res, 404, { error: 'Not found' }); return; }
  try {
    if (!configured) throw new HttpError(503, 'На сервере не настроен LLM API');
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (rateLimited(ip)) throw new HttpError(429, 'Слишком много запросов, подождите несколько минут');
    sendJson(res, 200, await interview(await readBody(req), config));
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    sendJson(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Внутренняя ошибка сервера' });
  }
}

function serveStatic(res, path) {
  let file;
  try { file = normalize(join(webDir, decodeURIComponent(path === '/' ? '/index.html' : path))); } catch { file = ''; }
  if (!file.startsWith(webDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) handleApi(req, res, path);
  else serveStatic(res, path);
}).listen(port, () => {
  console.log(`DevOps Interviewer: http://localhost:${port}  (AI: ${configured ? 'настроен' : 'не настроен'}, вопросов: ${QUESTIONS.size})`);
});
