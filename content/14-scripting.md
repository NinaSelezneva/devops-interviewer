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
