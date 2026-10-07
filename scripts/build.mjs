#!/usr/bin/env node
// Собирает content/*.md (вопросы) и theory/*.md (подробная теория) в web/data.js (window.DATA),
// валидирует метаданные и ссылки вопросов на главы теории.
// Без внешних зависимостей: свой минимальный Markdown-рендерер.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = join(root, 'content');
const theoryDir = join(root, 'theory');
const outFile = join(root, 'web', 'data.js');

const LEVELS = ['middle', 'senior', 'lead'];
const TYPES = ['theory', 'practice', 'scenario', 'design', 'behavioral'];

// ---------- Markdown ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[([^\]]+)\]\((#\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
}

function renderList(lines) {
  // lines: [{indent, ordered, text}] -> вложенные списки по отступу
  let html = '';
  const stack = [];
  for (const it of lines) {
    while (stack.length && it.indent < stack.at(-1).indent) {
      html += `</li></${stack.pop().tag}>`;
    }
    const top = stack.at(-1);
    if (!top || it.indent > top.indent) {
      const tag = it.ordered ? 'ol' : 'ul';
      stack.push({ indent: it.indent, tag });
      // нумерованный список, прерванный блоком кода, продолжает нумерацию
      const start = it.ordered && it.num > 1 ? ` start="${it.num}"` : '';
      html += `<${tag}${start}><li>`;
    } else {
      html += '</li><li>';
    }
    html += inline(it.text);
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

export function md(src) {
  const lines = src.replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  const listRe = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^(\s*)```(\w*)/);
    if (fence) {
      const buf = [];
      const indent = fence[1].length;
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++].slice(Math.min(indent, lines[i - 1].search(/\S|$/))));
      i++;
      out.push(`<pre><code class="lang-${fence[2] || 'text'}">${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const n = Math.min(h[1].length + 2, 6); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r, idx) => !(idx === 1 && /^[|\s:-]+$/.test(r)));
      const [head, ...rest] = body;
      out.push('<div class="table-wrap"><table><thead><tr>' + cells(head).map((c) => `<th>${inline(c)}</th>`).join('') +
        '</tr></thead><tbody>' + rest.map((r) => '<tr>' + cells(r).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>');
      continue;
    }
    if (line.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<div class="callout">${md(buf.join('\n'))}</div>`);
      continue;
    }
    if (listRe.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(listRe);
        if (m) { items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), num: parseInt(m[2], 10), text: m[3] }); i++; continue; }
        if (/^\s*```/.test(lines[i])) break;   // блок кода внутри пункта списка
        // продолжение пункта на следующей строке с отступом
        if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items.at(-1).text += ' ' + lines[i].trim(); i++; continue; }
        break;
      }
      out.push(renderList(items));
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\||>)/.test(lines[i]) && !listRe.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

// ---------- Парсинг тем ----------
function hash(s) {
  let h = 5381;
  for (const ch of s) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return h.toString(36);
}

function frontMatter(file, raw) {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) throw new Error(`${file}: нет front matter`);
  const meta = Object.fromEntries(fm[1].split('\n').map((l) => {
    const k = l.indexOf(':');
    return [l.slice(0, k).trim(), l.slice(k + 1).trim()];
  }));
  return { meta, body: raw.slice(fm[0].length) };
}

const splitList = (s) => (s || '').split(',').map((t) => t.trim()).filter(Boolean);

function parseTopic(file, raw) {
  const { meta, body } = frontMatter(file, raw);
  for (const k of ['id', 'title', 'icon', 'order']) if (!meta[k]) throw new Error(`${file}: нет поля ${k}`);

  const parts = body.split(/^## Q:\s*/m);
  const theory = parts.shift().trim();
  const questions = parts.map((part, idx) => {
    const lines = part.split('\n');
    const q = lines.shift().trim();
    const qm = {};
    while (lines.length && (!lines[0].trim() || /^[a-z]+:\s/.test(lines[0]))) {
      const l = lines.shift();
      if (!l.trim()) { if (Object.keys(qm).length) break; continue; }
      const k = l.indexOf(':');
      qm[l.slice(0, k).trim()] = l.slice(k + 1).trim();
    }
    const where = `${file} #${idx + 1} «${q.slice(0, 50)}»`;
    if (!LEVELS.includes(qm.level)) throw new Error(`${where}: level должен быть одним из ${LEVELS}`);
    if (!TYPES.includes(qm.type)) throw new Error(`${where}: type должен быть одним из ${TYPES}`);
    const freq = Number(qm.freq);
    if (![1, 2, 3].includes(freq)) throw new Error(`${where}: freq 1..3`);
    // Строка «???» отделяет условие задачи (показывается до ответа) от эталонного ответа
    const parts = lines.join('\n').split(/^\?\?\?\s*$/m);
    if (parts.length > 2) throw new Error(`${where}: больше одного разделителя ???`);
    const task = parts.length === 2 ? parts[0].trim() : '';
    const answer = parts.at(-1).trim();
    if (answer.length < 80) throw new Error(`${where}: слишком короткий ответ`);
    return {
      id: `${meta.id}-${qm.id || hash(q)}`,
      topic: meta.id,
      q,
      level: qm.level,
      type: qm.type,
      freq,
      tags: splitList(qm.tags),
      // ссылки на главы теории: «memory» — глава своей темы, «network/tcp» — другой
      theory: splitList(qm.theory).map((r) => (r.includes('/') ? r : `${meta.id}/${r}`)),
      ...(task && { p: md(task) }),
      a: md(answer),
    };
  });
  return {
    id: meta.id, title: meta.title, icon: meta.icon, order: Number(meta.order),
    summary: meta.summary || '', theory: md(theory), questions,
  };
}

const topics = readdirSync(contentDir).filter((f) => f.endsWith('.md')).sort()
  .map((f) => parseTopic(f, readFileSync(join(contentDir, f), 'utf8').replace(/\r/g, '')))
  .sort((a, b) => a.order - b.order);

// ---------- Подробная теория ----------
// Файл theory/*.md: front matter с полем topic, вступление, затем главы:
//   ## Заголовок главы
//   id: stable-id
function parseTheory(file, raw) {
  const { meta, body } = frontMatter(file, raw);
  if (!meta.topic) throw new Error(`${file}: нет поля topic`);
  const parts = body.split(/^## /m);
  const intro = parts.shift().trim();
  const chapters = parts.map((part, idx) => {
    const lines = part.split('\n');
    const title = lines.shift().trim();
    const idLine = lines.findIndex((l) => l.trim());
    const m = idLine >= 0 && lines[idLine].match(/^id:\s*([a-z0-9-]+)\s*$/);
    if (!m) throw new Error(`${file} глава #${idx + 1} «${title}»: после заголовка нужна строка id: <латиница-и-дефисы>`);
    const text = lines.slice(idLine + 1).join('\n').trim();
    if (text.length < 200) throw new Error(`${file} глава «${title}»: слишком короткий текст`);
    return { id: `${meta.topic}/${m[1]}`, title, html: md(text) };
  });
  return { topic: meta.topic, intro: md(intro), chapters };
}

const theory = existsSync(theoryDir)
  ? readdirSync(theoryDir).filter((f) => f.endsWith('.md')).sort()
    .map((f) => parseTheory(f, readFileSync(join(theoryDir, f), 'utf8').replace(/\r/g, '')))
  : [];
const topicIds = new Set(topics.map((t) => t.id));
const chapterIds = new Set();
for (const th of theory) {
  if (!topicIds.has(th.topic)) throw new Error(`theory: неизвестная тема ${th.topic}`);
  for (const ch of th.chapters) {
    if (chapterIds.has(ch.id)) throw new Error(`Дубликат id главы теории: ${ch.id}`);
    chapterIds.add(ch.id);
  }
}
for (const t of topics) for (const q of t.questions) {
  for (const ref of q.theory) {
    if (!chapterIds.has(ref)) throw new Error(`${t.id}: вопрос «${q.q.slice(0, 50)}» ссылается на несуществующую главу теории ${ref}`);
  }
}
// Ссылки вида [текст](#/theory/тема/глава) внутри текста глав и ответов
const theoryTopics = new Set(theory.map((th) => th.topic));
const checkLinks = (html, where) => {
  for (const [, target] of html.matchAll(/href="#\/theory\/([^"]+)"/g)) {
    if (!chapterIds.has(target) && !theoryTopics.has(target)) throw new Error(`${where}: ссылка на несуществующую главу теории #/theory/${target}`);
  }
};
for (const th of theory) for (const ch of th.chapters) checkLinks(ch.html, `theory ${ch.id}`);
for (const t of topics) {
  checkLinks(t.theory, `${t.id}: теория темы`);
  for (const q of t.questions) checkLinks((q.p || '') + q.a, `${t.id}: «${q.q.slice(0, 50)}»`);
}

const ids = new Set();
for (const t of topics) for (const q of t.questions) {
  if (ids.has(q.id)) throw new Error(`Дубликат id вопроса: ${q.id} (${q.q})`);
  ids.add(q.id);
}

writeFileSync(outFile, `// Сгенерировано scripts/build.mjs — не редактируйте вручную.\nwindow.DATA = ${JSON.stringify({ builtAt: new Date().toISOString(), topics, theory })};\n`);
const total = topics.reduce((n, t) => n + t.questions.length, 0);
console.log(`OK: ${topics.length} тем, ${total} вопросов → web/data.js`);
for (const t of topics) {
  const th = theory.find((x) => x.topic === t.id);
  const linked = t.questions.filter((q) => q.theory.length).length;
  console.log(`  ${t.icon} ${t.title.padEnd(32)} ${String(t.questions.length).padStart(3)}` +
    (th ? `   теория: ${th.chapters.length} глав, ссылки из ${linked} вопросов` : ''));
}
