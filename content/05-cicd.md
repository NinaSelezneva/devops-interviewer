---
id: cicd
title: CI/CD и GitOps
icon: 🚀
order: 5
summary: Дизайн пайплайнов, стратегии деплоя, GitOps, безопасность поставки
---

# Ключевые концепции

- **Continuous Integration** — частое слияние изменений в основную ветку с автоматической сборкой и тестами. Цель — быстро находить ошибки интеграции.
- **Continuous Delivery** — любой коммит в main **готов к выкладке** в прод; выкладка — по кнопке.
- **Continuous Deployment** — каждое успешное изменение **автоматически** уходит в прод.

### Типичный пайплайн
```
commit → lint/SAST → unit-тесты → сборка артефакта (образ) → скан, SBOM, подпись
      → публикация в registry → deploy dev → интеграционные/e2e → deploy staging
      → (approve) → canary/prod → проверка метрик → полный rollout / rollback
```

### Принципы senior-уровня
- **Build once, deploy many** — один и тот же неизменяемый артефакт (по digest) продвигается по окружениям; различается только конфигурация.
- Быстрая обратная связь: целевое время CI < 10 минут.
- Пайплайн как код, переиспользуемые шаблоны.
- Безопасность цепочки поставок: секреты, OIDC, подписи, SLSA.
- Метрики **DORA**: deployment frequency, lead time for changes, change failure rate, time to restore (MTTR).

## Q: Спроектируйте CI/CD с нуля для команды, которая сейчас деплоит вручную.
level: senior
type: design
freq: 3
tags: дизайн, пайплайн

Хороший ответ — **поэтапный план**, а не «поставлю Jenkins».

**1. Понять контекст**: стек, количество сервисов и команд, куда деплоим (VM, k8s, serverless), требования к compliance, текущие боли (долгие релизы, падения после выкладки).

**2. Основа**
- Git как единый источник, защищённая main-ветка, merge request + code review, trunk-based или короткоживущие ветки.
- CI на каждый MR: линтеры, unit-тесты, сборка, SAST и сканирование зависимостей. Результат — статус в MR, блокировка мержа при падении.

**3. Артефакты**
- Сборка **один раз** в неизменяемый артефакт (Docker-образ с тегом = git SHA, + semver для релизов), хранение в registry (Harbor, ECR, Nexus).
- Скан образа, SBOM, подпись.

**4. Доставка**
- Окружения dev → staging → prod с одинаковыми манифестами (Helm/Kustomize) и разными значениями.
- Для k8s — **GitOps** (ArgoCD/Flux): CI обновляет версию в репозитории конфигурации, CD-агент синхронизирует.
- Автоматический деплой в dev, промоут в prod через MR/approve.
- Прогрессивные стратегии (canary), автоматический откат по метрикам (Argo Rollouts, Flagger).

**5. Конфигурация и секреты** — вне образа: Vault/External Secrets, OIDC вместо статических ключей.

**6. Наблюдаемость** — дашборд DORA-метрик, аннотации деплоев на графиках, алерты.

**7. Внедрение** — начать с одного пилотного сервиса, сделать шаблон, обучить команды, мигрировать остальные. Показать бизнес-эффект через метрики.

## Q: Какие стратегии деплоя вы знаете? Плюсы и минусы.
level: middle
type: theory
freq: 3
tags: деплой

| Стратегия | Как работает | Плюсы | Минусы |
|---|---|---|---|
| **Recreate** | удалить старое, поднять новое | просто, нет двух версий одновременно | даунтайм |
| **Rolling** | постепенная замена экземпляров | без даунтайма, по умолчанию в k8s | две версии одновременно, откат медленный |
| **Blue-Green** | поднять полную копию (green), переключить трафик | мгновенное переключение и откат, тест прод-окружения | двойные ресурсы, сложно с БД и stateful |
| **Canary** | малый процент трафика на новую версию, рост по метрикам | минимальный радиус поражения, проверка на реальных пользователях | нужна зрелая наблюдаемость и L7-маршрутизация |
| **A/B** | маршрутизация по признакам пользователя | эксперименты с бизнес-метриками | сложность, это скорее продуктовая практика |
| **Shadow (mirroring)** | копия трафика на новую версию, ответы отбрасываются | тест под реальной нагрузкой без влияния | побочные эффекты (запись в БД, платежи) |

Отдельно — **feature flags**: разделение *деплоя* и *релиза*. Код выкатывается выключенным, включается для части пользователей; откат = выключить флаг. Нужна дисциплина удаления старых флагов.

Общая проблема всех стратегий — **БД-миграции**: схема должна быть совместима с обеими версиями приложения.

## Q: Как делать миграции БД при деплое без даунтайма и с возможностью отката?
level: senior
type: scenario
freq: 3
tags: деплой, бд

Паттерн **expand / contract** (parallel change). Пример: переименование колонки `name` → `full_name`:

1. **Expand**: добавить новую колонку `full_name` (nullable). Старая версия приложения её не замечает. Миграция обратно совместима.
2. Новая версия приложения **пишет в обе** колонки, читает из новой с фолбэком.
3. **Backfill** данных батчами (не одной транзакцией на миллионы строк).
4. Переключить чтение на новую колонку полностью.
5. **Contract**: в следующем релизе (когда откат на старую версию уже не нужен) удалить старую колонку.

Правила:
- Миграции **отделены** от запуска приложения (Job/hook перед деплоем, а не при старте каждой реплики — иначе гонки).
- Никаких деструктивных изменений в том же релизе, что и код, который от них зависит.
- Осторожно с блокировками: `CREATE INDEX CONCURRENTLY` в PostgreSQL, `ALTER TABLE` на больших таблицах — через gh-ost/pt-online-schema-change в MySQL; `lock_timeout`.
- Инструменты: Flyway, Liquibase, Alembic, golang-migrate, Atlas.
- **Откат кода** возможен всегда; **откат схемы** — редко безопасен, поэтому стратегия — roll forward.

## Q: Пайплайн выполняется 40 минут. Как вы его ускорите?
level: senior
type: scenario
freq: 3
tags: оптимизация

Сначала **измерить**: какие джобы самые долгие, где ожидание раннеров, где критический путь.

Приёмы:
1. **Параллелизм**: DAG вместо строгих стадий (`needs:` в GitLab), разбиение тестов на шарды (`parallel:`), матричные сборки.
2. **Кеширование**: зависимости (npm, maven, go mod, pip) с ключом по lock-файлу; кеш слоёв Docker (BuildKit `--cache-from/--cache-to type=registry`); кеш компиляции (ccache, Gradle build cache, Bazel remote cache).
3. **Делать меньше**: запускать только затронутое (`rules: changes:`, монорепо-инструменты Nx/Turborepo/Bazel), тяжёлые e2e — ночью или перед мержем, а не на каждый пуш.
4. **Раннеры**: достаточная мощность, автоскейлинг (k8s executor, spot), тёплые кеши, близость к registry; избавиться от очередей.
5. **Оптимизация тестов**: найти медленные и флапающие; заменить sleep на ожидание условий; testcontainers с переиспользованием.
6. **Сборка образов**: правильный порядок слоёв в Dockerfile, multi-stage, меньшие базы.
7. **Fail fast**: линтеры и быстрые тесты первыми, `interruptible` для устаревших пайплайнов.

Отслеживать метрику длительности пайплайна во времени, чтобы она не деградировала снова.

## Q: Что такое GitOps? Push vs Pull модель.
level: senior
type: theory
freq: 3
tags: gitops, argocd

**GitOps** — практика, где **Git — единственный источник истины** о желаемом состоянии инфраструктуры и приложений, а специальный агент непрерывно **согласовывает** кластер с Git.

Принципы (OpenGitOps): декларативность, версионирование и неизменяемость, автоматическое вытягивание (pull), непрерывное согласование.

**Push-модель** (классический CI/CD): CI-система выполняет `kubectl apply`/`helm upgrade`. Минусы: CI нужны административные креды к кластеру, дрейф не обнаруживается, сложно понять, что реально задеплоено.

**Pull-модель** (ArgoCD, Flux): агент внутри кластера следит за репозиторием и применяет изменения. Плюсы:
- кластерные креды не покидают кластер;
- автоматическое обнаружение и исправление **дрейфа** (self-heal);
- аудит и откат через `git revert`;
- единая картина всех окружений.

Сложности: секреты в Git (Sealed Secrets, SOPS, External Secrets Operator), продвижение версий между окружениями (структура репозиториев, image updater или коммит из CI), порядок применения (sync waves), не всё удобно выражается декларативно (миграции, одноразовые операции).

Типовая схема: CI собирает образ → коммитит новый тег в репозиторий конфигурации (или MR для prod) → ArgoCD синхронизирует.

## Q: Как обеспечить безопасность CI/CD и цепочки поставок ПО?
level: senior
type: practice
freq: 3
tags: безопасность, supply-chain

Угрозы: утечка секретов из CI, компрометация зависимостей (typosquatting, вредоносные обновления), подмена артефактов, выполнение кода из форков в привилегированных раннерах.

Меры:
- **Секреты**: не хранить в репозитории (pre-commit gitleaks, push protection), маскирование в логах, protected-переменные только для защищённых веток, короткоживущие креды через **OIDC** (GitLab/GitHub → AWS/GCP/Vault без статических ключей).
- **Раннеры**: изолированные эфемерные раннеры, отдельные раннеры для prod-деплоя, не запускать пайплайны из форков с секретами (`pull_request_target` в GitHub — классическая уязвимость).
- **Зависимости**: lock-файлы, закрепление версий (actions — по SHA), прокси-реестр (Nexus/Artifactory), SCA (Dependabot, Renovate, Snyk, Trivy).
- **Артефакты**: SBOM (Syft, CycloneDX/SPDX), **подпись** образов (cosign), provenance-аттестации (**SLSA**), проверка подписи при деплое (Kyverno/Connaisseur), деплой по digest.
- **Проверки кода**: SAST (Semgrep, SonarQube), сканирование IaC (Checkov, tfsec/Trivy), DAST на staging.
- **Процесс**: обязательный code review, защищённые ветки, разделение прав (кто может деплоить в прод), аудит-лог.

## Q: Чем кеш отличается от артефактов в GitLab CI? Расскажите о ключевых возможностях GitLab CI.
level: middle
type: practice
freq: 2
tags: gitlab

- **cache** — для ускорения: зависимости, переиспользуемые между **пайплайнами**. Не гарантирован, может отсутствовать. Ключ по lock-файлу: `cache: key: files: [package-lock.json]`.
- **artifacts** — результаты джобы, передаваемые **следующим джобам того же пайплайна** и доступные для скачивания: бинарники, отчёты тестов (`reports: junit`), покрытие. Гарантированы, имеют `expire_in`.

Ключевые возможности:
- `stages` и **`needs`** (DAG — джоба стартует сразу по завершении зависимостей);
- **`rules`** (условия по веткам, переменным, изменённым файлам) вместо устаревших `only/except`;
- **`include`** (`local`, `project`, `remote`, `template`, `component`) и `extends`, YAML-якоря — переиспользуемые шаблоны, CI/CD Components и каталог;
- **`environment`** с URL, `when: manual`, protected environments и approvals;
- **parent-child** и **multi-project** пайплайны (`trigger`), динамически сгенерированные дочерние пайплайны для монорепо;
- `parallel` и `parallel:matrix`;
- `resource_group` — не допускать параллельных деплоев в одно окружение;
- `interruptible`, `retry`, `timeout`;
- раннеры: shell, docker, kubernetes executor, теги для выбора раннера;
- ID-токены (`id_tokens`) для OIDC.

## Q: Как организовать версионирование и продвижение артефактов между окружениями?
level: senior
type: design
freq: 2
tags: артефакты, релизы

Принципы:
- **Неизменяемые артефакты**: тег никогда не переписывается; `latest` не используется для деплоя. В проде фиксируем **digest** (`sha256:…`).
- **Build once**: образ, протестированный в staging, — ровно тот же, что уходит в prod. Пересборка под каждое окружение ломает гарантии.
- Конфигурация окружений — отдельно от артефакта (env, ConfigMap, Helm values, Kustomize overlays).

Схема тегов: `git SHA` для каждой сборки + **SemVer** (`v1.4.2`) для релизов; дополнительные метаданные — лейблы OCI (`org.opencontainers.image.revision`, `source`).

Продвижение:
- В GitOps — изменение версии в каталоге окружения (`envs/prod/values.yaml`) через MR с ревью; инструменты Kargo, Argo CD Image Updater.
- Реестры с разделением на «dev» и «release» репозитории с политиками иммутабельности и очистки.
- Changelog генерируется автоматически (Conventional Commits + semantic-release/release-please).

Откат = деплой предыдущей версии (`git revert` в репозитории конфигурации), а не пересборка.

## Q: Как организовать CI/CD для монорепозитория с десятками сервисов?
level: senior
type: design
freq: 1
tags: монорепо

Проблемы: пайплайн собирает всё на каждое изменение, огромное время, конфликтующие правила.

Решения:
- **Сборка только затронутого**: `rules: changes` в GitLab, path-фильтры в GitHub Actions; продвинутые инструменты строят граф зависимостей — Nx, Turborepo, Bazel, Pants (учитывают, что изменение общей библиотеки затрагивает все зависящие сервисы).
- **Динамические дочерние пайплайны**: генерация YAML скриптом под набор изменённых сервисов.
- Общие шаблоны джоб (`include`/components), сервис объявляет только специфику.
- Удалённый кеш сборки (Bazel remote cache) — повторно не собирается то, что уже собрано кем-то.
- Независимые версии и деплой сервисов, CODEOWNERS для ревью.

Сравнение с polyrepo: монорепо упрощает атомарные изменения через несколько сервисов и переиспользование кода, но требует инструментов и культуры; polyrepo проще в CI, но сложнее с согласованием версий и общими изменениями.

## Q: Что такое репозиторий артефактов (Artifactory, Nexus, Harbor)? Зачем он нужен?
level: middle
type: theory
freq: 2
tags: artifactory, nexus, артефакты

**Репозиторий артефактов** — централизованное хранилище результатов сборки и зависимостей: Docker-образы, Helm-чарты, jar/npm/PyPI/Go-пакеты, deb/rpm, бинарники, Terraform-провайдеры.

Продукты: **JFrog Artifactory** (универсальный, коммерческий, есть OSS-версия), **Sonatype Nexus Repository** (популярен в on-prem, есть бесплатная версия), **Harbor** (CNCF, только OCI: образы и чарты, сканирование, подписи), облачные: AWS ECR/CodeArtifact, GCP Artifact Registry, GitLab Package/Container Registry.

**Типы репозиториев** (терминология Artifactory/Nexus):
- **local / hosted** — ваши собственные артефакты (результаты CI);
- **remote / proxy** — кеширующий прокси к внешним реестрам (Maven Central, npmjs, PyPI, Docker Hub);
- **virtual / group** — единая точка входа, объединяющая несколько local и remote репозиториев.

**Зачем это нужно:**
- **Надёжность и скорость сборок**: зависимости берутся из локального кеша. Сборки не ломаются при падении внешнего реестра, rate limit Docker Hub или удалении пакета автором (история с left-pad в npm).
- **Закрытый контур**: в изолированных средах (банки, госсектор) это единственный путь получить внешние зависимости.
- **Безопасность цепочки поставок**: контроль того, какие пакеты разрешены, сканирование уязвимостей и лицензий (JFrog Xray, Nexus IQ, Trivy в Harbor), блокировка вредоносных и уязвимых версий, защита от dependency confusion (приоритет внутренних пакетов над публичными с тем же именем).
- **Build once, deploy many**: неизменяемые версии, **продвижение** артефакта между репозиториями `dev → staging → release` без пересборки.
- **Трассируемость**: метаданные сборки (коммит, пайплайн, кто собрал), информация о том, где развёрнута версия.
- **Политики хранения**: очистка старых snapshot-сборок и неиспользуемых образов, иначе хранилище растёт бесконтрольно.

**Эксплуатация:** бэкапы (метаданные в БД + бинарные данные, часто в S3), HA (несколько узлов за балансировщиком), мониторинг места, сервисные учётки для CI с минимальными правами (push только в свои репозитории), токены вместо паролей, настройка клиентов (`settings.xml`, `.npmrc`, `pip.conf`, `registry-mirrors` в Docker/containerd).

## Q: Напишите простой .gitlab-ci.yml: тесты, сборка образа и деплой.
level: middle
type: practice
freq: 3
tags: gitlab, пайплайн

```yaml
stages: [test, build, deploy]

variables:
  IMAGE: $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA

default:
  interruptible: true

lint_and_test:
  stage: test
  image: python:3.12-slim
  cache:
    key: { files: [requirements.txt] }
    paths: [.cache/pip]
  variables:
    PIP_CACHE_DIR: $CI_PROJECT_DIR/.cache/pip
  script:
    - pip install -r requirements.txt -r requirements-dev.txt
    - ruff check .
    - pytest --junitxml=report.xml
  artifacts:
    reports: { junit: report.xml }
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

build_image:
  stage: build
  image: docker:27
  services: [docker:27-dind]
  before_script:
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin $CI_REGISTRY
  script:
    - docker build -t $IMAGE .
    - docker push $IMAGE
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

deploy_staging:
  stage: deploy
  image: alpine/helm:3.16
  environment: { name: staging, url: https://staging.example.com }
  script:
    - helm upgrade --install api ./chart -n staging --set image.tag=$CI_COMMIT_SHORT_SHA --atomic --wait
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

deploy_prod:
  extends: deploy_staging
  environment: { name: production, url: https://example.com }
  script:
    - helm upgrade --install api ./chart -n prod --set image.tag=$CI_COMMIT_SHORT_SHA --atomic --wait
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
      when: manual            # ручное подтверждение
  resource_group: production  # не запускать два деплоя в прод одновременно
```

**Что стоит объяснить:**
- **stages** выполняются последовательно, джобы внутри стадии — параллельно. `needs:` позволяет запускать джобу сразу после нужных, не дожидаясь всей стадии.
- **Предопределённые переменные**: `CI_COMMIT_SHORT_SHA`, `CI_REGISTRY_IMAGE`, `CI_DEFAULT_BRANCH`, `CI_PIPELINE_SOURCE` и т.д.
- **Переменные и секреты** задаются в *Settings → CI/CD → Variables* с флагами **Masked** (скрыть в логах) и **Protected** (доступны только в защищённых ветках и тегах). Доступ к кластеру — через GitLab Agent for Kubernetes или OIDC, а не статический kubeconfig в переменной.
- **Раннеры**: shared или свои (`gitlab-runner`), executor'ы docker, shell, kubernetes. Джобы назначаются раннерам по `tags`.
- Вместо docker-in-docker (нужен privileged-режим) можно собирать образы через **Kaniko** или **Buildah**.

## Q: Как устроен Jenkins? Declarative vs Scripted pipeline.
level: middle
type: practice
freq: 2
tags: jenkins

**Архитектура:** **controller** (бывший master) хранит конфигурацию, планирует сборки, показывает UI; **агенты** (agents, nodes) выполняют сборки. Агенты подключаются по SSH или через inbound-агента (JNLP), бывают статическими или динамическими (Kubernetes plugin создаёт под на каждую сборку). Сборки на самом controller выполнять не рекомендуется (безопасность и нагрузка).

Функциональность почти целиком из **плагинов**. Это и сила, и главная боль: обновления, совместимость, уязвимости.

**Pipeline as code** — `Jenkinsfile` в репозитории.

**Declarative** — структурированный синтаксис, проще читать и валидировать:
```groovy
pipeline {
  agent { kubernetes { yamlFile 'ci/pod.yaml' } }
  options { timeout(time: 30, unit: 'MINUTES'); disableConcurrentBuilds() }
  environment { IMAGE = "registry.example.com/api:${env.GIT_COMMIT.take(8)}" }
  stages {
    stage('Test') {
      steps { sh 'make test' }
      post { always { junit 'reports/*.xml' } }
    }
    stage('Build') {
      steps {
        withCredentials([usernamePassword(credentialsId: 'registry', usernameVariable: 'U', passwordVariable: 'P')]) {
          sh 'echo $P | docker login -u $U --password-stdin registry.example.com && docker build -t $IMAGE . && docker push $IMAGE'
        }
      }
    }
    stage('Deploy prod') {
      when { branch 'main' }
      input { message 'Deploy to production?' }
      steps { sh "helm upgrade --install api ./chart --set image.tag=${env.GIT_COMMIT.take(8)}" }
    }
  }
  post { failure { slackSend channel: '#ci', message: "Failed: ${env.BUILD_URL}" } }
}
```

**Scripted** — произвольный Groovy в блоке `node { ... }`: гибче (циклы, сложная логика), но сложнее поддерживать и легко превратить в нечитаемый код. Внутри declarative для сложной логики есть блок `script { }`.

**Важное:**
- **Shared Libraries** — общий код пайплайнов для многих репозиториев (`@Library('ci-lib') _`).
- **Multibranch Pipeline** / Organization Folders — автоматически находят ветки и PR с Jenkinsfile.
- **Credentials** — хранилище секретов, доступ через `withCredentials`, маскирование в логах.
- **Configuration as Code** (JCasC) — конфигурация самого Jenkins в YAML, чтобы не настраивать вручную через UI.
- Эксплуатация: бэкапы `JENKINS_HOME`, обновления плагинов, очистка старых сборок, controller в HA-режиме не работает (один экземпляр).

Многие компании мигрируют с Jenkins на GitLab CI или GitHub Actions из-за стоимости поддержки, но в энтерпрайзе Jenkins по-прежнему очень распространён.

## Q: Как устроен GitHub Actions? Что такое workflow, job, step, runner?
level: middle
type: practice
freq: 2
tags: github-actions

- **Workflow** — YAML-файл в `.github/workflows/`, запускается по **событиям** (`on:`): push, pull_request, schedule (cron), workflow_dispatch (ручной запуск), release, теги.
- **Job** — набор шагов на одном **runner**'е. Джобы по умолчанию идут параллельно, зависимости задаются через `needs`.
- **Step** — команда (`run:`) или готовое **action** (`uses: actions/checkout@v4`).
- **Runner** — машина исполнения: GitHub-hosted (ubuntu, windows, macos) или **self-hosted** (свои ВМ или поды через Actions Runner Controller в Kubernetes).

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:

permissions:
  contents: read
  id-token: write          # для OIDC

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix: { python: ["3.11", "3.12"] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "${{ matrix.python }}", cache: pip }
      - run: pip install -r requirements.txt && pytest

  deploy:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production          # правила защиты и ручное одобрение
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gha-deploy   # OIDC вместо ключей
          aws-region: eu-central-1
      - run: ./deploy.sh
```

**Важное:**
- **Секреты и переменные** — на уровне репозитория, environment или организации: `${{ secrets.NAME }}`.
- **OIDC** — получение временных облачных учётных данных без хранения ключей.
- **Переиспользование**: reusable workflows (`workflow_call`) и composite actions.
- **Безопасность**: закреплять сторонние actions **по SHA коммита**, а не по тегу; минимальные `permissions` для `GITHUB_TOKEN`; осторожно с `pull_request_target` и подстановкой недоверенных данных (заголовок PR) в `run:` — это инъекция команд.
- Кеш — `actions/cache` или встроенный в setup-* actions, артефакты — `actions/upload-artifact`.
