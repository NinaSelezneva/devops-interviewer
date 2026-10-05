---
id: scripting
title: Bash, Python и автоматизация
icon: 💻
order: 14
summary: Надёжные скрипты, обработка текста, автоматизация на Python и Go
---

# Ключевые концепции

На собеседовании часто дают **live-coding**: распарсить лог, написать скрипт проверки, автоматизировать задачу. Оценивают не только результат, но и качество: обработку ошибок, читаемость, идемпотентность.

### Каркас надёжного bash-скрипта
```bash
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

log() { printf '%s [%s] %s\n' "$(date -Is)" "$1" "${*:2}" >&2; }
cleanup() { rm -rf "${TMP_DIR:-}"; }
trap cleanup EXIT
trap 'log ERROR "line $LINENO: $BASH_COMMAND"' ERR

TMP_DIR=$(mktemp -d)
main() {
  local target=${1:?usage: $0 <target>}
  log INFO "processing $target"
}
main "$@"
```

### Инструменты обработки текста
`grep`, `awk`, `sed`, `sort`, `uniq -c`, `cut`, `xargs`, `jq` (JSON), `yq` (YAML), `find -exec`, `parallel`.

### Когда переходить с Bash на Python/Go
Больше ~100 строк, сложные структуры данных, работа с API и JSON, нужны тесты, сложная обработка ошибок → Python. Нужен единый бинарник, производительность, CLI-утилиты и операторы для Kubernetes → Go.

## Q: Что делает set -euo pipefail? Какие у этого подводные камни?
level: middle
type: theory
freq: 3
tags: bash

- **`-e`** — завершить скрипт при ненулевом коде возврата команды.
- **`-u`** — ошибка при обращении к неопределённой переменной (защита от `rm -rf "$DIR/"` при пустой `DIR`).
- **`-o pipefail`** — код возврата пайплайна = код последней упавшей команды, а не только последней в цепочке (иначе `false | true` успешен).
- **`-E`** — ERR-trap наследуется функциями.

Подводные камни `-e`:
- не срабатывает в условиях (`if cmd`, `cmd || true`, `cmd && other`), в функциях, вызванных в условии;
- `local var=$(cmd)` — код возврата `local` (0) маскирует ошибку `cmd`; разделять объявление и присваивание;
- `((i++))` при i=0 возвращает 1 и завершает скрипт;
- `grep` без совпадений возвращает 1 — в пайплайне с pipefail это ошибка (`grep ... || true`).

Поэтому `set -e` — сеть безопасности, а не замена явной обработке ошибок. Плюс **shellcheck** в CI.

## Q: Найдите топ-10 IP-адресов по количеству запросов в access.log nginx и количество 5xx ответов.
level: middle
type: practice
freq: 3
tags: awk, логи

```bash
# Топ-10 IP (первое поле в combined-формате)
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head -10

# Количество 5xx (9-е поле — статус)
awk '$9 ~ /^5/ {c++} END {print c+0}' access.log

# 5xx по URL, топ-5
awk '$9 ~ /^5/ {print $7}' access.log | sort | uniq -c | sort -rn | head -5

# Запросы за последний час по минутам (поле $4: [05/Oct/2026:14:03:11)
awk '{print substr($4, 14, 5)}' access.log | uniq -c | tail -60

# Для JSON-логов
jq -r 'select(.status >= 500) | .remote_addr' access.json | sort | uniq -c | sort -rn | head
```

Что стоит проговорить:
- `uniq` работает только с **отсортированным** входом;
- для огромных файлов `awk` с ассоциативным массивом быстрее, чем `sort | uniq`: `awk '{a[$1]++} END {for (ip in a) print a[ip], ip}' access.log | sort -rn | head`;
- сжатые ротированные логи — `zcat -f access.log*`;
- формат лога может отличаться (за прокси реальный IP — в `X-Forwarded-For`), проверить `log_format`.

## Q: Напишите скрипт на Python, который проверяет список URL и сообщает о недоступных.
level: middle
type: practice
freq: 2
tags: python

```python
#!/usr/bin/env python3
"""Проверка доступности URL с параллелизмом и таймаутами."""
import sys
import concurrent.futures as cf
import requests

TIMEOUT = 5

def check(url: str) -> tuple[str, bool, str]:
    try:
        r = requests.get(url, timeout=TIMEOUT, allow_redirects=True)
        ok = r.status_code < 400
        return url, ok, f"{r.status_code} {r.elapsed.total_seconds():.2f}s"
    except requests.RequestException as e:
        return url, False, type(e).__name__

def main(path: str) -> int:
    with open(path) as f:
        urls = [line.strip() for line in f if line.strip() and not line.startswith("#")]
    failed = 0
    with cf.ThreadPoolExecutor(max_workers=20) as pool:
        for url, ok, info in pool.map(check, urls):
            print(f"{'OK ' if ok else 'FAIL'} {url} {info}")
            failed += not ok
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
```

Что показывает senior-уровень: **таймауты** обязательны (requests по умолчанию ждёт бесконечно), параллелизм (потоки для I/O-bound или asyncio/httpx), понятный **код возврата** для использования в CI/cron, обработка исключений, возможное развитие — ретраи с backoff, вывод в формате Prometheus (textfile collector) или JSON, конфигурация через argparse.

## Q: Чем отличаются "$@" и "$*"? Почему важно заключать переменные в кавычки?
level: middle
type: theory
freq: 2
tags: bash

- **`"$@"`** — каждый аргумент отдельным словом, с сохранением пробелов внутри аргументов. Почти всегда нужен именно он (проброс аргументов).
- **`"$*"`** — все аргументы одной строкой, разделённые первым символом `IFS`.
- Без кавычек оба подвергаются **разбиению по словам** и **glob-раскрытию**.

Без кавычек:
```bash
file="my report.txt"
rm $file        # пытается удалить "my" и "report.txt"
rm "$file"      # правильно

pattern="*"
echo $pattern   # раскроется в список файлов
```

Другие частые ошибки: `[ $var = x ]` падает при пустой переменной (использовать `[[ ]]` или кавычки), `for f in $(ls)` ломается на пробелах (использовать `for f in ./*` или `find -print0 | xargs -0`), `cd dir` без проверки (`cd dir || exit`), парсинг вывода `ls`.

## Q: Почему Go стал популярен в DevOps-инструментах? Нужно ли DevOps-инженеру уметь программировать?
level: senior
type: theory
freq: 2
tags: go, программирование

Go-инструменты: Kubernetes, Docker, Terraform, Prometheus, etcd, Helm, ArgoCD, Vault, Consul.

Причины:
- **Статически слинкованный единый бинарник** — простая доставка, минимальные контейнеры (scratch/distroless), кросс-компиляция одной переменной `GOOS/GOARCH`.
- Быстрая компиляция и хорошая производительность при простоте языка.
- **Конкурентность** (goroutines, channels) — естественна для сетевых сервисов и контроллеров.
- Сильная стандартная библиотека (net/http, crypto), client-go и controller-runtime для Kubernetes.

Нужно ли программировать: на senior-уровне — **да**, ожидается уверенное владение хотя бы одним языком помимо Bash (Python или Go): автоматизация с API облаков, CLI-утилиты, Kubernetes-операторы и контроллеры, плагины, чтение кода приложений при отладке, понимание того, как работают разработчики (тесты, ревью, структура проекта). Код автоматизации должен соответствовать тем же стандартам: тесты, линтеры, ревью, версионирование.

## Q: Напишите bash-скрипт для бэкапа каталога с ротацией старых копий.
level: middle
type: practice
freq: 3
tags: bash, бэкап

```bash
#!/usr/bin/env bash
# Бэкап каталога в архив с датой, хранение последних N дней, лог и код возврата для мониторинга.
set -Eeuo pipefail

SRC_DIR=${1:?"Usage: $0 <source_dir> [backup_dir] [keep_days]"}
BACKUP_DIR=${2:-/backup}
KEEP_DAYS=${3:-7}
NAME=$(basename "$SRC_DIR")
STAMP=$(date +%F_%H-%M-%S)
ARCHIVE="$BACKUP_DIR/${NAME}_${STAMP}.tar.gz"
LOCK="/tmp/backup_${NAME}.lock"

log() { echo "$(date '+%F %T') [$1] ${*:2}" >&2; }

# не запускаться параллельно (например, если прошлый запуск из cron ещё идёт)
exec 9>"$LOCK"
flock -n 9 || { log WARN "another backup is running"; exit 0; }

[[ -d "$SRC_DIR" ]] || { log ERROR "source $SRC_DIR not found"; exit 1; }
mkdir -p "$BACKUP_DIR"

log INFO "creating $ARCHIVE"
tar -czf "$ARCHIVE.tmp" -C "$(dirname "$SRC_DIR")" "$NAME"
mv "$ARCHIVE.tmp" "$ARCHIVE"          # атомарно: незаконченный архив не выглядит готовым
tar -tzf "$ARCHIVE" > /dev/null       # проверка, что архив читается

log INFO "removing backups older than $KEEP_DAYS days"
find "$BACKUP_DIR" -maxdepth 1 -name "${NAME}_*.tar.gz" -mtime +"$KEEP_DAYS" -print -delete

log INFO "done: $(du -h "$ARCHIVE" | cut -f1)"
```
Запуск по расписанию: `0 2 * * * /opt/scripts/backup.sh /var/www /backup 14 >> /var/log/backup.log 2>&1`.

**Что показывает уровень кандидата:**
- `set -Eeuo pipefail`, проверка аргументов, кавычки вокруг переменных;
- защита от параллельного запуска (`flock`);
- запись во временный файл и атомарное переименование;
- **проверка** созданного бэкапа;
- ротация через `find -mtime -delete` с узким шаблоном имени (чтобы случайно не удалить чужие файлы);
- осмысленные коды возврата и лог.

**Как развить решение:** копия **вне сервера** (S3 через `aws s3 cp` или `rclone`, правило 3-2-1), шифрование (`gpg`, `age`), мониторинг (метрика времени последнего успешного бэкапа через textfile collector node_exporter или heartbeat в Healthchecks), регулярная проверка восстановления. Для серьёзных задач — готовые инструменты: restic, borg, для баз данных — pgBackRest/WAL-G.

## Q: Python: распарсите access-лог и выведите топ эндпоинтов по количеству запросов и p95 времени ответа.
level: middle
type: practice
freq: 3
tags: python, логи, live-coding

Формат строки лога (последнее поле — время ответа в секундах):
```
10.0.0.5 - - [05/Oct/2026:14:03:11 +0000] "GET /api/orders/123?x=1 HTTP/1.1" 200 512 0.084
```
Нужно вывести 10 эндпоинтов с наибольшим числом запросов, для каждого — количество, долю ошибок 5xx и p95 латентности. ID в пути нормализовать (`/api/orders/:id`).

???

```python
#!/usr/bin/env python3
import re
import sys
from collections import defaultdict
from statistics import quantiles

LINE_RE = re.compile(
    r'(?P<ip>\S+) \S+ \S+ \[(?P<ts>[^\]]+)\] '
    r'"(?P<method>[A-Z]+) (?P<path>\S+) [^"]*" '
    r'(?P<status>\d{3}) \S+ (?P<rt>[\d.]+)'
)
ID_RE = re.compile(r'/\d+(?=/|$)')


def normalize(path: str) -> str:
    path = path.split('?', 1)[0]          # отбросить query string
    return ID_RE.sub('/:id', path)


def p95(values: list[float]) -> float:
    if len(values) < 2:
        return values[0]
    return quantiles(values, n=100)[94]


def main(filename: str) -> None:
    times = defaultdict(list)
    errors = defaultdict(int)
    bad_lines = 0
    with open(filename, encoding='utf-8', errors='replace') as f:   # потоково, не read() целиком
        for line in f:
            m = LINE_RE.match(line)
            if not m:
                bad_lines += 1
                continue
            key = f"{m['method']} {normalize(m['path'])}"
            times[key].append(float(m['rt']))
            if m['status'].startswith('5'):
                errors[key] += 1

    top = sorted(times.items(), key=lambda kv: len(kv[1]), reverse=True)[:10]
    print(f"{'endpoint':45} {'count':>8} {'5xx %':>7} {'p95 ms':>8}")
    for key, rts in top:
        print(f"{key:45} {len(rts):8} {errors[key] / len(rts) * 100:6.2f}% {p95(rts) * 1000:8.1f}")
    if bad_lines:
        print(f"skipped {bad_lines} unparsable lines", file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1])
```

**На что смотрит интервьюер:**
- файл читается **построчно** (лог может быть на десятки гигабайт), а не через `read()` / `readlines()`;
- регулярное выражение компилируется один раз; некорректные строки не роняют скрипт, а считаются;
- нормализация путей (иначе каждый ID — отдельный «эндпоинт»);
- правильный перцентиль, а не среднее;
- `defaultdict` / `Counter`, понятные имена, `if __name__ == '__main__'`.

**Что спросят дальше:** как обработать файл на 50 ГБ (хранение всех значений латентности съест память → гистограмма по корзинам или алгоритмы вроде t-digest; параллельная обработка частей файла), как читать `.gz` (`gzip.open`), как сделать это потоково из `tail -f`, и почему в продакшене такие вопросы решают метриками (гистограмма в Prometheus) или запросом в Loki/ClickHouse, а не скриптом.

## Q: Python: напишите декоратор retry с экспоненциальной задержкой и jitter.
level: middle
type: practice
freq: 2
tags: python, ретраи, live-coding

Нужен декоратор, который повторяет вызов функции при указанных исключениях: не больше N попыток, задержка растёт экспоненциально, со случайным разбросом, с максимальным пределом. Каждая попытка логируется.

???

```python
import functools
import logging
import random
import time

log = logging.getLogger(__name__)


def retry(exceptions=(Exception,), attempts=5, base_delay=0.5, max_delay=30.0):
    def decorator(func):
        @functools.wraps(func)            # сохранить имя и docstring функции
        def wrapper(*args, **kwargs):
            for attempt in range(1, attempts + 1):
                try:
                    return func(*args, **kwargs)
                except exceptions as exc:
                    if attempt == attempts:
                        log.error("%s failed after %d attempts", func.__name__, attempts)
                        raise                       # пробросить последнее исключение
                    delay = min(max_delay, base_delay * 2 ** (attempt - 1))
                    delay = random.uniform(0, delay)     # "full jitter"
                    log.warning("%s attempt %d/%d failed: %s; retry in %.2fs",
                                func.__name__, attempt, attempts, exc, delay)
                    time.sleep(delay)
        return wrapper
    return decorator


@retry(exceptions=(ConnectionError, TimeoutError), attempts=4)
def fetch_status(url: str) -> int:
    import requests
    return requests.get(url, timeout=5).status_code
```

**Что важно объяснить:**
- **Почему jitter**: без случайного разброса тысячи клиентов, получивших ошибку одновременно, повторят запросы тоже одновременно — «стадо» добьёт восстанавливающийся сервис.
- **Ретраить только временные ошибки** (сетевые, таймауты, 429, 503), а не ошибки валидации или 4xx. Для HTTP — проверять статус и учитывать заголовок `Retry-After`.
- **Только идемпотентные операции** (или с ключом идемпотентности).
- **Предел попыток и общий дедлайн**, иначе вызов может висеть минутами.
- `functools.wraps`, логирование, проброс исходного исключения через `raise` без аргументов (сохраняет трейсбек).

**В реальном коде** используют готовые библиотеки: **tenacity** (`@retry(stop=stop_after_attempt(5), wait=wait_random_exponential(max=30))`), `backoff`, встроенные ретраи `urllib3.Retry` в requests, ретраи в SDK облаков (boto3).

## Q: Python: найдите в GitLab все ветки, в которые не было коммитов больше 90 дней.
level: senior
type: practice
freq: 2
tags: python, api, live-coding

Через REST API GitLab получите все проекты группы, для каждого — ветки, и выведите (или сохраните в CSV) «протухшие» ветки: последний коммит старше 90 дней, ветка не защищена и не является веткой по умолчанию. Токен передаётся через переменную окружения.

???

```python
#!/usr/bin/env python3
import csv
import os
import sys
from datetime import datetime, timedelta, timezone

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

GITLAB = os.environ.get("GITLAB_URL", "https://gitlab.example.com")
TOKEN = os.environ["GITLAB_TOKEN"]            # не хардкодить и не принимать аргументом CLI
STALE_AFTER = timedelta(days=90)


def session() -> requests.Session:
    s = requests.Session()
    s.headers["PRIVATE-TOKEN"] = TOKEN
    retry = Retry(total=5, backoff_factor=1, status_forcelist=(429, 500, 502, 503, 504),
                  respect_retry_after_header=True)
    s.mount("https://", HTTPAdapter(max_retries=retry))
    return s


def paginate(s: requests.Session, path: str, **params):
    """Обходит все страницы ответа GitLab API."""
    params = {"per_page": 100, **params}
    url = f"{GITLAB}/api/v4{path}"
    while url:
        r = s.get(url, params=params, timeout=30)
        r.raise_for_status()
        yield from r.json()
        url = r.links.get("next", {}).get("url")   # ссылка на следующую страницу из заголовка Link
        params = None                               # параметры уже есть в next-ссылке


def main(group: str) -> int:
    s = session()
    now = datetime.now(timezone.utc)
    writer = csv.writer(sys.stdout)
    writer.writerow(["project", "branch", "last_commit", "author", "days"])
    for project in paginate(s, f"/groups/{requests.utils.quote(group, safe='')}/projects",
                            include_subgroups=True, archived=False):
        default = project.get("default_branch")
        for br in paginate(s, f"/projects/{project['id']}/repository/branches"):
            if br["protected"] or br["name"] == default:
                continue
            committed = datetime.fromisoformat(br["commit"]["committed_date"])
            age = now - committed
            if age > STALE_AFTER:
                writer.writerow([project["path_with_namespace"], br["name"],
                                 committed.date(), br["commit"]["author_name"], age.days])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
```

**Ключевые моменты:**
- **Пагинация** — самая частая ошибка: API возвращает 20 элементов по умолчанию, и без обхода страниц результат молча неполный. GitLab отдаёт ссылку на следующую страницу в заголовке `Link` (`requests` разбирает его в `r.links`).
- **Ретраи и rate limit** (429, `Retry-After`), таймауты на каждый запрос.
- **Секреты из окружения**, а не в коде и не в аргументах командной строки (видны в `ps` и истории shell).
- Работа с датами **с часовыми поясами** (`timezone.utc`, `fromisoformat`).
- Генератор для пагинации — не держим всё в памяти.
- Вывод в машиночитаемом формате (CSV/JSON), осмысленный код возврата.

**Развитие:** параллельные запросы по проектам (`ThreadPoolExecutor` с ограничением, чтобы не попасть под rate limit), режим `--delete` с dry-run по умолчанию, использование библиотеки `python-gitlab`, запуск по расписанию в CI с отправкой отчёта.

## Q: Python: найдите поды, которые часто перезапускаются или не в состоянии Ready.
level: senior
type: practice
freq: 2
tags: python, kubernetes, live-coding

С помощью официального клиента Kubernetes для Python выведите по всем namespace поды, у которых суммарно больше 5 рестартов контейнеров или которые не Ready дольше 10 минут. Для каждого — причина последнего завершения контейнера (например, OOMKilled).

???

```python
#!/usr/bin/env python3
from datetime import datetime, timedelta, timezone

from kubernetes import client, config

RESTART_THRESHOLD = 5
NOT_READY_FOR = timedelta(minutes=10)


def load_config() -> None:
    try:
        config.load_incluster_config()        # внутри кластера: токен ServiceAccount
    except config.ConfigException:
        config.load_kube_config()             # локально: ~/.kube/config


def ready_condition(pod):
    for cond in pod.status.conditions or []:
        if cond.type == "Ready":
            return cond
    return None


def main() -> None:
    load_config()
    v1 = client.CoreV1Api()
    now = datetime.now(timezone.utc)
    # limit/_continue — постранично, чтобы не тянуть десятки тысяч подов одним ответом
    cont = None
    while True:
        resp = v1.list_pod_for_all_namespaces(limit=500, _continue=cont)
        for pod in resp.items:
            if pod.status.phase in ("Succeeded",):           # завершённые Job'ы не интересны
                continue
            statuses = pod.status.container_statuses or []
            restarts = sum(cs.restart_count for cs in statuses)
            ready = ready_condition(pod)
            not_ready_long = (ready is not None and ready.status != "True"
                              and now - ready.last_transition_time > NOT_READY_FOR)
            if restarts > RESTART_THRESHOLD or not_ready_long:
                reasons = [
                    f"{cs.name}:{cs.last_state.terminated.reason}"
                    for cs in statuses
                    if cs.last_state and cs.last_state.terminated
                ]
                print(f"{pod.metadata.namespace}/{pod.metadata.name} "
                      f"node={pod.spec.node_name} restarts={restarts} "
                      f"ready={ready.status if ready else 'n/a'} "
                      f"last_termination={','.join(reasons) or '-'}")
        cont = resp.metadata._continue
        if not cont:
            break


if __name__ == "__main__":
    main()
```

**Что обсудить:**
- Аутентификация: `load_incluster_config` (под с ServiceAccount) против `load_kube_config`; **RBAC** для скрипта — ClusterRole только с `get`/`list` на `pods`.
- Пагинация через `limit` / `_continue` на больших кластерах.
- Аккуратная работа с `None` (у пода в Pending нет `container_statuses`).
- Что можно сделать «по-взрослому»: эти же данные уже есть в **kube-state-metrics** (`kube_pod_container_status_restarts_total`, `kube_pod_status_ready`), и правильнее сделать алерт в Prometheus, чем скрипт. Скрипт уместен для разовых отчётов или как основа для оператора или бота.
- Для постоянного наблюдения вместо периодического `list` — **watch** (`watch.Watch().stream(...)`) или informer'ы.

## Q: Python: найдите дубликаты файлов в каталоге по содержимому.
level: middle
type: practice
freq: 2
tags: python, файлы, live-coding

Нужно найти в каталоге (рекурсивно) файлы с одинаковым содержимым и вывести группы дубликатов. Каталог может содержать сотни тысяч файлов и файлы по несколько гигабайт.

???

```python
#!/usr/bin/env python3
import hashlib
import os
import sys
from collections import defaultdict
from pathlib import Path

CHUNK = 1024 * 1024  # 1 МБ


def file_hash(path: Path, limit: int | None = None) -> str:
    h = hashlib.blake2b()                  # быстрый; sha256 тоже подходит
    read = 0
    with path.open("rb") as f:
        while chunk := f.read(CHUNK):      # чтение кусками: не грузим гигабайты в память
            h.update(chunk)
            read += len(chunk)
            if limit and read >= limit:
                break
    return h.hexdigest()


def group_by(paths, key):
    groups = defaultdict(list)
    for p in paths:
        try:
            groups[key(p)].append(p)
        except OSError as e:               # нет прав, файл удалён в процессе
            print(f"skip {p}: {e}", file=sys.stderr)
    return [g for g in groups.values() if len(g) > 1]


def main(root: str) -> None:
    files = [p for p in Path(root).rglob("*") if p.is_file() and not p.is_symlink()]
    # 1. По размеру: файлы разного размера не могут совпадать — дешёвая отсечка
    candidates = group_by(files, lambda p: p.stat().st_size)
    # 2. По хешу первых 64 КБ — отсекаем большинство оставшихся
    candidates = [g2 for g in candidates for g2 in group_by(g, lambda p: file_hash(p, 64 * 1024))]
    # 3. Полный хеш только для оставшихся кандидатов
    duplicates = [g2 for g in candidates for g2 in group_by(g, file_hash)]

    wasted = 0
    for group in duplicates:
        size = group[0].stat().st_size
        wasted += size * (len(group) - 1)
        print(f"\n{size} bytes x {len(group)}:")
        for p in group:
            print(f"  {p}")
    print(f"\nwasted: {wasted / 1024**2:.1f} MiB", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
```

**Ключевые идеи:**
- **Не хешировать всё подряд**: сначала группировка по размеру (бесплатно — из метаданных), потом по хешу начала файла, полный хеш — только для реальных кандидатов. Это на порядки быстрее.
- **Чтение кусками** — постоянное потребление памяти независимо от размера файла.
- Обработка ошибок доступа, пропуск симлинков (иначе возможны циклы и ложные дубликаты), жёсткие ссылки на один inode — не дубликаты (можно учитывать `st_ino` и `st_dev`).
- Для ускорения на больших объёмах — параллельное хеширование (`ThreadPoolExecutor`: чтение диска — I/O-задача).

Готовые утилиты: `fdupes`, `jdupes`, `rdfind`.

## Q: Python: сравните конфигурации двух окружений и покажите различия.
level: middle
type: practice
freq: 2
tags: python, yaml, live-coding

Есть два YAML-файла с конфигурацией сервиса для staging и production (вложенные словари и списки). Нужно вывести, какие ключи есть только в одном окружении и какие значения отличаются, с полным путём до ключа (`database.pool.size`). Значения секретов (ключи, содержащие `password`, `token`, `secret`) не выводить.

???

```python
#!/usr/bin/env python3
import sys

import yaml

SENSITIVE = ("password", "token", "secret", "key")


def flatten(data, prefix=""):
    """{'db': {'pool': {'size': 5}}} -> {'db.pool.size': 5}"""
    items = {}
    if isinstance(data, dict):
        for k, v in data.items():
            items.update(flatten(v, f"{prefix}.{k}" if prefix else str(k)))
    elif isinstance(data, list):
        for i, v in enumerate(data):
            items.update(flatten(v, f"{prefix}[{i}]"))
    else:
        items[prefix] = data
    return items


def show(path: str, value) -> str:
    if any(word in path.lower() for word in SENSITIVE):
        return "***"
    return repr(value)


def main(a_file: str, b_file: str) -> int:
    with open(a_file) as fa, open(b_file) as fb:
        a = flatten(yaml.safe_load(fa) or {})    # safe_load: yaml.load может выполнить код
        b = flatten(yaml.safe_load(fb) or {})

    only_a = sorted(a.keys() - b.keys())
    only_b = sorted(b.keys() - a.keys())
    changed = sorted(k for k in a.keys() & b.keys() if a[k] != b[k])

    for k in only_a:
        print(f"- {k} = {show(k, a[k])}   (only in {a_file})")
    for k in only_b:
        print(f"+ {k} = {show(k, b[k])}   (only in {b_file})")
    for k in changed:
        print(f"~ {k}: {show(k, a[k])} -> {show(k, b[k])}")
    return 1 if (only_a or only_b or changed) else 0   # ненулевой код — удобно в CI


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
```

**Что важно:**
- **`yaml.safe_load`**, а не `yaml.load` — последний может создавать произвольные Python-объекты из недоверенного файла.
- Рекурсивное «выравнивание» структуры в плоские пути, обработка списков.
- Операции над множествами ключей (`-`, `&`) вместо вложенных циклов.
- **Маскирование секретов** в выводе (логи CI видят многие).
- Код возврата для использования в пайплайне (проверка дрейфа конфигураций).

**Обсуждение:** списки сравниваются по индексу — вставка элемента в начало даст «изменения» во всех следующих (можно сравнивать списки как множества или по ключу `name`); готовые инструменты: `deepdiff` (Python), `dyff` (YAML-aware diff), `kubectl diff`, `helm diff`.

## Q: Чем отличаются потоки, процессы и asyncio в Python? Что такое GIL? Как изолировать зависимости?
level: middle
type: theory
freq: 2
tags: python, конкурентность

**GIL** (Global Interpreter Lock) в CPython — глобальная блокировка: в каждый момент времени Python-байткод выполняет только один поток процесса.
- Для **I/O-bound** задач (HTTP-запросы, работа с API, БД, файлы) GIL почти не мешает: поток отпускает его на время ожидания ввода-вывода.
- Для **CPU-bound** задач (хеширование, парсинг, сжатие на чистом Python) потоки не дают ускорения.
- В Python 3.13+ есть экспериментальная сборка без GIL (free-threaded), но в продакшене пока чаще используют классические подходы.

**Что выбрать:**
| Подход | Модуль | Когда |
|---|---|---|
| Потоки | `concurrent.futures.ThreadPoolExecutor`, `threading` | I/O-bound, простой синхронный код и библиотеки (requests, boto3) |
| Процессы | `ProcessPoolExecutor`, `multiprocessing` | CPU-bound, обходят GIL; дороже по памяти и запуску, данные передаются сериализацией |
| asyncio | `asyncio`, `aiohttp`, `httpx` | очень много одновременных I/O-операций (тысячи соединений) в одном потоке; нужны async-библиотеки, блокирующий вызов останавливает весь event loop |

```python
from concurrent.futures import ThreadPoolExecutor
import requests

def check(url):
    return url, requests.get(url, timeout=5).status_code

with ThreadPoolExecutor(max_workers=20) as pool:
    for url, code in pool.map(check, urls):
        print(url, code)
```

**Изоляция зависимостей:**
- **виртуальное окружение** для каждого проекта: `python -m venv .venv && . .venv/bin/activate`, никогда не ставить пакеты в системный Python через `sudo pip` (ломает пакеты ОС; в современных дистрибутивах это запрещено — PEP 668 «externally managed environment»);
- **фиксация версий**: `requirements.txt` с точными версиями (`pip freeze`, `pip-tools` → `requirements.lock`), `pyproject.toml` + lock-файл (**uv**, Poetry);
- **uv** — быстрый современный менеджер пакетов и окружений; **pipx** — для установки CLI-утилит (ansible, awscli) в изолированные окружения;
- в контейнерах venv не обязателен, но версии фиксируются так же.

## Q: Как обрабатывать JSON в командной строке с помощью jq? Решите типовые задачи.
level: middle
type: practice
freq: 2
tags: jq, json

**jq** — «sed и awk для JSON». Незаменим для работы с API, `kubectl -o json`, `aws ... --output json`, `terraform show -json`.

```bash
# красивый вывод и выбор поля
curl -s https://api.example.com/status | jq .
jq '.items[0].metadata.name' pods.json

# сырой вывод строк без кавычек (-r) — для использования в скриптах
kubectl get pods -o json | jq -r '.items[].metadata.name'

# фильтрация: поды не в состоянии Running
kubectl get pods -A -o json | jq -r '.items[]
  | select(.status.phase != "Running")
  | "\(.metadata.namespace)/\(.metadata.name) \(.status.phase)"'

# поды с количеством рестартов больше 5
kubectl get pods -A -o json | jq -r '.items[]
  | {ns: .metadata.namespace, name: .metadata.name,
     restarts: ([.status.containerStatuses[]?.restartCount] | add // 0)}
  | select(.restarts > 5) | "\(.ns)/\(.name) \(.restarts)"'

# образы всех контейнеров кластера без повторов
kubectl get pods -A -o json | jq -r '[.items[].spec.containers[].image] | unique[]'

# группировка и подсчёт: сколько инстансов каждого типа
aws ec2 describe-instances | jq -r '[.Reservations[].Instances[].InstanceType]
  | group_by(.) | map("\(.[0]) \(length)")[]'

# изменение JSON: поменять значение и записать обратно
jq '.replicas = 3 | .image.tag = "1.5.0"' values.json > tmp && mv tmp values.json

# передача переменных из shell безопасно (без подстановки в строку фильтра)
jq --arg env "$ENV" '.environment = $env' config.json

# ресурсы, которые Terraform собирается удалить
terraform show -json tfplan | jq -r '.resource_changes[]
  | select(.change.actions | index("delete")) | .address'

# JSON → CSV
jq -r '.users[] | [.id, .email, .role] | @csv' users.json
```

**Полезное:** `?` — не падать на отсутствующих полях (`.status.containerStatuses[]?`), `//` — значение по умолчанию, `keys`, `length`, `to_entries` / `from_entries`, `map`, `select`, `sort_by`, `group_by`, `unique_by`, `@base64d` (декодировать секрет Kubernetes: `kubectl get secret x -o json | jq -r '.data.password | @base64d'`).

Для YAML — **yq** (с синтаксисом, похожим на jq): `yq '.spec.replicas = 5' -i deploy.yaml`. Для простых случаев в `kubectl` есть `-o jsonpath` и `-o custom-columns`.

## Q: Зачем DevOps-инженеру Makefile? Как его использовать в проекте?
level: middle
type: practice
freq: 1
tags: make, автоматизация

**Makefile** — простой способ собрать типовые команды проекта в одном месте с единым интерфейсом: `make test`, `make build`, `make deploy ENV=stage`. Новый человек в проекте видит все действия сразу, а CI вызывает те же команды, что и разработчик локально — «работает у меня, но не в CI» случается реже.

```makefile
SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

IMAGE ?= registry.example.com/shop/api
TAG   ?= $(shell git rev-parse --short HEAD)
ENV   ?= dev

.PHONY: help lint test build push deploy tf-plan

help: ## Показать список команд
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "} {printf "  %-12s %s\n", $$1, $$2}'

lint: ## Линтеры
	ruff check . && hadolint Dockerfile && helm lint chart/

test: lint ## Тесты (сначала линтеры)
	pytest -q

build: ## Собрать образ
	docker build -t $(IMAGE):$(TAG) .

push: build ## Опубликовать образ
	docker push $(IMAGE):$(TAG)

deploy: ## Задеплоить: make deploy ENV=stage
	helm upgrade --install api chart/ -n $(ENV) -f chart/values-$(ENV).yaml --set image.tag=$(TAG) --atomic

tf-plan: ## terraform plan для окружения
	cd terraform/envs/$(ENV) && terraform init -input=false && terraform plan -out=tfplan
```

**Особенности, о которых спрашивают:**
- **отступы — только табуляция** (частая ошибка `missing separator`);
- **`.PHONY`** — цели, которые не являются файлами; иначе, если в каталоге появится файл `test`, `make test` решит, что всё уже «собрано»;
- каждая строка рецепта выполняется в **отдельном shell** (`cd` не сохраняется между строками — объединять через `&&` или использовать `.ONESHELL`);
- `$$` — экранирование `$` для shell; `?=` — значение по умолчанию, переопределяемое из командной строки или окружения;
- зависимости целей (`push: build`) и инкрементальная сборка по времени изменения файлов — изначальное назначение make.

**Альтернативы:** `just` (простой синтаксис, без особенностей make), `Taskfile` (go-task, YAML), скрипты в `scripts/`, npm scripts. Главное — единая точка входа для типовых операций, а не конкретный инструмент.

## Q: Напишите простой HTTP-сервис на Go с health-check и метриками Prometheus.
level: senior
type: practice
freq: 1
tags: go, live-coding, prometheus

Нужен минимальный сервис: эндпоинт `/hello`, `/healthz` для проб Kubernetes, `/metrics` со счётчиком запросов и гистограммой длительности, корректное завершение по SIGTERM.

???

```go
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	requests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "http_requests_total", Help: "HTTP requests",
	}, []string{"path", "code"})
	duration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "http_request_duration_seconds", Help: "Request latency",
		Buckets: prometheus.DefBuckets,
	}, []string{"path"})
)

type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (r *statusRecorder) WriteHeader(code int) { r.code = code; r.ResponseWriter.WriteHeader(code) }

// instrument — middleware: считает запросы и время ответа (RED-метрики)
func instrument(path string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, code: http.StatusOK}
		h(rec, r)
		duration.WithLabelValues(path).Observe(time.Since(start).Seconds())
		requests.WithLabelValues(path, strconv.Itoa(rec.code)).Inc()
	}
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))   // структурированные логи в stdout

	mux := http.NewServeMux()
	mux.HandleFunc("GET /hello", instrument("/hello", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("hello\n"))
	}))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.Handle("GET /metrics", promhttp.Handler())

	addr := ":" + getenv("PORT", "8080")
	srv := &http.Server{
		Addr: addr, Handler: mux,
		ReadHeaderTimeout: 5 * time.Second,   // защита от медленных клиентов (Slowloris)
		ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	go func() {
		logger.Info("listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()                                  // ждём SIGTERM от Kubernetes
	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {   // дорабатываем текущие запросы
		logger.Error("graceful shutdown failed", "err", err)
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
```
Dockerfile для такого сервиса — multi-stage: `golang:1.23` для сборки с `CGO_ENABLED=0`, финальный образ `gcr.io/distroless/static:nonroot`.

**Что показывает решение:**
- **graceful shutdown** по SIGTERM: `srv.Shutdown` перестаёт принимать новые соединения и дожидается текущих запросов — без этого при каждом деплое часть запросов обрывается;
- **таймауты сервера** (по умолчанию в Go их нет);
- конфигурация через переменные окружения (12-factor), логи в stdout в JSON;
- метрики RED через middleware, низкая кардинальность меток (путь-шаблон, а не URL с ID);
- маршрутизация с методами в стандартной библиотеке (Go 1.22+).

**Что спросят дальше:** чем отличаются liveness и readiness (отдельный `/readyz`, который становится неуспешным в начале завершения), как добавить трейсинг (OpenTelemetry), почему Go удобен для таких сервисов (один статический бинарник, маленький образ, горутины).
