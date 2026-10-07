---
id: containers
title: Docker и контейнеры
icon: 🐳
order: 3
summary: Образы, слои, рантаймы, безопасность и оптимизация контейнеров
---

# Ключевые концепции

Контейнер — это **обычный процесс Linux**, изолированный namespaces, ограниченный cgroups и запущенный с корневой ФС из образа. Никакой «лёгкой виртуальной машины» внутри нет.

### Стек контейнеризации
```
docker CLI / nerdctl / kubelet (CRI)
        │
dockerd / containerd / CRI-O      ← высокоуровневый рантайм: образы, сеть, хранилище
        │
runc / crun / gVisor / Kata       ← низкоуровневый OCI-рантайм: namespaces, cgroups, запуск
        │
ядро Linux
```

### Стандарты OCI
- **Image spec** — формат образа: манифест, конфиг, слои (tar).
- **Runtime spec** — как запустить контейнер из bundle.
- **Distribution spec** — API реестра.

### Что ждут от senior
- Понимание слоёв, overlayfs, кеша сборки и способов уменьшить образ.
- Корректная обработка сигналов и PID 1.
- Безопасность: non-root, capabilities, read-only rootfs, сканирование, подписи, минимальные базовые образы.
- Разница Docker vs containerd в Kubernetes (dockershim удалён в 1.24).

## Q: Чем контейнер отличается от виртуальной машины?
level: middle
type: theory
freq: 3
tags: основы
theory: what-is-container, linux/isolation

| | Виртуальная машина | Контейнер |
|---|---|---|
| Изоляция | гипервизор, отдельное ядро | namespaces + cgroups, **общее ядро хоста** |
| Старт | десятки секунд–минуты | миллисекунды–секунды |
| Размер | ГБ (полная ОС) | МБ (только userspace приложения) |
| Безопасность | сильная граница | слабее: уязвимость ядра = побег из контейнера |
| ОС | любая | того же типа, что ядро хоста |

Следствия: контейнеры плотнее упаковываются и быстрее масштабируются, но для недоверенных нагрузок (multi-tenant) используют **sandbox-рантаймы**: gVisor (перехват syscall'ов в userspace-ядре) или Kata Containers / Firecracker (microVM на контейнер).

## Q: Как устроены слои образа? Как уменьшить размер образа и ускорить сборку?
level: middle
type: practice
freq: 3
tags: dockerfile, оптимизация
theory: images, dockerfile

Каждая инструкция `RUN`, `COPY`, `ADD` создаёт **неизменяемый слой** (diff файловой системы). При запуске слои объединяются через **overlayfs** (lowerdir — слои образа, upperdir — записываемый слой контейнера, copy-on-write). Слои переиспользуются между образами и кешируются при сборке.

**Удаление файла в следующем слое не уменьшает образ** — файл остаётся в предыдущем слое. Поэтому установку и очистку делают в одном `RUN`.

Оптимизация размера:
- **Multi-stage build**: собрать в образе с компилятором, скопировать только артефакт в минимальный образ.
- Минимальные базы: `distroless`, `alpine` (musl — возможны проблемы совместимости), `scratch` для статических Go-бинарников, `-slim` варианты.
- `--no-install-recommends`, `rm -rf /var/lib/apt/lists/*` в том же слое.
- `.dockerignore` (не тащить `.git`, `node_modules`).

Оптимизация скорости сборки:
- **Порядок инструкций**: сначала редко меняющееся (зависимости), потом код:
```dockerfile
FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /app ./cmd/api

FROM gcr.io/distroless/static:nonroot
COPY --from=build /app /app
USER nonroot
ENTRYPOINT ["/app"]
```
- BuildKit: `RUN --mount=type=cache,target=/root/.cache/go-build`, параллельные стадии, `--cache-from`/`--cache-to` для удалённого кеша в CI.

## Q: Чем CMD отличается от ENTRYPOINT? Почему важна exec-форма?
level: middle
type: theory
freq: 3
tags: dockerfile, сигналы
theory: dockerfile, lifecycle, linux/signals

- **ENTRYPOINT** — исполняемый файл контейнера; **CMD** — аргументы по умолчанию (или команда, если ENTRYPOINT нет). `docker run image args` заменяет CMD; ENTRYPOINT меняется только через `--entrypoint`.
- Типичный паттерн: `ENTRYPOINT ["/app"]`, `CMD ["--port=8080"]`.

**Exec-форма** `["/app", "arg"]` запускает процесс напрямую — он становится **PID 1** и получает сигналы.
**Shell-форма** `CMD /app arg` запускает `/bin/sh -c "/app arg"` — PID 1 становится `sh`, который **не пробрасывает SIGTERM** дочернему процессу. Результат: `docker stop` и удаление пода ждут таймаут и убивают процесс SIGKILL — без graceful shutdown.

Если нужен shell-скрипт-обёртка, в конце используйте `exec "$@"`. Ещё особенность PID 1: ядро не применяет к нему обработчики сигналов по умолчанию — если приложение не установило обработчик SIGTERM, сигнал игнорируется. Решение — `tini` / `--init`.

## Q: Какие сетевые режимы есть в Docker и как контейнеры общаются между собой?
level: middle
type: theory
freq: 2
tags: сеть
theory: networking

- **bridge** (по умолчанию): у контейнера свой net namespace, пара **veth** соединяет его с мостом `docker0` на хосте, исходящий трафик через NAT (masquerade), публикация портов `-p 8080:80` — DNAT-правила iptables (или userland-proxy).
- **Пользовательская bridge-сеть** (`docker network create`): встроенный **DNS по именам контейнеров** — именно так общаются сервисы в docker-compose. В дефолтном `docker0` DNS по именам нет.
- **host**: контейнер использует сетевой стек хоста — без NAT, максимальная производительность, но конфликты портов.
- **none**: только loopback.
- **overlay**: сеть между хостами (Swarm), VXLAN.
- **macvlan/ipvlan**: контейнер получает адрес в физической сети.
- `--network container:<id>` — общий net namespace (так устроен Pod в Kubernetes: pause-контейнер держит namespace).

Внимание: Docker правит iptables и может **обходить правила ufw/firewalld** для опубликованных портов — частая дыра в безопасности.

## Q: Как сохранять данные контейнера? Чем volume отличается от bind mount?
level: middle
type: theory
freq: 2
tags: хранение
theory: storage

Записываемый слой контейнера эфемерен и медленный (copy-on-write), поэтому данные выносят наружу:

- **Volume** — управляется Docker (`/var/lib/docker/volumes`), переносим, поддерживает драйверы (NFS, облачные диски), не зависит от структуры хоста. Рекомендуемый вариант для данных БД.
- **Bind mount** — монтирование произвольного пути хоста. Удобно в разработке (горячая перезагрузка кода) и для конфигов, но зависит от хоста, возможны проблемы с правами (UID внутри и снаружи).
- **tmpfs** — в памяти, для временных и чувствительных данных.

Проблема прав: процесс в контейнере работает с UID 1000, а каталог на хосте принадлежит root → `Permission denied`. Решения: `chown` на хосте, `--user`, user namespaces, init-контейнер с `chown` в Kubernetes, `fsGroup`.

## Q: Как вы обеспечиваете безопасность контейнеров?
level: senior
type: practice
freq: 3
tags: безопасность
theory: security

На каждом этапе жизненного цикла:

**Сборка (build)**
- Минимальные базовые образы (distroless, chainguard/wolfi), регулярное обновление базы.
- Сканирование уязвимостей (Trivy, Grype) в CI с порогом блокировки по severity.
- Отсутствие секретов в слоях (`docker history` их покажет) — использовать `RUN --mount=type=secret`.
- SBOM (syft) и **подпись образов** (cosign/Sigstore), закреплённые теги по digest (`image@sha256:...`).

**Запуск (runtime)**
- `USER` не root, `allowPrivilegeEscalation: false`.
- `--cap-drop=ALL` и добавление только необходимых capabilities.
- `readOnlyRootFilesystem: true`.
- Никакого `--privileged` и монтирования `/var/run/docker.sock` (это root на хосте).
- seccomp (профиль RuntimeDefault), AppArmor/SELinux.
- Лимиты ресурсов (защита от DoS соседей).
- Rootless Docker/Podman, user namespaces.

**Платформа**
- Admission-политики (Kyverno/OPA Gatekeeper, Pod Security Admission: restricted) — запрет привилегированных, проверка подписи, разрешённые реестры.
- Runtime-детекция аномалий: Falco, Tetragon.

## Q: Docker, containerd, CRI-O, runc — в чём разница? Почему Kubernetes отказался от Docker?
level: senior
type: theory
freq: 2
tags: рантаймы, kubernetes
theory: runtimes

- **runc** — низкоуровневый OCI-рантайм: создаёт namespaces, cgroups и запускает процесс. Альтернативы: crun (C, быстрее), gVisor (runsc), Kata.
- **containerd** — высокоуровневый рантайм-демон: скачивание и хранение образов, снапшоты (overlayfs), управление жизненным циклом через shim, вызов runc. Вынесен из Docker, проект CNCF.
- **CRI-O** — минималистичный рантайм специально под Kubernetes CRI.
- **Docker Engine (dockerd)** — надстройка над containerd: CLI, сборка, сети, volumes, compose.

Kubernetes общается с рантаймом через **CRI** (Container Runtime Interface). Docker не реализовывал CRI, поэтому существовал адаптер **dockershim** внутри kubelet — лишний слой и бремя поддержки. В 1.24 его удалили. При этом **образы, собранные Docker, продолжают работать** — это стандартные OCI-образы. Изменилось только то, что на нодах нет `docker` CLI: для отладки используют `crictl`, `nerdctl`, `ctr`.

## Q: Контейнер постоянно перезапускается сразу после старта. Как будете разбираться?
level: middle
type: scenario
freq: 3
tags: траблшутинг
theory: lifecycle

1. `docker ps -a` — код выхода (`Exited (137)`, `Exited (1)`).
   - **137** = 128 + 9 (SIGKILL) — часто **OOM** (`docker inspect` → `State.OOMKilled: true`) или принудительная остановка.
   - **143** = SIGTERM, **139** = SIGSEGV, **1** — ошибка приложения, **126/127** — нет прав на запуск / команда не найдена.
2. `docker logs <id>` (и `--previous` / `kubectl logs -p` в k8s) — ошибка конфигурации, нет переменных окружения, не доступна БД.
3. `docker inspect` — фактические entrypoint/cmd, env, монтирования, healthcheck.
4. Запустить интерактивно, переопределив entrypoint: `docker run -it --entrypoint sh image` и выполнить команду вручную.
5. Проверить архитектуру образа (`exec format error` — arm64-образ на amd64 ноде).
6. Проверить, не завершается ли процесс «нормально»: контейнер живёт, пока жив PID 1, — демон, уходящий в фон (`nginx` без `daemon off`), завершит контейнер.

## Q: Что такое docker-compose? Когда его использовать и какие у него подводные камни?
level: middle
type: practice
freq: 3
tags: docker-compose
theory: compose

**Docker Compose** — инструмент для описания и запуска **многоконтейнерного приложения на одном хосте** одним YAML-файлом. Сейчас это плагин `docker compose` (v2, на Go); старый `docker-compose` (v1, Python) устарел.

```yaml
services:
  api:
    build: .
    image: shop/api:dev
    ports: ["8080:8080"]
    environment:
      DATABASE_URL: postgres://app:secret@db:5432/app   # db — имя сервиса = DNS-имя
    env_file: .env
    depends_on:
      db:
        condition: service_healthy     # ждать не просто старта, а готовности
    restart: unless-stopped
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: secret
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      retries: 10
volumes:
  pgdata:
```

**Что даёт Compose:**
- Отдельная сеть проекта с **DNS по именам сервисов**: `api` обращается к `db:5432`.
- Именованные volumes, сборка образов, переменные окружения и `.env`, `profiles` (опциональные сервисы), масштабирование `--scale`.
- Команды: `docker compose up -d`, `ps`, `logs -f api`, `exec db psql`, `down` (удалить контейнеры и сети; `-v` удалит и volumes — **данные пропадут**).
- **Override-файлы**: `compose.yaml` + `compose.override.yaml` (подхватывается автоматически, удобно для локальной разработки) или явно `-f compose.yaml -f compose.prod.yaml`.

**Где использовать:** локальная разработка (поднять приложение со всеми зависимостями одной командой), интеграционные тесты в CI, небольшие сервисы на одной ВМ, демо-стенды.

**Подводные камни:**
- `depends_on` без `condition: service_healthy` гарантирует только **порядок запуска**, а не готовность БД. Приложение всё равно должно уметь ретраить подключение.
- Опубликованные порты `ports: "5432:5432"` слушают **на всех интерфейсах** хоста и обходят ufw. Для внутренних сервисов порты не публиковать или привязывать к `127.0.0.1:5432:5432`.
- Секреты открытым текстом в YAML и `.env` в Git.
- Это **один хост**: нет отказоустойчивости, автоматического переноса при падении ноды, rolling update без простоя, автомасштабирования. Для продакшена с такими требованиями нужен Kubernetes (или Swarm/Nomad). Перевести compose в манифесты помогает Kompose, но обычно манифесты пишут заново.
- Bind-mount кода и права UID внутри и снаружи контейнера.

## Q: Чем 0.0.0.0 отличается от 127.0.0.1? Почему приложение в контейнере недоступно снаружи?
level: middle
type: scenario
freq: 3
tags: сеть, docker, траблшутинг
theory: networking

- **127.0.0.1** (`localhost`, loopback) — адрес, доступный **только изнутри того же сетевого namespace**. Сервис, слушающий `127.0.0.1:8080`, принимает подключения лишь от процессов на этой же машине (или в этом же контейнере или поде).
- **0.0.0.0** в `bind()` означает «**слушать на всех интерфейсах**» (INADDR_ANY): loopback, eth0, docker0 и т.д. Как адрес назначения 0.0.0.0 не используется. В таблице маршрутов `0.0.0.0/0` означает маршрут по умолчанию.
- Для IPv6: `::1` — loopback, `::` — все интерфейсы.

**Классическая проблема в Docker:** приложение внутри контейнера слушает `127.0.0.1:8080` (так по умолчанию делают многие dev-серверы: Flask, Vite, Rails в dev-режиме). `docker run -p 8080:8080` создаёт DNAT с хоста на **eth0 контейнера**, а приложение на eth0 не слушает → `Connection refused` / `connection reset`.

**Решение:** внутри контейнера слушать `0.0.0.0` (`flask run --host=0.0.0.0`, `server.address=0.0.0.0`, `--bind 0.0.0.0:8080`).

**Обратная сторона — безопасность на хосте:** `-p 5432:5432` публикует порт на **0.0.0.0 хоста**, то есть БД доступна из внешней сети. Docker пишет свои правила iptables раньше ufw/firewalld, поэтому файрвол хоста может не помочь. Правильно:
```bash
docker run -p 127.0.0.1:5432:5432 postgres     # доступно только с самого хоста
```
или вообще не публиковать порт, а подключаться через общую docker-сеть по имени сервиса.

**Kubernetes:** то же самое. Контейнер должен слушать 0.0.0.0, иначе Service и пробы kubelet (они ходят на IP пода) не достучатся. Sidecar-контейнеры пода, наоборот, могут общаться через `localhost`, потому что у пода один network namespace (его держит pause-контейнер).

**Диагностика:** `ss -tlnp` внутри контейнера (`docker exec`, `nsenter -t <PID> -n ss -tlnp`) покажет `127.0.0.1:8080` вместо `0.0.0.0:8080` или `*:8080`.

## Q: Напишите Dockerfile для Python/Node.js приложения. Какие ошибки в Dockerfile встречаются чаще всего?
level: middle
type: practice
freq: 3
tags: dockerfile
theory: dockerfile

```dockerfile
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# зависимости отдельным слоем — кешируются, пока не изменился requirements.txt
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

RUN useradd -r -u 10001 app
USER app

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"
CMD ["gunicorn", "-b", "0.0.0.0:8000", "app:app"]
```
Для Node.js то же самое: `FROM node:22-slim`, сначала `COPY package*.json ./` + `RUN npm ci --omit=dev`, потом `COPY . .`, `USER node`, `CMD ["node", "server.js"]`.

**Частые ошибки:**
1. `COPY . .` **до** установки зависимостей → любое изменение кода сбрасывает кеш и зависимости ставятся заново.
2. Нет `.dockerignore` → в образ попадают `.git`, `node_modules`, `.env` с секретами.
3. Тег `latest` в `FROM` → невоспроизводимые сборки. Фиксировать версию (а лучше digest).
4. Запуск от **root**.
5. `apt-get update` и `apt-get install` в **разных** `RUN` → устаревший кеш списков пакетов. Нужно `RUN apt-get update && apt-get install -y --no-install-recommends pkg && rm -rf /var/lib/apt/lists/*`.
6. Секреты через `ARG`/`ENV` или `COPY` → остаются в слоях и истории образа.
7. **Shell-форма** `CMD python app.py` → приложение не получает SIGTERM.
8. Приложение слушает `127.0.0.1` вместо `0.0.0.0`.
9. Сборочные инструменты в финальном образе вместо multi-stage сборки.
10. Много лишних слоёв и мусор (кеши пакетных менеджеров).

Проверка: линтер **hadolint**, сканер Trivy, `docker history` и **dive** для анализа слоёв.

## Q: Какими командами Docker вы пользуетесь каждый день? Как почистить место, занятое Docker?
level: middle
type: practice
freq: 2
tags: docker, cli
theory: lifecycle, images

```bash
docker ps -a                          # контейнеры (все, включая остановленные)
docker images                         # образы
docker run -d --name web -p 8080:80 --restart unless-stopped nginx:1.27
docker logs -f --tail 100 web         # логи
docker exec -it web sh                # зайти внутрь работающего контейнера
docker inspect web                    # вся конфигурация: IP, mounts, env, State
docker inspect -f '{{.State.ExitCode}} {{.State.OOMKilled}}' web
docker stats                          # потребление CPU и памяти в реальном времени
docker cp web:/etc/nginx/nginx.conf . # скопировать файл из контейнера
docker build -t app:1.0 .
docker tag app:1.0 registry.example.com/app:1.0 && docker push registry.example.com/app:1.0
docker stop web && docker rm web      # stop: SIGTERM, через 10 с SIGKILL
docker network ls; docker volume ls
```

**Место на диске** (`/var/lib/docker` — частая причина заполнения диска на CI-раннерах):
```bash
docker system df                      # сколько занимают образы, контейнеры, volumes, кеш сборки
docker container prune                # удалить остановленные контейнеры
docker image prune                    # удалить «висячие» образы (<none>)
docker image prune -a --filter "until=168h"   # все неиспользуемые образы старше недели
docker builder prune                  # кеш BuildKit
docker volume prune                   # ОСТОРОЖНО: удаляет неиспользуемые volumes с данными
docker system prune -a                # всё неиспользуемое разом
```
Ещё одна причина роста — **логи контейнеров** (`/var/lib/docker/containers/*/*-json.log`). Лечится ограничением в `/etc/docker/daemon.json`:
```json
{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "3" } }
```

## Q: Чем COPY отличается от ADD, а ARG от ENV?
level: middle
type: theory
freq: 2
tags: dockerfile
theory: dockerfile

**COPY vs ADD:**
- `COPY` — просто копирует файлы и каталоги из контекста сборки в образ. Предсказуем, **используйте его по умолчанию**.
- `ADD` умеет больше: **автоматически распаковывает** локальные tar-архивы (`.tar`, `.tar.gz`) и может **скачивать по URL**. Это неявное поведение — источник сюрпризов. Скачивание по URL лучше делать через `RUN curl` с проверкой контрольной суммы (или `ADD --checksum=`).
- Оба поддерживают `--chown=user:group` и `--chmod`. `COPY --from=build` копирует из другой стадии multi-stage сборки или из другого образа.

**ARG vs ENV:**
| | ARG | ENV |
|---|---|---|
| Когда доступна | только **во время сборки** | при сборке **и в работающем контейнере** |
| Как задать | `docker build --build-arg VERSION=1.2` | в Dockerfile; переопределяется `docker run -e` |
| Область | от объявления до конца стадии (ARG до `FROM` — только для `FROM`) | наследуется следующими стадиями от того же базового образа и контейнером |

```dockerfile
ARG PYTHON_VERSION=3.12
FROM python:${PYTHON_VERSION}-slim
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}   # передать значение ARG в runtime
LABEL org.opencontainers.image.version=${APP_VERSION}
```

**Важно про секреты:** ни ARG, ни ENV не подходят для паролей и токенов. Значения видны в `docker history` и `docker inspect`. Для секретов на этапе сборки — `RUN --mount=type=secret,id=npmrc ...`, в runtime — переменные окружения из оркестратора или файлы секретов.

## Q: Как работают restart policy и HEALTHCHECK в Docker?
level: middle
type: theory
freq: 2
tags: docker, healthcheck
theory: lifecycle

**Restart policy** — что делать, когда контейнер завершился:
- `no` (по умолчанию) — не перезапускать;
- `on-failure[:N]` — только при ненулевом коде выхода, можно ограничить число попыток;
- `always` — всегда, в том числе после перезапуска демона Docker. Вручную остановленный контейнер поднимется снова при рестарте dockerd;
- `unless-stopped` — как always, но не поднимает контейнер, который вы остановили вручную.

Перезапуски идут с растущей задержкой. Docker **не перезапускает** контейнер, который «завис», но не завершился: для этого нужен healthcheck и внешний механизм.

**HEALTHCHECK** — команда, которую Docker периодически выполняет внутри контейнера:
```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8080/health || exit 1
```
Статус: `starting` → `healthy` / `unhealthy`. Виден в `docker ps` и `docker inspect`.

**Что даёт healthcheck:**
- в docker compose — `depends_on: condition: service_healthy` (дождаться готовности БД);
- в Docker Swarm — замена нездоровых задач;
- сам Docker Engine **не перезапускает** unhealthy-контейнер автоматически (нужен оркестратор или сторонний autoheal).

**В Kubernetes** инструкция `HEALTHCHECK` из Dockerfile **игнорируется**, вместо неё используются liveness, readiness и startup-пробы в манифесте пода.

Подводные камни: в минималистичных образах (distroless) нет `curl`, поэтому нужна проверка встроенным бинарником приложения. Healthcheck должен быть лёгким и не зависеть от внешних систем.

## Q: Что такое Podman и rootless-контейнеры? Чем Podman отличается от Docker?
level: middle
type: theory
freq: 2
tags: podman, rootless, безопасность
theory: runtimes, security

**Podman** — инструмент для запуска контейнеров с **совместимым с Docker CLI** (`alias docker=podman` работает для большинства команд), разработанный Red Hat.

**Ключевые отличия:**
| | Docker | Podman |
|---|---|---|
| Архитектура | клиент → **демон dockerd** (работает от root) → containerd → runc | **без демона**: каждый контейнер — дочерний процесс (через conmon) |
| Права | по умолчанию демон от root; доступ к `docker.sock` = root на хосте | **rootless** по умолчанию для обычного пользователя |
| Поды | нет | есть понятие **pod** (как в Kubernetes), `podman generate kube`, `podman kube play` |
| systemd | через restart policy | интеграция: **Quadlet** — описываете контейнер в unit-подобном файле, systemd управляет им как сервисом |
| Сборка | BuildKit | Buildah (встроен) |
| Compose | docker compose | `podman compose` / podman-compose |

**Rootless-контейнеры** — контейнерный движок и контейнеры работают **от обычного пользователя**. Используются **user namespaces**: root (UID 0) внутри контейнера отображается в непривилегированный UID на хосте (диапазоны в `/etc/subuid` и `/etc/subgid`). Даже при побеге из контейнера злоумышленник получает права обычного пользователя, а не root.

**Ограничения rootless:**
- нельзя напрямую слушать порты < 1024 (настраивается `net.ipv4.ip_unprivileged_port_start`);
- сеть через userspace-стек (slirp4netns или **pasta**) — немного медленнее;
- некоторые volume и права файлов требуют внимания (UID внутри ≠ UID снаружи, опция `:U` или `--userns=keep-id`);
- не все драйверы хранилища и cgroups-функции доступны (нужен cgroup v2 с делегированием).

Docker тоже умеет **rootless mode** (`dockerd-rootless-setuptool.sh`), но это не режим по умолчанию.

**Где важно:** общие серверы и CI-раннеры (сборка образов без привилегированного Docker-in-Docker — **Buildah**, **Kaniko**, BuildKit rootless), требования безопасности, RHEL-экосистема, запуск контейнеров как systemd-сервисов без Kubernetes.

## Q: Что такое тег и digest образа? Как работают реестры и мультиархитектурные образы?
level: middle
type: theory
freq: 2
tags: registry, образы
theory: images

**Полное имя образа:** `registry.example.com/team/api:1.4.2@sha256:9f86d0...`
- **реестр** (по умолчанию `docker.io`), **репозиторий** (`team/api`), **тег** (`1.4.2`, по умолчанию `latest`), **digest** (хеш манифеста).

**Тег — изменяемый указатель.** Тот же тег можно перезаписать другим образом (`docker push` поверх). `latest` — просто тег по умолчанию, а не «последняя версия».
**Digest — неизменяемый** идентификатор содержимого (SHA-256 манифеста). Образ по digest всегда один и тот же.

Поэтому:
- в продакшене использовать **уникальные теги** (git SHA, semver) и включать **неизменяемость тегов** в реестре (ECR, Harbor, GitLab поддерживают);
- для максимальной воспроизводимости и безопасности (подписи, admission-проверки) — **деплой по digest**;
- `imagePullPolicy: IfNotPresent` с перезаписываемым тегом → на разных нодах разные версии.

**Как устроен образ в реестре (OCI):**
- **манифест** — список слоёв (blobs по их digest) и ссылка на конфиг образа;
- слои хранятся и передаются отдельно — общие слои скачиваются один раз и переиспользуются;
- **index (manifest list)** — указатель на манифесты для разных платформ.

**Мультиархитектурные образы:** один тег `api:1.4.2` содержит варианты для `linux/amd64` и `linux/arm64`, рантайм сам выбирает нужный. Важно при использовании ARM-серверов (AWS Graviton, Ampere) и Mac на Apple Silicon у разработчиков.
```bash
docker buildx build --platform linux/amd64,linux/arm64 -t registry/api:1.4.2 --push .
docker buildx imagetools inspect registry/api:1.4.2
```
Ошибка `exec format error` при запуске — образ не той архитектуры.

**Реестры:** Docker Hub (лимиты на скачивание для анонимных пользователей — причина ошибок в CI, решается зеркалом или аутентификацией), Harbor, GitLab Container Registry, ECR, GCR/Artifact Registry, ACR, Yandex Container Registry, Nexus, Artifactory.

**Эксплуатация реестра:** политики очистки старых образов (иначе хранилище растёт бесконечно), сканирование уязвимостей, зеркала (pull-through cache) для внешних реестров, репликация между регионами, OCI-артефакты кроме образов (Helm-чарты, подписи cosign, SBOM).
