---
id: debug
title: Практика: найди ошибку
icon: 🐞
order: 14.2
summary: Сломанные Dockerfile, манифесты, пайплайны, конфиги и скрипты — найдите все проблемы до того, как откроете ответ
---

# Как работать с заданиями

На собеседованиях всё чаще показывают кусок конфигурации или кода и просят найти проблемы. Иногда это делают в live-формате: «вот манифест, под не запускается, почему?». В каждом задании этой темы спрятано **несколько** ошибок разной серьёзности.

### Как отвечать
1. Сначала **прочитайте целиком** и поймите, что код должен делать.
2. Идите **по слоям**: синтаксис → логика → безопасность → надёжность → производительность и стиль.
3. Для каждой проблемы скажите **последствие** («под будет OOMKilled», «секрет попадёт в историю образа»), а не только «так не принято».
4. Расставьте **приоритеты**: что сломает прод сейчас, а что — улучшение.
5. Предложите исправленный вариант.

### Чек-лист типичных ошибок
- **Dockerfile**: порядок слоёв и кеш, root, `latest`, секреты в слоях, shell-форма CMD, нет `.dockerignore`.
- **Kubernetes**: несовпадение меток и селекторов, порты (`port` / `targetPort` / `containerPort`), отсутствие requests и проб, liveness на зависимости, секреты в открытом виде.
- **CI/CD**: секреты в логах, `latest`, нет кеша, нет ручного подтверждения для прода, параллельные деплои.
- **Terraform**: захардкоженные значения, `count` вместо `for_each`, секреты в коде, открытые security groups, нет закрепления версий.
- **Bash**: нет `set -euo pipefail`, нет кавычек, парсинг `ls`, опасные `rm -rf $VAR/`.
- **Конфиги сервисов**: слушают `0.0.0.0` без защиты, таймауты, отсутствие лимитов.

## Q: Найдите проблемы в Dockerfile.
level: middle
type: practice
freq: 3
tags: dockerfile, ревью

Это Dockerfile для Node.js-приложения. Найдите как можно больше проблем:

```dockerfile
FROM node:latest
COPY . /app
WORKDIR /app
ENV NPM_TOKEN=npm_a1b2c3d4e5f6
RUN npm install
RUN apt-get update
RUN apt-get install -y curl vim
EXPOSE 3000
CMD npm start
```

???

1. **`node:latest`** — невоспроизводимая сборка: завтра приедет новая мажорная версия Node, и приложение может сломаться. Нужна фиксированная версия: `node:22-slim` или digest.
2. **Полный образ** `node` весит больше 1 ГБ и содержит лишние пакеты (больше уязвимостей). Лучше `-slim`, `-alpine` или distroless в финальной стадии.
3. **`COPY . /app` до `npm install`** — любое изменение кода сбрасывает кеш слоя, и зависимости ставятся заново на каждой сборке. Сначала `COPY package*.json ./`, потом `npm ci`, потом остальной код.
4. **Нет `.dockerignore`** (подразумевается при `COPY .`) — в образ попадут `node_modules` с хоста, `.git`, `.env`.
5. **`ENV NPM_TOKEN=...`** — **секрет в образе**: виден в `docker history` и `docker inspect` любому, кто скачал образ, и остаётся в контейнере в runtime. Нужно `RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci`. Токен считать скомпрометированным и отозвать.
6. **`npm install`** вместо **`npm ci`**: `install` может изменить lock-файл и поставить другие версии. Плюс ставятся dev-зависимости → `npm ci --omit=dev`.
7. **`apt-get update` и `apt-get install` в разных `RUN`** — слой с update кешируется, и через месяц install будет работать по устаревшим спискам пакетов (ошибки 404). Нужно в одном `RUN` с `--no-install-recommends` и очисткой `/var/lib/apt/lists/*`.
8. **`vim` и `curl` в продакшен-образе** — лишний размер и поверхность атаки. Для отладки есть `kubectl debug` и эфемерные контейнеры.
9. **Запуск от root** — нет `USER`. В образе node есть пользователь `node`.
10. **Shell-форма `CMD npm start`** — PID 1 становится `sh`, а `npm` тоже не пробрасывает сигналы корректно. SIGTERM не дойдёт до приложения, graceful shutdown не сработает. Нужно `CMD ["node", "server.js"]`.
11. Нет `NODE_ENV=production` и `HEALTHCHECK` (для Docker и compose).

Исправленный вариант:
```dockerfile
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

## Q: Под не получает трафик через Service. Найдите ошибки в манифестах.
level: middle
type: practice
freq: 3
tags: kubernetes, service, ревью

Пользователи получают ошибку при обращении к сервису `api`. Найдите все проблемы:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 1
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api-server
    spec:
      containers:
      - name: api
        image: registry.example.com/api:latest
        ports:
        - containerPort: 8080
        env:
        - name: DB_PASSWORD
          value: "P@ssw0rd"
---
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  selector:
    app: api
  ports:
  - port: 80
    targetPort: 80
```

???

**Ошибки, из-за которых не работает:**
1. **Метки шаблона не совпадают с селектором Deployment**: `matchLabels: app: api`, а у пода `app: api-server`. API-сервер **отклонит** такой Deployment с ошибкой `selector does not match template labels`.
2. Даже если исправить метки пода на `api-server`, **Service** выбирает `app: api` → у Service не будет эндпоинтов (`kubectl get endpoints api` пустой) → 503 от Ingress или connection refused. Метки пода, селектор Deployment и селектор Service должны совпадать.
3. **`targetPort: 80`**, а контейнер слушает **8080**. Трафик уходит на порт, где никто не слушает. Нужно `targetPort: 8080` (или именованный порт: `name: http` в контейнере и `targetPort: http`).

**Проблемы надёжности и безопасности:**
4. **`replicas: 1`** — любой рестарт, деплой или обслуживание ноды = простой.
5. **Нет readinessProbe** — трафик пойдёт на под до того, как приложение готово, плюс ошибки при деплое. Нет livenessProbe.
6. **Нет requests и limits** — QoS BestEffort: под выселят первым, планировщик не учитывает его потребление, возможен OOM соседей.
7. **Тег `latest`** — неизвестно, какая версия запущена; при `imagePullPolicy: Always` (по умолчанию для latest) разные поды могут получить разные версии; невозможен нормальный откат.
8. **Пароль открытым текстом в манифесте** — попадёт в Git и виден всем, у кого есть доступ на чтение Deployment. Нужен Secret (`secretKeyRef`), а лучше External Secrets / Vault.
9. Не указан `namespace` — применится в текущий контекст, легко задеплоить не туда.
10. Нет `securityContext` (runAsNonRoot, readOnlyRootFilesystem, drop capabilities).

Диагностика такой проблемы: `kubectl get endpoints api`, `kubectl describe svc api`, `kubectl get pods --show-labels`, `kubectl port-forward pod/<pod> 8080` (работает ли само приложение).

## Q: Под с Java-приложением постоянно перезапускается. Найдите проблемы в манифесте.
level: senior
type: practice
freq: 2
tags: kubernetes, пробы, ресурсы

Spring Boot приложение стартует около 90 секунд. После деплоя поды уходят в CrashLoopBackOff, а иногда все поды перезапускаются одновременно. Фрагмент спецификации контейнера:

```yaml
containers:
- name: orders
  image: registry.example.com/orders:2.3.1
  env:
  - name: JAVA_OPTS
    value: "-Xmx2g"
  resources:
    requests:
      cpu: 100m
      memory: 512Mi
    limits:
      cpu: 500m
      memory: 1Gi
  livenessProbe:
    httpGet:
      path: /actuator/health
      port: 8080
    initialDelaySeconds: 10
    periodSeconds: 5
    timeoutSeconds: 1
    failureThreshold: 3
  readinessProbe:
    httpGet:
      path: /actuator/health
      port: 8080
```

???

1. **`-Xmx2g` при `limits.memory: 1Gi`** — куча JVM может вырасти до 2 ГБ, а cgroup убьёт контейнер на 1 ГБ → **OOMKilled** (код 137). Плюс JVM использует память и вне кучи (metaspace, стеки потоков, direct buffers). Нужно согласовать: `-XX:MaxRAMPercentage=75` вместо фиксированного Xmx, и limit с запасом.
2. **`requests.memory: 512Mi` при limit 1Gi** — для памяти лучше request = limit. Иначе планировщик переупаковывает ноду, и под могут выселить при нехватке памяти на ноде.
3. **Liveness-проба убивает приложение во время старта**: старт занимает ~90 с, а liveness начинается через 10 с и после 3 неудач по 5 с (~25 с) перезапускает контейнер → бесконечный цикл, CrashLoopBackOff. Решение — **startupProbe** (например, `failureThreshold: 30`, `periodSeconds: 5` = до 150 с на старт), liveness включится только после её успеха.
4. **`timeoutSeconds: 1`** — при GC-паузе или нагрузке проба не успевает ответить → ложные перезапуски. Разумно 3–5 с.
5. **Одинаковый эндпоинт `/actuator/health` для liveness и readiness**. По умолчанию он включает проверки **зависимостей** (БД, Redis). Если БД моргнула, liveness падает у **всех** подов одновременно и все перезапускаются — каскадный отказ («иногда все поды перезапускаются одновременно»). Нужно разделить: `/actuator/health/liveness` (только сам процесс) и `/actuator/health/readiness`.
6. **`limits.cpu: 500m` при `requests.cpu: 100m`** — JVM при старте активно использует CPU (JIT, загрузка классов): с маленькой квотой и **throttling** старт затягивается ещё сильнее, плюс паузы под нагрузкой. Нужно поднять requests по факту потребления; многие команды не ставят CPU limit для JVM-сервисов.
7. Не задан `terminationGracePeriodSeconds` и preStop — при деплое возможны ошибки у клиентов (отдельная тема graceful shutdown).

## Q: Найдите проблемы в пайплайне GitLab CI.
level: middle
type: practice
freq: 3
tags: gitlab, ci, безопасность

```yaml
stages: [build, deploy]

variables:
  AWS_ACCESS_KEY_ID: AKIAIOSFODNN7EXAMPLE
  AWS_SECRET_ACCESS_KEY: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

build:
  stage: build
  script:
    - docker build -t registry.example.com/app:latest .
    - docker push registry.example.com/app:latest

deploy_prod:
  stage: deploy
  script:
    - echo "Deploying with key $AWS_SECRET_ACCESS_KEY"
    - kubectl set image deployment/app app=registry.example.com/app:latest
```

???

1. **Облачные ключи открытым текстом в `.gitlab-ci.yml`** — они в Git навсегда и доступны всем, у кого есть доступ к репозиторию. Ключи нужно **немедленно отозвать**. Правильно: OIDC (`id_tokens` + AssumeRoleWithWebIdentity) без статических ключей, или хотя бы Masked + Protected переменные в настройках CI/CD.
2. **`echo` секрета в лог** — даже маскированные переменные можно случайно раскрыть (base64, частичный вывод). Секреты никогда не печатать.
3. **Тег `latest`**:
   - `kubectl set image` с тем же тегом `latest` **ничего не изменит**: спецификация пода не поменялась → rollout не начнётся, поды останутся со старой версией;
   - невозможно понять, какая версия в проде, и откатиться.
   Нужен уникальный тег: `$CI_COMMIT_SHORT_SHA`.
4. **Деплой в прод на каждый коммит в любую ветку** — нет `rules` (только main), нет `when: manual` / approvals, нет `environment` (история деплоев, protected environments).
5. **Нет стадии тестов** — в прод уходит непроверенный код. Нет сканирования образа.
6. **Нет `docker login`** и не указан образ и сервис для джобы сборки (docker-in-docker), нет `kubectl`-образа и контекста кластера — пайплайн просто не заработает на стандартном раннере.
7. Нет `resource_group` — два пайплайна могут деплоить одновременно и обогнать друг друга (старая версия перезапишет новую).
8. Нет проверки результата деплоя: `kubectl rollout status deployment/app --timeout=5m`, иначе джоба «зелёная», даже если поды не поднялись.
9. Нет кеша слоёв для сборки (`--cache-from`), сборка каждый раз с нуля.

## Q: Найдите проблемы в Terraform-коде.
level: senior
type: practice
freq: 2
tags: terraform, ревью, безопасность

```hcl
provider "aws" {
  region     = "eu-central-1"
  access_key = "AKIA..."
  secret_key = "..."
}

variable "servers" {
  default = ["web-1", "web-2", "web-3"]
}

resource "aws_instance" "web" {
  count         = length(var.servers)
  ami           = "ami-0abcdef1234567890"
  instance_type = "t3.medium"
  tags = { Name = var.servers[count.index] }
}

resource "aws_security_group" "web" {
  ingress {
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "main" {
  engine              = "postgres"
  instance_class      = "db.t3.medium"
  allocated_storage   = 50
  username            = "admin"
  password            = "SuperSecret123"
  publicly_accessible = true
  skip_final_snapshot = true
}
```

???

**Безопасность:**
1. **Ключи доступа в коде провайдера** — попадут в Git. Использовать роли, переменные окружения / профили, OIDC в CI.
2. **Security group открывает все TCP-порты всему интернету** — включая SSH и любые внутренние сервисы. Открыть только нужные порты (443 от балансировщика), SSH — только из VPN или вообще через SSM.
3. **Пароль БД в коде** — и в Git, и в state. Использовать `manage_master_user_password = true` (Secrets Manager) или генерацию + хранилище секретов.
4. **`publicly_accessible = true`** — БД доступна из интернета. Должна быть в приватной подсети.
5. Нет шифрования (`storage_encrypted = true`), нет ограничения IMDSv2 у инстансов (`metadata_options { http_tokens = "required" }`).

**Надёжность:**
6. **`skip_final_snapshot = true`** — при удалении или пересоздании БД данные исчезнут без снапшота. Плюс нет `deletion_protection = true`, `backup_retention_period`, `multi_az`, `lifecycle { prevent_destroy = true }`.
7. **`count` со списком** — если удалить `web-1` из середины списка, индексы сдвинутся, и Terraform **пересоздаст** `web-2` и `web-3`. Нужен `for_each = toset(var.servers)`.
8. **Захардкоженный AMI** — регион-зависимый, устаревает. Лучше `data "aws_ami"` или параметр.

**Качество и сопровождаемость:**
9. Нет блока `terraform` с **`required_providers` и версиями** — следующий `init` может притащить новую мажорную версию провайдера с breaking changes.
10. Нет **remote backend** — state лежит локально, нет блокировок и командной работы.
11. Не указаны `vpc_security_group_ids`, `subnet_id`, `db_subnet_group_name` — ресурсы окажутся в default VPC, а SG не привязана к инстансам.
12. У переменной нет `type` и `description`, нет общих тегов (`default_tags` в провайдере).

## Q: Найдите ошибки в bash-скрипте очистки.
level: middle
type: practice
freq: 3
tags: bash, ревью

Скрипт удаляет старые файлы загрузок приложения. Что может пойти не так?

```bash
#!/bin/bash
UPLOAD_DIR=$1
cd $UPLOAD_DIR
for f in $(ls *.tmp); do
  rm $f
done
rm -rf $UPLOAD_DIR/cache/*
find $UPLOAD_DIR -mtime +30 | xargs rm
echo "Cleanup done"
```

???

1. **Нет проверки аргумента и нет `set -u`**: если запустить без аргумента, `UPLOAD_DIR` пустая → `cd` уходит в домашний каталог, а `rm -rf $UPLOAD_DIR/cache/*` превращается в **`rm -rf /cache/*`**; `find $UPLOAD_DIR` без аргумента ищет **в текущем каталоге**, то есть в домашнем, и удаляет все файлы старше 30 дней. Классическая причина катастроф.
2. **Нет `set -e` и проверки `cd`**: если `cd` не удался (опечатка в пути, нет прав), скрипт продолжит выполнение **в другом каталоге** и удалит чужие `.tmp` файлы. Нужно `cd "$UPLOAD_DIR" || exit 1`.
3. **Переменные без кавычек**: путь с пробелом (`/data/my uploads`) разобьётся на два аргумента.
4. **`for f in $(ls *.tmp)`** — парсинг вывода `ls`: ломается на пробелах и спецсимволах в именах; если файлов нет, glob остаётся буквальной строкой `*.tmp`. Правильно: `for f in ./*.tmp; do [[ -e $f ]] || continue; rm -- "$f"; done` или просто `find`.
5. **`rm $f` без `--`** — файл с именем `-rf` будет воспринят как опция.
6. **`find ... | xargs rm`** — ломается на именах с пробелами и переводами строк; находит и **каталоги** (rm на них упадёт, а `-mtime` у каталога меняется при изменении содержимого). Нужно `find "$UPLOAD_DIR" -type f -mtime +30 -delete` (или `-print0 | xargs -0 rm --`).
7. **`echo "Cleanup done"`** выводится даже при ошибках — скрипт всегда завершается с кодом 0, мониторинг не узнает о сбоях.
8. Нет логирования того, что удалено, нет режима dry-run, нет защиты от параллельного запуска (`flock`).

Исправленный каркас:
```bash
#!/usr/bin/env bash
set -euo pipefail
UPLOAD_DIR=${1:?usage: $0 <upload_dir>}
[[ -d "$UPLOAD_DIR" && "$UPLOAD_DIR" != "/" ]] || { echo "bad dir: $UPLOAD_DIR" >&2; exit 1; }
find "$UPLOAD_DIR" -maxdepth 1 -type f -name '*.tmp' -print -delete
find "$UPLOAD_DIR/cache" -mindepth 1 -delete
find "$UPLOAD_DIR" -type f -mtime +30 -print -delete
```

## Q: Найдите ошибки в конфигурации nginx.
level: middle
type: practice
freq: 2
tags: nginx, ревью

Фронтенд отдаётся нормально, а API отвечает 404, в логах бэкенда видны запросы на неожиданные пути, приложение показывает IP балансировщика вместо IP клиентов, а загрузка файлов больше 1 МБ падает.

```nginx
server {
    listen 80;
    server_name shop.example.com;

    location / {
        root /var/www/shop;
        index index.html;
    }

    location /api {
        proxy_pass http://127.0.0.1:8080/;
    }
}
```

???

1. **`location /api` + `proxy_pass` со слешем на конце**. Слеш в `proxy_pass` означает «заменить совпавшую часть URI»: `/api/users` → `//users`, `/api` → `/`. Бэкенд, ожидающий `/api/users`, отвечает 404. Варианты: `location /api/ { proxy_pass http://127.0.0.1:8080; }` (без слеша — путь передаётся как есть) или осознанно `location /api/ { proxy_pass http://127.0.0.1:8080/; }`, если бэкенд ждёт пути без префикса.
2. **`location /api` без слеша** совпадёт и с `/apiary`, `/api-docs` — лучше `location /api/`.
3. **Не передаются заголовки**: бэкенд видит `Host: 127.0.0.1:8080` и IP nginx. Нужно:
   ```nginx
   proxy_set_header Host $host;
   proxy_set_header X-Real-IP $remote_addr;
   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   proxy_set_header X-Forwarded-Proto $scheme;
   ```
   Если перед nginx стоит ещё балансировщик, нужен `real_ip_header` / `set_real_ip_from`.
4. **`client_max_body_size`** по умолчанию **1 МБ** → загрузка больших файлов даёт `413 Request Entity Too Large`.
5. **Нет HTTPS**: только порт 80, нет редиректа и сертификата.
6. **SPA**: при обновлении страницы по клиентскому маршруту (`/orders/42`) будет 404 — нужно `try_files $uri $uri/ /index.html;`.
7. Не настроены таймауты прокси (`proxy_read_timeout`), keepalive к апстриму (`proxy_http_version 1.1` + `proxy_set_header Connection ""`), кеширование статики (`expires`).
8. Один бэкенд `127.0.0.1:8080` без `upstream` — нет отказоустойчивости.

## Q: Найдите проблемы в Ansible-плейбуке.
level: middle
type: practice
freq: 2
tags: ansible, ревью

```yaml
- hosts: all
  tasks:
    - name: Install nginx
      shell: apt-get install -y nginx

    - name: Copy config
      copy:
        src: nginx.conf
        dest: /etc/nginx/nginx.conf

    - name: Restart nginx
      shell: systemctl restart nginx

    - name: Set DB password
      lineinfile:
        path: /etc/app/config.ini
        line: "db_password=Qwerty123"
```

???

1. **`hosts: all`** — плейбук применится ко **всем** хостам inventory, включая базы данных и прод другого проекта. Указать конкретную группу (`hosts: web`).
2. **Нет `become: true`** — установка пакетов и запись в `/etc` требуют root, задачи упадут с ошибкой прав (или их запускают от root по SSH, что ещё хуже).
3. **`shell: apt-get install`** вместо модуля `apt` — неидемпотентно (всегда `changed`), нет `update_cache`, не учитывается состояние. Правильно: `ansible.builtin.apt: name=nginx state=present update_cache=true`.
4. **Безусловный рестарт nginx** через `shell` при каждом запуске — лишний простой и сброс соединений, даже если конфиг не менялся. Нужен **handler** с `notify` от задачи копирования конфига и `state: reloaded`.
5. **Конфиг копируется без проверки**: ошибка в `nginx.conf` → nginx не перезапустится, сайт ляжет. Нужно `validate: nginx -t -c %s`, а также `owner`, `group`, `mode`, `backup: true`.
6. **Пароль открытым текстом** в плейбуке → в Git. Использовать **Ansible Vault** или lookup из Vault/секрет-хранилища, `no_log: true` для задач с секретами.
7. **`lineinfile` без `regexp`** — при смене пароля добавится **вторая** строка `db_password=...` вместо замены. Нужно `regexp: '^db_password='`. А для целого конфигурационного файла лучше `template`.
8. Нет полных имён модулей (`ansible.builtin.copy`), нет тегов, нет `serial` для поэтапного применения на группе серверов — все nginx перезапустятся одновременно.

## Q: Найдите ошибки в PromQL-запросах и алерте.
level: senior
type: practice
freq: 2
tags: promql, алертинг

Дашборд показывает странные значения, а алерт срабатывает постоянно или не срабатывает вообще.

```promql
# 1. RPS сервиса
rate(sum(http_requests_total{job="api"})[5m])

# 2. Доля ошибок
sum(rate(http_requests_total{status="500"}[5m])) / sum(rate(http_requests_total[5m]))

# 3. p99 латентности
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[1m]))

# 4. Алерт: сервис недоступен
- alert: ApiDown
  expr: http_requests_total{job="api"} == 0
```

???

1. **`rate(sum(...))`** — неправильный порядок. Сначала `rate` по каждому ряду (он корректно обрабатывает сбросы счётчика при рестарте пода), потом `sum`: `sum(rate(http_requests_total{job="api"}[5m]))`. Сумма счётчиков разных подов при рестарте одного из них «проваливается», и rate даёт мусор (к тому же такая конструкция требует subquery).
2. **Доля ошибок**:
   - `status="500"` ловит только 500, а 502, 503, 504 — нет. Нужно `code=~"5.."` (и проверить реальное имя метки — `code` или `status`);
   - в числителе и знаменателе нет фильтра `job="api"` — делим ошибки одного сервиса на трафик **всех** сервисов;
   - если ошибок нет совсем, числитель пустой → результат пустой, а не 0 (для дашборда можно `or vector(0)`).
3. **`histogram_quantile` без агрегации по `le`**: квантиль считается отдельно для каждого пода и каждой метки. Нужно `histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{job="api"}[5m])))`. Окно `[1m]` при scrape interval 30 с даёт всего 2 точки — шумно и с пропусками; окно должно быть хотя бы в 4 раза больше интервала сбора.
4. **Алерт `http_requests_total == 0`**:
   - счётчик — **накопительное** значение, он почти никогда не равен 0 (только сразу после рестарта) → алерт практически не сработает;
   - если сервис упал полностью, ряда вообще **нет** (а не 0), и выражение вернёт пустой результат → алерт молчит, когда он нужнее всего;
   - нет `for:` → флапы, нет `labels.severity` и `annotations` с runbook.
   Правильнее: `up{job="api"} == 0` (Prometheus не может собрать метрики), `absent(up{job="api"})` (цель исчезла из service discovery), алерт по доле ошибок и по SLO, а также внешняя проверка через blackbox_exporter.

## Q: Найдите проблемы в systemd unit-файле.
level: middle
type: practice
freq: 2
tags: systemd, ревью

Сервис иногда не стартует после перезагрузки, после падения не поднимается, а `systemctl stop` занимает 90 секунд.

```ini
[Unit]
Description=Payment worker

[Service]
ExecStart=/opt/worker/run.sh
User=root
Environment=DB_PASSWORD=secret

[Install]
WantedBy=default.target
```
Содержимое `run.sh`:
```bash
#!/bin/bash
cd /opt/worker
source venv/bin/activate
python worker.py &
```

???

1. **`run.sh` запускает Python в фоне (`&`) и сразу завершается.** С `Type=simple` (по умолчанию) systemd считает, что главный процесс — скрипт; когда он выходит, systemd считает сервис завершённым и **убивает** оставшиеся процессы cgroup (или сервис «работает» без контроля). Нужно запускать процесс на переднем плане через `exec`: `exec python worker.py`, или указывать `ExecStart=/opt/worker/venv/bin/python worker.py` напрямую.
2. **Нет `Restart=`** — после падения сервис не поднимается. Добавить `Restart=on-failure` и `RestartSec=5`.
3. **Нет зависимостей от сети**: worker стартует раньше сети и БД → падает при загрузке. Нужно `After=network-online.target` + `Wants=network-online.target` (и `After=postgresql.service`, если БД локальная); само приложение тоже должно уметь ретраить подключение.
4. **`WantedBy=default.target`** — для системного сервиса принято `multi-user.target` (default.target может указывать на graphical и вообще чаще используется в пользовательских юнитах).
5. **`User=root`** — платёжный воркер не должен работать от root. Отдельный пользователь (`User=worker`, или `DynamicUser=yes`) + sandboxing: `NoNewPrivileges=yes`, `ProtectSystem=strict`, `PrivateTmp=yes`.
6. **Пароль в `Environment=`** — виден любому пользователю через `systemctl show` и в unit-файле. Использовать `EnvironmentFile=` с правами 600, `LoadCredential=` (systemd credentials) или секрет-хранилище.
7. **90 секунд на остановку**: SIGTERM получает bash-скрипт (или не получает никто из-за фонового процесса), Python не узнаёт о завершении, systemd ждёт `TimeoutStopSec` (90 с по умолчанию) и шлёт SIGKILL. С `exec` и обработкой SIGTERM в приложении остановка станет корректной; для воркера платежей это важно, чтобы не обрывать транзакции на середине.
8. Нет `WorkingDirectory=` (вместо `cd` в скрипте) и лимитов ресурсов (`MemoryMax`, `LimitNOFILE`).

После правок — `systemctl daemon-reload`, проверка `systemd-analyze verify worker.service` и `systemd-analyze security worker.service`.

## Q: Найдите проблемы в миграции базы данных, которая положила прод.
level: senior
type: practice
freq: 2
tags: postgresql, миграции

Миграция запускается при старте каждого пода приложения. Таблица `orders` — 200 млн строк, нагрузка — тысячи запросов в секунду. После деплоя сервис был недоступен 40 минут.

```sql
BEGIN;
ALTER TABLE orders ADD COLUMN status_code integer NOT NULL DEFAULT 0;
UPDATE orders SET status_code = 1 WHERE status = 'paid';
CREATE INDEX idx_orders_status_code ON orders (status_code);
ALTER TABLE orders DROP COLUMN status;
COMMIT;
```

???

1. **Миграция при старте каждого пода** — несколько реплик одновременно пытаются выполнить одну и ту же миграцию: гонки, блокировки, ошибки. Миграции запускаются **один раз** отдельной джобой (Job / hook / шаг пайплайна) с блокировкой (инструменты миграций это умеют).
2. **Всё в одной транзакции** — блокировки, взятые первым `ALTER TABLE` (`ACCESS EXCLUSIVE`), держатся **до COMMIT**, то есть всё время `UPDATE` 200 млн строк и построения индекса. Все запросы к `orders`, включая чтение, ждут → простой.
3. **Очередь блокировок**: даже короткий `ALTER TABLE` ждёт завершения текущих долгих запросов, а все новые запросы встают в очередь **за ним**. Нужно `SET lock_timeout = '5s'` и ретраи миграции.
4. **`UPDATE` всей таблицы одним оператором** — огромная транзакция, миллионы новых версий строк (bloat), нагрузка на WAL и репликацию (лаг реплик). Делать **батчами** по 10–50 тысяч строк в отдельных транзакциях.
5. **`CREATE INDEX` без `CONCURRENTLY`** — блокирует запись в таблицу на всё время построения. Нужно `CREATE INDEX CONCURRENTLY` (вне транзакции; при неудаче остаётся невалидный индекс, который нужно удалить и создать заново).
6. **`DROP COLUMN status` в том же релизе** — старая версия приложения (поды, которые ещё работают во время rolling update) продолжает читать `status` → ошибки. Откатиться на предыдущую версию тоже невозможно. Удаление колонки — отдельным релизом позже (**expand → migrate → contract**).
7. `ADD COLUMN ... NOT NULL DEFAULT 0` в современных PostgreSQL (11+) выполняется быстро (без перезаписи таблицы), но всё равно требует короткой эксклюзивной блокировки — снова важен `lock_timeout`.
8. Не было проверки миграции на копии продакшен-данных (staging с реалистичным объёмом) и плана отката.

Правильная последовательность: релиз 1 — `ADD COLUMN` (с lock_timeout) → фоновый backfill батчами → `CREATE INDEX CONCURRENTLY` → релиз 2 — приложение читает и пишет `status_code` → релиз 3 — `DROP COLUMN status`.

## Q: Найдите проблемы в docker-compose.yml для продакшена.
level: middle
type: practice
freq: 2
tags: docker-compose, ревью

Этот файл используется для запуска сервиса на продакшен-сервере.

```yaml
services:
  app:
    image: myapp:latest
    ports:
      - "8000:8000"
    depends_on:
      - db
    environment:
      - DATABASE_URL=postgres://postgres:postgres@db:5432/app
  db:
    image: postgres
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_PASSWORD=postgres
  redis:
    image: redis
    ports:
      - "6379:6379"
```

???

1. **БД и Redis опубликованы на все интерфейсы хоста** (`5432:5432`, `6379:6379`) — доступны из интернета, причём Docker обходит ufw/firewalld. Redis без пароля — классический вектор взлома (запись SSH-ключей, майнеры). Убрать `ports` у внутренних сервисов (приложение ходит к ним по имени в docker-сети) или привязать к `127.0.0.1`.
2. **Нет volume у PostgreSQL** — данные живут в слое контейнера: `docker compose down` или пересоздание контейнера **удалит базу**. Нужен именованный volume на `/var/lib/postgresql/data` и бэкапы.
3. **Теги `latest` и без тегов** (`postgres`, `redis`) — при `pull` может приехать новая мажорная версия PostgreSQL, которая **не запустится на старых файлах данных** (несовместимый формат между мажорными версиями).
4. **Слабые пароли открытым текстом**, пользователь `postgres` (суперпользователь) для приложения. Нужны `.env` вне Git или Docker secrets, отдельный пользователь БД с ограниченными правами.
5. **`depends_on` без healthcheck** — гарантирует только порядок запуска: приложение стартует раньше, чем PostgreSQL готов принимать подключения, и падает. Нужен `healthcheck` у db и `condition: service_healthy` (и ретраи в приложении).
6. **Нет `restart: unless-stopped`** — после перезагрузки сервера или падения сервисы не поднимутся.
7. **Нет ограничения логов** — json-file логи растут бесконечно и заполняют диск (`logging.options.max-size`).
8. **Нет лимитов ресурсов** (`mem_limit`, `cpus`): утечка памяти в одном сервисе положит весь сервер.
9. Приложение опубликовано напрямую на 8000 без reverse proxy и TLS.
10. В целом compose на одном сервере — единая точка отказа. Для продакшена с требованиями к доступности стоит рассмотреть Kubernetes или хотя бы managed-БД.
