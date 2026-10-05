(() => {
  'use strict';

  // ---------- Данные ----------
  const TOPICS = window.DATA.topics;
  const ALL = TOPICS.flatMap((t) => t.questions);
  const BY_ID = new Map(ALL.map((q) => [q.id, q]));
  const TOPIC = new Map(TOPICS.map((t) => [t.id, t]));
  const LEVELS = { middle: 'Middle', senior: 'Senior', lead: 'Lead' };
  const TYPES = { theory: 'Теория', practice: 'Практика', scenario: 'Кейс', design: 'Дизайн', behavioral: 'Поведенческий' };
  const STATUSES = { new: 'Новый', learning: 'Изучаю', known: 'Знаю' };
  const DAY = 864e5;
  const INTERVALS = [0, 1, 3, 7, 16, 35]; // дни до повторения для каждой «коробки» Лейтнера

  // ---------- Хранилище прогресса ----------
  const KEY = 'devops-interviewer:v1';
  const emptyStore = () => ({ cards: {}, history: [] });
  function loadStore() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && typeof s.cards === 'object') return { cards: s.cards, history: s.history || [] };
    } catch { /* приватный режим или битые данные */ }
    return emptyStore();
  }
  let store = loadStore();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* хранилище недоступно */ }
  }

  const status = (id) => {
    const c = store.cards[id];
    if (!c) return 'new';
    return c.box >= 3 ? 'known' : 'learning';
  };
  const isDue = (id, now = Date.now()) => store.cards[id] && store.cards[id].due <= now;

  // grade: 0 — не знаю, 1 — частично, 2 — знаю
  function rate(id, grade) {
    const now = Date.now();
    const c = store.cards[id] || { box: 0, reviews: 0 };
    if (grade === 0) c.box = 0;
    else if (grade === 1) c.box = Math.max(1, Math.min(c.box, 2));
    else c.box = Math.min(c.box + 1, INTERVALS.length - 1);
    c.due = grade === 0 ? now : now + (grade === 1 ? DAY : INTERVALS[c.box] * DAY);
    c.reviews += 1;
    c.last = now;
    store.cards[id] = c;
    save();
  }

  function counts(questions) {
    const r = { new: 0, learning: 0, known: 0, due: 0, total: questions.length };
    const now = Date.now();
    for (const q of questions) {
      r[status(q.id)]++;
      if (isDue(q.id, now)) r.due++;
    }
    return r;
  }

  // ---------- Утилиты ----------
  const app = document.getElementById('app');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  };
  const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const stripTags = (html) => html.replace(/<[^>]+>/g, ' ');

  function progressBar(c) {
    const k = (c.known / c.total) * 100 || 0;
    const l = (c.learning / c.total) * 100 || 0;
    return `<div class="progress" title="Знаю: ${c.known}, изучаю: ${c.learning}, новых: ${c.new}">
      <span class="p-known" style="width:${k}%"></span><span class="p-learning" style="width:${l}%"></span></div>`;
  }

  function badges(q, withTopic = false) {
    const st = status(q.id);
    const t = TOPIC.get(q.topic);
    return `<span class="badges">
      ${withTopic ? `<span class="badge">${t.icon} ${esc(t.title)}</span>` : ''}
      <span class="badge level-${q.level}">${LEVELS[q.level]}</span>
      <span class="badge">${TYPES[q.type]}</span>
      <span class="badge freq" title="Частота на собеседованиях">${'●'.repeat(q.freq)}${'○'.repeat(3 - q.freq)}</span>
      <span class="badge st-${st}" data-status="${q.id}">${STATUSES[st]}</span>
    </span>`;
  }

  const rateButtons = (id) => `<div class="rate" data-rate="${id}">
      <button class="btn bad" data-grade="0">Не знаю <kbd>1</kbd></button>
      <button class="btn warn" data-grade="1">Частично <kbd>2</kbd></button>
      <button class="btn good" data-grade="2">Знаю <kbd>3</kbd></button>
    </div>`;

  const taskBlock = (q) => (q.p ? `<div class="task prose">${q.p}</div>` : '');

  function questionItem(q, withTopic = false) {
    return `<details class="card qitem" data-q="${q.id}">
      <summary><span class="chev">▸</span><span class="qtext">${esc(q.q)}<br>${badges(q, withTopic)}</span></summary>
      <div class="qbody">${taskBlock(q)}<div class="prose">${q.a}</div>${rateButtons(q.id)}</div>
    </details>`;
  }

  // Делегированный обработчик оценок в списках вопросов
  function bindListRating(root) {
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-grade]');
      const box = btn && btn.closest('[data-rate]');
      if (!box || box.dataset.session) return;
      const id = box.dataset.rate;
      rate(id, Number(btn.dataset.grade));
      const st = status(id);
      root.querySelectorAll(`[data-status="${id}"]`).forEach((b) => { b.className = `badge st-${st}`; b.textContent = STATUSES[st]; });
      const det = box.closest('details');
      if (det) det.open = false;
      renderFooter();
    });
  }

  // ---------- Таймер и клавиатура (сбрасываются при смене экрана) ----------
  let timerId = null;
  let keyHandler = null;
  function cleanup() {
    clearInterval(timerId);
    timerId = null;
    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }
  function onKeys(fn) {
    keyHandler = (e) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el && el.closest('input, select')) return;
      const inText = !!el && el.tagName === 'TEXTAREA';
      if (inText && !(e.key === 'Enter' && (e.ctrlKey || e.metaKey))) return;
      fn(e, inText);
    };
    document.addEventListener('keydown', keyHandler);
  }

  // ---------- Экран: обзор ----------
  function viewHome() {
    const c = counts(ALL);
    const history = store.history.slice(-5).reverse();
    app.innerHTML = `
      <h1>Подготовка к собеседованию DevOps-инженера</h1>
      <p class="lead">${ALL.length} ${plural(ALL.length, 'вопрос', 'вопроса', 'вопросов')} по ${TOPICS.length} темам с подробными ответами и теорией.
        Отвечайте вслух или письменно, затем сверяйтесь с эталоном и честно оценивайте себя — интервальное повторение вернёт слабые вопросы.</p>
      <div class="stats">
        <div class="card stat"><div class="num">${c.known}</div><div class="label">Знаю</div></div>
        <div class="card stat"><div class="num">${c.learning}</div><div class="label">Изучаю</div></div>
        <div class="card stat"><div class="num">${c.new}</div><div class="label">Новые</div></div>
        <div class="card stat"><div class="num">${c.due}</div><div class="label">К повторению сейчас</div></div>
      </div>
      ${progressBar(c)}
      <div class="actions">
        <a class="btn primary" href="#/train">▶ Тренировка карточками</a>
        ${c.due ? `<a class="btn" href="#/train?mode=due&autostart=1">↻ Повторить (${c.due})</a>` : ''}
        <a class="btn" href="#/interview">🎤 Пробное собеседование</a>
      </div>
      <h2>Темы</h2>
      <div class="grid">${TOPICS.map((t) => {
        const tc = counts(t.questions);
        return `<a class="card topic-card" href="#/topic/${t.id}">
          <span class="title"><span>${t.icon}</span>${esc(t.title)}</span>
          <span class="summary">${esc(t.summary)}</span>
          ${progressBar(tc)}
          <span class="meta"><span>${tc.known}/${tc.total} знаю</span><span>${tc.due ? `${tc.due} к повторению` : ''}</span></span>
        </a>`;
      }).join('')}</div>
      ${history.length ? `<h2>Последние собеседования</h2>
        <div class="card"><table class="history"><thead><tr><th>Дата</th><th>Вопросов</th><th>Результат</th><th>Темы</th></tr></thead><tbody>
        ${history.map((h) => `<tr><td>${new Date(h.date).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
          <td>${h.n}</td><td><strong>${h.score}%</strong></td><td>${h.topics.map((id) => TOPIC.get(id)?.icon || '').join(' ')}</td></tr>`).join('')}
        </tbody></table></div>` : ''}`;
  }

  // ---------- Экран: тема ----------
  function viewTopic(id) {
    const t = TOPIC.get(id);
    if (!t) { app.innerHTML = '<div class="empty">Тема не найдена. <a href="#/">На главную</a></div>'; return; }
    const f = { level: null, type: null, status: null };
    const c = counts(t.questions);
    const usedTypes = [...new Set(t.questions.map((q) => q.type))];
    const usedLevels = [...new Set(t.questions.map((q) => q.level))];
    app.innerHTML = `
      <p><a href="#/">← Все темы</a></p>
      <h1>${t.icon} ${esc(t.title)}</h1>
      <p class="lead">${esc(t.summary)}</p>
      ${progressBar(c)}
      <div class="actions">
        <a class="btn primary" href="#/train?topics=${t.id}&autostart=1">▶ Тренировать тему</a>
        <a class="btn" href="#/interview?topics=${t.id}">🎤 Собеседование по теме</a>
      </div>
      <details class="card theory" open><summary>📘 Теория и шпаргалка</summary><div class="prose">${t.theory}</div></details>
      <h2>Вопросы (${t.questions.length})</h2>
      <div class="filters" id="filters">
        ${usedLevels.map((l) => `<button class="chip" data-f="level" data-v="${l}">${LEVELS[l]}</button>`).join('')}
        <span class="hint">·</span>
        ${usedTypes.map((ty) => `<button class="chip" data-f="type" data-v="${ty}">${TYPES[ty]}</button>`).join('')}
        <span class="hint">·</span>
        ${Object.entries(STATUSES).map(([k, v]) => `<button class="chip" data-f="status" data-v="${k}">${v}</button>`).join('')}
      </div>
      <div class="qlist" id="qlist"></div>`;
    const list = document.getElementById('qlist');
    const renderList = () => {
      const qs = t.questions.filter((q) => (!f.level || q.level === f.level) && (!f.type || q.type === f.type) && (!f.status || status(q.id) === f.status));
      list.innerHTML = qs.length ? qs.map((q) => questionItem(q)).join('') : '<div class="empty">Нет вопросов под выбранные фильтры</div>';
    };
    document.getElementById('filters').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const key = chip.dataset.f;
      f[key] = f[key] === chip.dataset.v ? null : chip.dataset.v;
      document.querySelectorAll(`.chip[data-f="${key}"]`).forEach((ch) => ch.classList.toggle('on', ch.dataset.v === f[key]));
      renderList();
    });
    bindListRating(list);
    renderList();
  }

  // ---------- Выбор тем (общий для тренировки и собеседования) ----------
  function topicChecks(selected) {
    return `<div class="topic-checks">${TOPICS.map((t) => `<label><input type="checkbox" name="topic" value="${t.id}" ${selected.has(t.id) ? 'checked' : ''}>
      ${t.icon} ${esc(t.title)} <span class="hint">(${t.questions.length})</span></label>`).join('')}</div>
      <div class="row"><button class="link-btn" data-all="1">Выбрать все</button><button class="link-btn" data-all="0">Снять все</button></div>`;
  }
  function bindTopicChecks(root) {
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-all]');
      if (b) root.querySelectorAll('input[name=topic]').forEach((i) => { i.checked = b.dataset.all === '1'; });
    });
    return () => [...root.querySelectorAll('input[name=topic]:checked')].map((i) => i.value);
  }
  const parseTopics = (params) => new Set((params.get('topics') || '').split(',').filter((id) => TOPIC.has(id)));

  // ---------- Экран: тренировка ----------
  // Выбранный уровень запоминается в браузере и используется в тренировке и собеседовании
  const LEVEL_KEY = 'devops-interviewer:level';
  const savedLevel = () => { try { return localStorage.getItem(LEVEL_KEY) || 'all'; } catch { return 'all'; } };
  const saveLevel = (v) => { try { localStorage.setItem(LEVEL_KEY, v); } catch { /* хранилище недоступно */ } };
  const levelSelect = (current) => `<select id="level">
      <option value="all" ${current === 'all' ? 'selected' : ''}>Все уровни</option>
      <option value="middle" ${current === 'middle' ? 'selected' : ''}>Только Middle</option>
      <option value="senior" ${current === 'senior' ? 'selected' : ''}>Только Senior</option>
    </select>`;

  function buildQueue(topicIds, mode, size, level = 'all') {
    const pool = ALL.filter((q) => topicIds.includes(q.topic) && (level === 'all' || q.level === level));
    const now = Date.now();
    if (mode === 'random') return shuffle(pool).slice(0, size);
    const due = pool.filter((q) => isDue(q.id, now)).sort((a, b) => store.cards[a.id].due - store.cards[b.id].due);
    if (mode === 'due') return due.slice(0, size);
    // Умная очередь: сначала просроченные, затем новые (частые вопросы раньше), затем изучаемые
    const fresh = shuffle(pool.filter((q) => status(q.id) === 'new')).sort((a, b) => b.freq - a.freq);
    const learning = shuffle(pool.filter((q) => status(q.id) === 'learning' && !isDue(q.id, now)));
    return [...due, ...fresh, ...learning].slice(0, size);
  }

  function viewTrainSetup(params) {
    const pre = parseTopics(params);
    const selected = pre.size ? pre : new Set(TOPICS.map((t) => t.id));
    const mode = params.get('mode') || 'smart';
    const level = params.get('level') || savedLevel();
    if (params.get('autostart')) { runTraining(buildQueue([...selected], mode, 20, level)); return; }
    app.innerHTML = `
      <h1>Тренировка карточками</h1>
      <p class="lead">Прочитайте вопрос, ответьте вслух или письменно, затем откройте эталон и оцените себя.
        «Не знаю» вернёт вопрос ещё раз в этой же сессии и сразу поставит его в очередь на повторение.</p>
      <div class="card setup" id="setup">
        <div><strong>Темы</strong>${topicChecks(selected)}</div>
        <div class="row"><strong>Режим</strong>
          <select id="mode">
            <option value="smart" ${mode === 'smart' ? 'selected' : ''}>Умная очередь: повторение + новые</option>
            <option value="due" ${mode === 'due' ? 'selected' : ''}>Только к повторению</option>
            <option value="random" ${mode === 'random' ? 'selected' : ''}>Случайные</option>
          </select>
          <strong>Карточек</strong>
          <select id="size"><option>10</option><option selected>20</option><option>40</option><option value="1000">Все</option></select>
          <strong>Уровень</strong>${levelSelect(level)}
        </div>
        <div><button class="btn primary" id="start">▶ Начать</button> <span class="hint" id="setup-hint"></span></div>
      </div>`;
    const setup = document.getElementById('setup');
    const getTopics = bindTopicChecks(setup);
    document.getElementById('start').addEventListener('click', () => {
      const lvl = document.getElementById('level').value;
      saveLevel(lvl);
      const queue = buildQueue(getTopics(), document.getElementById('mode').value, Number(document.getElementById('size').value), lvl);
      if (!queue.length) { document.getElementById('setup-hint').textContent = 'Нет подходящих вопросов: выберите темы или другой режим.'; return; }
      runTraining(queue);
    });
  }

  function runTraining(queue) {
    if (!queue.length) {
      app.innerHTML = '<div class="empty">🎉 Сейчас нечего повторять. <a href="#/train">Выбрать другой режим</a></div>';
      return;
    }
    const total = queue.length;
    const repeated = new Set();
    const tally = [0, 0, 0];
    let done = 0;
    let current = null;
    let revealed = false;

    const next = () => {
      current = queue.shift();
      revealed = false;
      if (!current) return finish();
      app.innerHTML = `
        <div class="session-head"><span>Карточка ${done + 1} из ${total + repeated.size}</span>
          <span class="hint">Пробел — показать ответ · 1/2/3 — оценка</span></div>
        <div class="session-progress"><span style="width:${(done / (total + repeated.size)) * 100}%"></span></div>
        <div class="card flash">
          ${badges(current, true)}
          <div class="q">${esc(current.q)}</div>
          ${taskBlock(current)}
          <textarea id="draft" placeholder="Набросайте ответ тезисами (необязательно). Ctrl+Enter — показать эталон"></textarea>
          <div class="actions"><button class="btn primary" id="reveal">Показать ответ <kbd>␣</kbd></button>
            <a class="btn" href="#/train">Завершить</a></div>
          <div id="answer"></div>
        </div>`;
      document.getElementById('reveal').addEventListener('click', reveal);
    };
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      document.activeElement.blur();
      document.getElementById('reveal').disabled = true;
      const box = document.getElementById('answer');
      box.innerHTML = `<div class="answer prose">${current.a}</div>${rateButtons(current.id).replace('data-rate', 'data-session="1" data-rate')}`;
      box.querySelector('.rate').addEventListener('click', (e) => {
        const b = e.target.closest('[data-grade]');
        if (b) grade(Number(b.dataset.grade));
      });
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const grade = (g) => {
      rate(current.id, g);
      tally[g]++;
      done++;
      if (g === 0 && !repeated.has(current.id)) {
        repeated.add(current.id);
        queue.splice(Math.min(3, queue.length), 0, current);
      }
      renderFooter();
      next();
    };
    const finish = () => {
      cleanup();
      app.innerHTML = `
        <h1>Сессия завершена</h1>
        <div class="stats">
          <div class="card stat"><div class="num" style="color:var(--good)">${tally[2]}</div><div class="label">Знаю</div></div>
          <div class="card stat"><div class="num" style="color:var(--warn)">${tally[1]}</div><div class="label">Частично</div></div>
          <div class="card stat"><div class="num" style="color:var(--bad)">${tally[0]}</div><div class="label">Не знаю</div></div>
        </div>
        <div class="actions"><a class="btn primary" href="#/train">Новая сессия</a><a class="btn" href="#/">На главную</a></div>`;
    };
    onKeys((e, inText) => {
      if (!revealed && (inText || e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); reveal(); return; }
      if (revealed && !inText && ['1', '2', '3'].includes(e.key)) grade(Number(e.key) - 1);
    });
    next();
  }

  // ---------- Экран: пробное собеседование ----------
  function pickInterview(topicIds, n, level) {
    // Чередуем темы, внутри темы — частые вопросы с большей вероятностью
    const byTopic = shuffle(topicIds).map((id) => {
      const qs = TOPIC.get(id).questions.filter((q) => level === 'all' || q.level === level);
      return qs.map((q) => ({ q, key: Math.random() ** (1 / q.freq) })).sort((a, b) => b.key - a.key).map((x) => x.q);
    }).filter((qs) => qs.length);
    const out = [];
    while (out.length < n && byTopic.some((qs) => qs.length)) {
      for (const qs of byTopic) if (qs.length && out.length < n) out.push(qs.shift());
    }
    return shuffle(out);
  }

  function viewInterviewSetup(params) {
    const pre = parseTopics(params);
    const selected = pre.size ? pre : new Set(TOPICS.map((t) => t.id));
    app.innerHTML = `
      <h1>Пробное собеседование</h1>
      <p class="lead">Вопросы из разных тем в случайном порядке и с ограничением по времени — как на реальном интервью.
        Отвечайте вслух (лучше — с записью на диктофон) или письменно, после каждого вопроса сравните с эталоном.</p>
      <div class="card setup" id="setup">
        <div><strong>Темы</strong>${topicChecks(selected)}</div>
        <div class="row">
          <strong>Вопросов</strong><select id="count"><option>5</option><option selected>10</option><option>15</option><option>20</option></select>
          <strong>Время на ответ</strong><select id="time"><option value="120">2 мин</option><option value="180" selected>3 мин</option><option value="300">5 мин</option><option value="0">Без таймера</option></select>
          <strong>Уровень</strong>${levelSelect(savedLevel())}
        </div>
        <div><button class="btn primary" id="start">🎤 Начать собеседование</button> <span class="hint" id="setup-hint"></span></div>
      </div>`;
    const setup = document.getElementById('setup');
    const getTopics = bindTopicChecks(setup);
    document.getElementById('start').addEventListener('click', () => {
      const topics = getTopics();
      const lvl = document.getElementById('level').value;
      saveLevel(lvl);
      const qs = pickInterview(topics, Number(document.getElementById('count').value), lvl);
      if (!qs.length) { document.getElementById('setup-hint').textContent = 'Выберите хотя бы одну тему.'; return; }
      runInterview(qs, Number(document.getElementById('time').value));
    });
  }

  function runInterview(questions, limit) {
    const results = [];
    let i = -1;
    let revealed = false;
    let started = 0;

    const next = () => {
      cleanup();
      i++;
      revealed = false;
      if (i >= questions.length) return finish();
      const q = questions[i];
      started = Date.now();
      app.innerHTML = `
        <div class="session-head"><span>Вопрос ${i + 1} из ${questions.length}</span>
          ${limit ? `<span class="timer" id="timer">${fmtTime(limit)}</span>` : '<span class="timer" id="timer">0:00</span>'}</div>
        <div class="session-progress"><span style="width:${(i / questions.length) * 100}%"></span></div>
        <div class="card flash">
          <span class="badges"><span class="badge">${TOPIC.get(q.topic).icon} ${esc(TOPIC.get(q.topic).title)}</span></span>
          <div class="q">${esc(q.q)}</div>
          ${taskBlock(q)}
          <textarea id="draft" placeholder="Ваш ответ: тезисы, команды, схема рассуждений. Ctrl+Enter — завершить ответ"></textarea>
          <div class="actions"><button class="btn primary" id="reveal">Завершить ответ и показать эталон</button></div>
          <div id="answer"></div>
        </div>`;
      document.getElementById('reveal').addEventListener('click', reveal);
      const timerEl = document.getElementById('timer');
      timerId = setInterval(() => {
        const sec = Math.floor((Date.now() - started) / 1000);
        if (!limit) { timerEl.textContent = fmtTime(sec); return; }
        const left = Math.max(0, limit - sec);
        timerEl.textContent = fmtTime(left);
        timerEl.classList.toggle('low', left <= 30);
        if (left === 0) reveal();
      }, 250);
      onKeys((e, inText) => {
        if (!revealed && inText) { e.preventDefault(); reveal(); return; }
        if (revealed && !inText && ['1', '2', '3'].includes(e.key)) grade(Number(e.key) - 1);
      });
    };
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      clearInterval(timerId);
      document.activeElement.blur();
      const q = questions[i];
      const spent = Math.round((Date.now() - started) / 1000);
      document.getElementById('reveal').disabled = true;
      document.getElementById('draft').readOnly = true;
      const box = document.getElementById('answer');
      box.innerHTML = `<p class="hint">Время ответа: ${fmtTime(spent)}. Сравните с эталоном и оцените себя.</p>
        <div class="answer prose">${q.a}</div>${rateButtons(q.id).replace('data-rate', 'data-session="1" data-rate')}`;
      box.querySelector('.rate').addEventListener('click', (e) => {
        const b = e.target.closest('[data-grade]');
        if (b) grade(Number(b.dataset.grade));
      });
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const grade = (g) => {
      const q = questions[i];
      rate(q.id, g);
      results.push({ id: q.id, grade: g });
      renderFooter();
      next();
    };
    const finish = () => {
      cleanup();
      const score = Math.round((results.reduce((s, r) => s + r.grade, 0) / (results.length * 2)) * 100);
      const topics = [...new Set(results.map((r) => BY_ID.get(r.id).topic))];
      store.history.push({ date: Date.now(), n: results.length, score, topics });
      store.history = store.history.slice(-50);
      save();
      const verdict = score >= 80 ? 'Отличный уровень — вы готовы к собеседованию.'
        : score >= 60 ? 'Хорошая база, но есть пробелы — повторите слабые темы.'
          : 'Стоит ещё поработать: начните с теории по слабым темам.';
      const byTopic = topics.map((id) => {
        const rs = results.filter((r) => BY_ID.get(r.id).topic === id);
        return { t: TOPIC.get(id), pct: Math.round((rs.reduce((s, r) => s + r.grade, 0) / (rs.length * 2)) * 100) };
      }).sort((a, b) => a.pct - b.pct);
      const gradeLabel = ['Не знаю', 'Частично', 'Знаю'];
      const gradeCls = ['st-new', 'st-learning', 'st-known'];
      app.innerHTML = `
        <h1>Результат собеседования</h1>
        <div class="card"><div class="score-big">${score}%</div><p>${verdict}</p></div>
        <h2>По темам</h2>
        <div class="result-list">${byTopic.map(({ t, pct }) => `<a class="card result-row" href="#/topic/${t.id}">
          <span>${t.icon} ${esc(t.title)}</span><strong>${pct}%</strong></a>`).join('')}</div>
        <h2>Вопросы</h2>
        <div class="qlist" id="qlist">${results.map((r) => {
          const q = BY_ID.get(r.id);
          return questionItem(q, true).replace('<span class="chev">▸</span>', `<span class="chev">▸</span><span class="badge ${gradeCls[r.grade]}">${gradeLabel[r.grade]}</span>`);
        }).join('')}</div>
        <div class="actions"><a class="btn primary" href="#/interview">Ещё раз</a><a class="btn" href="#/train?mode=due&autostart=1">Повторить слабые</a></div>`;
      bindListRating(document.getElementById('qlist'));
    };
    next();
  }

  // ---------- Экран: поиск ----------
  const searchIndex = ALL.map((q) => ({ q, text: `${q.q} ${q.tags.join(' ')} ${stripTags(q.p || '')} ${stripTags(q.a)}`.toLowerCase() }));
  function viewSearch(params) {
    const initial = params.get('q') || '';
    app.innerHTML = `
      <h1>Поиск по вопросам и ответам</h1>
      <p><input type="search" id="search" placeholder="Например: TIME_WAIT, etcd, terraform state, PromQL…" value="${esc(initial)}" autofocus></p>
      <p class="hint" id="search-info"></p>
      <div class="qlist" id="qlist"></div>`;
    const input = document.getElementById('search');
    const list = document.getElementById('qlist');
    const info = document.getElementById('search-info');
    const run = () => {
      const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      history.replaceState(null, '', `#/search${terms.length ? `?q=${encodeURIComponent(input.value)}` : ''}`);
      if (!terms.length) { list.innerHTML = ''; info.textContent = `Всего вопросов: ${ALL.length}`; return; }
      const found = searchIndex
        .filter(({ text }) => terms.every((t) => text.includes(t)))
        .map(({ q }) => ({ q, score: terms.filter((t) => q.q.toLowerCase().includes(t)).length * 10 + q.freq }))
        .sort((a, b) => b.score - a.score);
      info.textContent = `Найдено: ${found.length}`;
      const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
      list.innerHTML = found.slice(0, 60).map(({ q }) => questionItem(q, true)
        .replace(`<span class="qtext">${esc(q.q)}`, `<span class="qtext">${esc(q.q).replace(re, '<mark>$1</mark>')}`)).join('');
    };
    input.addEventListener('input', run);
    bindListRating(list);
    run();
  }

  // ---------- Футер: статистика, экспорт/импорт ----------
  function renderFooter() {
    const c = counts(ALL);
    document.getElementById('footer-stats').textContent = `Прогресс: ${c.known} знаю · ${c.learning} изучаю · ${c.new} новых из ${c.total}`;
  }
  document.getElementById('export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `devops-interviewer-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  document.getElementById('import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data.cards !== 'object') throw new Error('bad format');
      store = { cards: data.cards, history: data.history || [] };
      save();
      route();
      alert('Прогресс импортирован');
    } catch {
      alert('Не удалось прочитать файл прогресса');
    }
    e.target.value = '';
  });
  document.getElementById('reset-btn').addEventListener('click', () => {
    if (!confirm('Сбросить весь прогресс и историю собеседований?')) return;
    store = emptyStore();
    save();
    route();
  });

  // ---------- Тема оформления ----------
  const THEME_KEY = 'devops-interviewer:theme';
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
  try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { /* нет доступа */ }
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const isDark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const t = isDark ? 'light' : 'dark';
    applyTheme(t);
    try { localStorage.setItem(THEME_KEY, t); } catch { /* нет доступа */ }
  });

  // ---------- Статистика посещений (GoatCounter) ----------
  // Разделы живут в hash-адресе, который GoatCounter сам не видит, поэтому каждый экран
  // отправляется как отдельный просмотр. Параметры (поисковые запросы) не передаются.
  let lastTracked = null;
  let pendingView = null;
  function trackView(section, id) {
    const path = section === 'home' ? '/' : `/${section}${id ? `/${id}` : ''}`;
    if (path === lastTracked) return;
    lastTracked = path;
    const gc = window.goatcounter;
    if (gc && typeof gc.count === 'function') gc.count({ path, title: document.title });
    else pendingView = path;   // скрипт счётчика ещё не загрузился
  }
  document.getElementById('goatcounter')?.addEventListener('load', () => {
    if (pendingView && window.goatcounter?.count) window.goatcounter.count({ path: pendingView, title: document.title });
    pendingView = null;
  });

  // ---------- Роутер ----------
  function route() {
    cleanup();
    const [path, qs] = location.hash.slice(1).split('?');
    const parts = path.split('/').filter(Boolean);
    const params = new URLSearchParams(qs || '');
    const section = parts[0] || 'home';
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
    if (section === 'topic') viewTopic(parts[1]);
    else if (section === 'train') viewTrainSetup(params);
    else if (section === 'interview') viewInterviewSetup(params);
    else if (section === 'search') viewSearch(params);
    else viewHome();
    renderFooter();
    window.scrollTo(0, 0);
    trackView(section, section === 'topic' && TOPIC.has(parts[1]) ? parts[1] : null);
  }
  window.addEventListener('hashchange', route);
  // Ссылка на текущий адрес (например, «Завершить» внутри сессии) не вызывает hashchange — перерисовываем вручную
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (a && a.getAttribute('href') === (location.hash || '#/')) { e.preventDefault(); route(); }
  });
  route();
})();
