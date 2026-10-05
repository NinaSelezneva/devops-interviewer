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

1. `docker ps -a` — код выхода (`Exited (137)`, `Exited (1)`).
   - **137** = 128 + 9 (SIGKILL) — часто **OOM** (`docker inspect` → `State.OOMKilled: true`) или принудительная остановка.
   - **143** = SIGTERM, **139** = SIGSEGV, **1** — ошибка приложения, **126/127** — нет прав на запуск / команда не найдена.
2. `docker logs <id>` (и `--previous` / `kubectl logs -p` в k8s) — ошибка конфигурации, нет переменных окружения, не доступна БД.
3. `docker inspect` — фактические entrypoint/cmd, env, монтирования, healthcheck.
4. Запустить интерактивно, переопределив entrypoint: `docker run -it --entrypoint sh image` и выполнить команду вручную.
5. Проверить архитектуру образа (`exec format error` — arm64-образ на amd64 ноде).
6. Проверить, не завершается ли процесс «нормально»: контейнер живёт, пока жив PID 1, — демон, уходящий в фон (`nginx` без `daemon off`), завершит контейнер.
