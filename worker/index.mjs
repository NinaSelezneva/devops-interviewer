// Cloudflare Worker: AI-прокси для онлайн-версии на GitHub Pages.
// Секреты LAMA_API, LAMA_URL, LAMA_MODEL передаются из GitHub Actions (см. .github/workflows/worker.yml),
// ALLOW_ORIGIN задаётся в wrangler.toml.
// Маршруты: GET /health, POST /interview (префикс /api/ тоже принимается — как у server/serve.mjs).
import { interview, HttpError } from '../server/interviewer.mjs';

const MAX_BODY = 64 * 1024;
// Лимиты на вызовы LLM: с одного IP и на всех вместе за сутки (защита баланса от перебора с многих IP)
const PER_IP = { limit: 20, window: 60_000 };
const DAILY = { limit: 2000, window: 86_400_000 };

// Счётчик запросов в фиксированном окне. Встроенный Rate Limiting binding Cloudflare приблизительный
// и на практике пропускал любые всплески, а Durable Object — один экземпляр на ключ, поэтому считает точно.
export class Limiter {
  constructor(state) { this.state = state; }

  async fetch(request) {
    const { limit, window } = await request.json();
    const now = Date.now();
    let w = this.w || await this.state.storage.get('w');
    if (!w || now - w.start >= window) w = { start: now, n: 0 };
    w.n++;
    this.w = w;
    await this.state.storage.put('w', w);
    return new Response(null, { status: w.n <= limit ? 204 : 429 });
  }
}

async function allowed(env, key, rule) {
  const stub = env.LIMITER.get(env.LIMITER.idFromName(key));
  const res = await stub.fetch('https://limiter/', { method: 'POST', body: JSON.stringify(rule) });
  return res.status !== 429;
}

function corsHeaders(env, origin) {
  const allowed = (env.ALLOW_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', Vary: 'Origin' };
}

const json = (status, obj, headers) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
});

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/^\/api(?=\/)/, '');
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(env, origin);
    const configured = Boolean(env.LAMA_API && env.LAMA_URL && env.LAMA_MODEL);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (path === '/health' && request.method === 'GET') return json(200, { ok: configured }, cors);
    if (path !== '/interview' || request.method !== 'POST') return json(404, { error: 'Not found' }, cors);

    try {
      // Браузеры с чужих сайтов отсекаем; от curl это не защищает — для этого лимит ниже
      if (origin && !cors['Access-Control-Allow-Origin']) throw new HttpError(403, 'Origin не разрешён');
      if (!configured) throw new HttpError(503, 'На сервере не настроен LLM API');
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!await allowed(env, `ip:${ip}`, PER_IP)) throw new HttpError(429, 'Слишком много запросов, подождите минуту');
      const raw = await request.text();
      if (raw.length > MAX_BODY) throw new HttpError(413, 'Слишком большой запрос');
      let body;
      try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'Некорректный JSON'); }
      // Дневной лимит считаем только для запросов, которые дойдут до LLM
      const day = new Date().toISOString().slice(0, 10);
      if (!await allowed(env, `day:${day}`, DAILY)) throw new HttpError(429, 'Дневной лимит AI-интервьюера исчерпан, попробуйте завтра');
      const result = await interview(body, { apiKey: env.LAMA_API, apiUrl: env.LAMA_URL, model: env.LAMA_MODEL });
      return json(200, result, cors);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      return json(e.status || 500, { error: e instanceof HttpError ? e.message : 'Внутренняя ошибка сервера' }, cors);
    }
  },
};
