---
id: cloud
title: Облака (AWS и общее)
icon: ☁️
order: 8
summary: VPC, IAM, отказоустойчивость, DR, стоимость, managed-сервисы
---

# Ключевые концепции

Большинство вакансий требуют опыт хотя бы с одним облаком (AWS — самый частый, затем GCP, Azure, Yandex Cloud, VK Cloud). Концепции переносимы между провайдерами.

### Соответствие сервисов
| Категория | AWS | GCP | Azure | Yandex Cloud |
|---|---|---|---|---|
| ВМ | EC2 | Compute Engine | Virtual Machines | Compute Cloud |
| Сеть | VPC | VPC | VNet | VPC |
| Kubernetes | EKS | GKE | AKS | Managed Kubernetes |
| Объектное хранилище | S3 | GCS | Blob Storage | Object Storage |
| Managed SQL | RDS/Aurora | Cloud SQL | Azure SQL | Managed PostgreSQL |
| IAM | IAM | IAM | Entra ID + RBAC | IAM |
| Serverless | Lambda | Cloud Functions/Run | Functions | Cloud Functions |

### Модель общей ответственности
Провайдер отвечает за безопасность **облака** (железо, гипервизор, физические ЦОДы), клиент — за безопасность **в облаке** (IAM, конфигурация, данные, патчи ОС на ВМ). Чем более managed сервис, тем больше берёт провайдер.

### Well-Architected Framework (6 столпов)
Operational Excellence, Security, Reliability, Performance Efficiency, Cost Optimization, Sustainability.

## Q: Спроектируйте сеть (VPC) для типового веб-приложения в облаке.
level: senior
type: design
freq: 3
tags: vpc, сеть

- **VPC** с непересекающимся CIDR (например, 10.20.0.0/16), растянутая на **3 зоны доступности**.
- **Публичные подсети** (по одной на AZ): балансировщик (ALB), NAT Gateway, bastion (лучше вообще без bastion — SSM Session Manager). Маршрут `0.0.0.0/0 → Internet Gateway`.
- **Приватные подсети** для приложений/нод Kubernetes: исходящий интернет через **NAT Gateway** (по одному на AZ для отказоустойчивости или один для экономии).
- **Изолированные подсети** для БД — без выхода в интернет.
- **Security Groups** (stateful, на уровне ENI): ALB принимает 443 из интернета → приложения принимают трафик только от SG балансировщика → БД только от SG приложений. Ссылки на SG вместо CIDR.
- **NACL** (stateless, на подсеть) — грубая дополнительная защита, обычно по умолчанию.
- **VPC Endpoints**: Gateway для S3/DynamoDB (бесплатно), Interface (PrivateLink) для ECR, STS, Secrets Manager — экономия на NAT и трафик не уходит в интернет.
- Связность: VPC peering (не транзитивен), **Transit Gateway** для множества VPC и on-prem, Site-to-Site VPN / Direct Connect.
- **Flow Logs** для аудита и отладки, Route 53 private hosted zones.

## Q: Как устроен IAM в AWS? Как обеспечить принцип наименьших привилегий?
level: senior
type: theory
freq: 3
tags: iam, безопасность

Сущности:
- **Users** (долгоживущие креды — избегать для людей и машин), **Groups**, **Roles** (временные креды через **STS AssumeRole**).
- **Policies** — JSON-документы: `Effect`, `Action`, `Resource`, `Condition`. Типы: identity-based, resource-based (bucket policy, KMS key policy), permission boundaries, **SCP** (Organizations — ограничение для целых аккаунтов), session policies.

Логика оценки: по умолчанию всё запрещено → явный **Allow** разрешает → явный **Deny** всегда побеждает. Действие должно быть разрешено на всех уровнях (SCP ∩ boundary ∩ identity/resource policy).

Наименьшие привилегии на практике:
- Люди — через SSO (IAM Identity Center) с временными ролями, MFA, никаких access keys.
- Нагрузки — роли: instance profile для EC2, **IRSA / EKS Pod Identity** для подов, OIDC federation для CI (GitHub/GitLab).
- Начинать с узких политик; **IAM Access Analyzer** генерирует политику по фактическому использованию из CloudTrail.
- Условия: `aws:SourceVpce`, `aws:PrincipalOrgID`, теги (ABAC).
- Мультиаккаунтная структура (Organizations, Control Tower): prod, staging, security, logging раздельно.
- Аудит: CloudTrail во всех регионах в отдельный аккаунт, GuardDuty, Security Hub.

## Q: Что такое RPO и RTO? Какие стратегии disaster recovery существуют?
level: senior
type: theory
freq: 3
tags: dr, надёжность

- **RPO** (Recovery Point Objective) — сколько данных допустимо потерять (насколько свежий бэкап нужен). RPO 1 час → бэкапы/репликация не реже раза в час.
- **RTO** (Recovery Time Objective) — за какое время нужно восстановить сервис.

Стратегии (от дешёвой к дорогой):
| Стратегия | Суть | RPO/RTO |
|---|---|---|
| **Backup & Restore** | бэкапы в другой регион, инфраструктура поднимается из IaC при аварии | часы / часы–сутки |
| **Pilot Light** | в DR-регионе работает только ядро (реплика БД), остальное поднимается при аварии | минуты / десятки минут |
| **Warm Standby** | уменьшенная полная копия, при аварии масштабируется | секунды–минуты / минуты |
| **Multi-site active-active** | трафик обслуживают несколько регионов одновременно | ~0 / ~0, сложно и дорого (консистентность данных) |

Обязательно:
- **Тестировать восстановление** регулярно (бэкап, из которого не восстанавливались, — не бэкап), game days.
- Бэкапы в **изолированном аккаунте**, неизменяемые (S3 Object Lock, AWS Backup Vault Lock) — защита от ransomware и ошибок.
- Runbook для переключения, автоматизация через IaC.
- Цели RPO/RTO определяет бизнес исходя из стоимости простоя.

## Q: Как вы будете снижать затраты на облако?
level: senior
type: scenario
freq: 3
tags: finops, стоимость

1. **Видимость**: обязательные теги (команда, сервис, окружение), Cost Explorer/CUR, Kubecost/OpenCost для Kubernetes, бюджеты и аномалии (AWS Cost Anomaly Detection). Без атрибуции затрат оптимизировать нечего.
2. **Убрать лишнее**: неиспользуемые ресурсы (неприкреплённые диски, старые снапшоты, простаивающие балансировщики, Elastic IP), выключать dev/stage ночью и в выходные.
3. **Rightsizing**: по метрикам загрузки (Compute Optimizer), requests в Kubernetes по факту (VPA-рекомендации), бин-пэкинг нод, Karpenter-консолидация.
4. **Модели закупки**: Savings Plans/Reserved Instances для стабильной базы, **Spot** для stateless и batch (с обработкой прерываний), Graviton (ARM) — до ~20–40% выгоднее.
5. **Хранилище**: lifecycle-политики S3 (IA, Glacier), Intelligent-Tiering, gp3 вместо gp2, удаление старых логов, ретеншн метрик.
6. **Сеть** (часто скрытая статья): межзональный трафик, NAT Gateway — VPC endpoints, topology-aware routing, CDN, сжатие.
7. **Архитектура**: serverless для неравномерной нагрузки, managed-сервисы vs самостоятельная поддержка (учитывая стоимость людей).
8. **Процесс FinOps**: регулярные ревью, ответственность команд за свои расходы, стоимость в MR (Infracost).

Важно назвать результат: «снизили на X% за счёт Y», и что экономия не должна ломать надёжность.

## Q: Как обеспечить высокую доступность приложения в облаке?
level: senior
type: design
freq: 3
tags: ha, надёжность

- **Устранение единых точек отказа** на всех уровнях.
- **Мульти-AZ**: экземпляры приложений в ≥2–3 зонах за балансировщиком, ASG/Kubernetes с topology spread, managed-БД с Multi-AZ (синхронная реплика и автоматический failover), кеш с репликами.
- **Stateless-приложения**: сессии во внешнем хранилище (Redis), файлы в S3 — экземпляры взаимозаменяемы.
- **Health checks** и автоматическая замена нездоровых экземпляров.
- **Автомасштабирование** с запасом на отказ целой зоны (N+1 по зонам: при 3 AZ каждая должна выдерживать ~50% нагрузки).
- **Устойчивость к сбоям зависимостей**: таймауты, ретраи с backoff и jitter, circuit breaker, деградация функциональности, очереди для асинхронной работы.
- **DNS** с health checks и failover (Route 53) для мульти-региона.
- **Статическая стабильность**: система продолжает работать при отказе control plane облака (заранее выделенная ёмкость, а не масштабирование в момент аварии).
- Проверка: chaos engineering, учения с отключением зоны.

Важно связать доступность с **SLO**: 99.9% = ~43 минуты простоя в месяц, 99.99% = ~4.3 минуты; каждая девятка резко дороже.

## Q: Чем отличается managed Kubernetes (EKS/GKE) от self-hosted? Что выбрать?
level: senior
type: theory
freq: 2
tags: kubernetes, managed

**Managed**: провайдер управляет control plane (API-серверы, etcd, их HA, бэкапы, обновления), интеграции с IAM, балансировщиками, хранилищем; SLA. Вы отвечаете за ноды (или берёте managed node groups / Fargate / Autopilot), аддоны, приложения, обновление версий в окне поддержки.

**Self-hosted** (kubeadm, Kubespray, Talos, RKE2) на ВМ или bare metal: полный контроль, работа в on-prem/закрытом контуре, нет платы за control plane, но вся операционная нагрузка на команде — etcd, сертификаты, обновления, HA control plane, мониторинг.

Выбор:
- облако + небольшая команда → managed почти всегда;
- требования регуляторов, on-prem, edge, специфичное железо (GPU-кластеры) → self-hosted или дистрибутивы (OpenShift, Deckhouse, Rancher);
- учитывать стоимость экспертизы: оплата control plane (~$70/мес в EKS) ничтожна по сравнению со временем инженеров.

## Q: Serverless: когда использовать, а когда нет?
level: middle
type: theory
freq: 2
tags: serverless

**Serverless** (Lambda, Cloud Functions, Cloud Run, Fargate) — нет управления серверами, масштабирование до нуля, оплата за фактическое использование.

Подходит:
- событийная обработка (загрузка файла в S3 → обработка, сообщения из очереди);
- неравномерная/непредсказуемая нагрузка, низкий средний трафик;
- glue-код, автоматизация инфраструктуры, cron-задачи;
- быстрые прототипы.

Не подходит или с оговорками:
- стабильная высокая нагрузка — дороже, чем контейнеры/ВМ;
- **cold start** критичен для латентности (решения: provisioned concurrency, SnapStart);
- долгие задачи (лимит Lambda — 15 минут), большие состояния, постоянные соединения (WebSocket — через API Gateway);
- лимиты параллельности и подключения к реляционной БД (каждый экземпляр открывает соединение → RDS Proxy);
- сложность отладки, локального тестирования, наблюдаемости и vendor lock-in.

## Q: Как организовать хранение в объектном хранилище (S3): классы, безопасность, жизненный цикл?
level: middle
type: practice
freq: 1
tags: s3, хранение

- **Классы хранения**: Standard, Intelligent-Tiering (автоматически), Standard-IA и One Zone-IA (редкий доступ, плата за извлечение), Glacier Instant/Flexible/Deep Archive (архив, извлечение от миллисекунд до часов).
- **Lifecycle-правила**: переход между классами по возрасту, удаление старых версий и незавершённых multipart-загрузок.
- **Безопасность**: Block Public Access на уровне аккаунта, шифрование по умолчанию (SSE-S3/SSE-KMS), bucket policy с условиями (только через VPC endpoint, только TLS), доступ через роли, presigned URL для временного доступа, **Object Ownership: bucket owner enforced** (отключение ACL).
- **Защита данных**: версионирование, MFA Delete, **Object Lock** (WORM) для бэкапов, кросс-региональная репликация.
- **Консистентность**: с 2020 года S3 обеспечивает strong read-after-write consistency.
- Производительность: префиксы масштабируются автоматически, multipart для больших файлов, CloudFront для раздачи.

## Q: Расскажите об основных сервисах AWS: EC2, S3, IAM, VPC, RDS. Что такое регион и зона доступности?
level: middle
type: theory
freq: 3
tags: aws, основы

**Регион** (region, например `eu-central-1` во Франкфурте) — географическая область с несколькими изолированными дата-центрами. Регионы независимы, данные сами по себе между ними не перемещаются (важно для законодательства о персональных данных). Выбор региона влияет на задержку до пользователей, цены и доступность сервисов.

**Зона доступности** (AZ, `eu-central-1a`) — один или несколько дата-центров внутри региона с независимым питанием, охлаждением и сетью, соединённые с другими AZ быстрыми каналами. Отказоустойчивость строится размещением ресурсов **в нескольких AZ**.

**Основные сервисы:**
- **EC2** — виртуальные машины. Тип инстанса (семейство + размер: `t3.micro`, `m7i.large`, `c7g` — Graviton/ARM), AMI (образ ОС), EBS (сетевые диски: gp3, io2), user data (скрипт при первом запуске), модели оплаты: On-Demand, Reserved / Savings Plans, Spot (до −90%, но может быть отозван).
- **Auto Scaling Group** — группа одинаковых инстансов из Launch Template с автоматическим масштабированием и заменой нездоровых.
- **ELB** — балансировщики: ALB (L7), NLB (L4).
- **S3** — объектное хранилище: бакеты и объекты, практически безлимитный объём, высокая надёжность хранения, классы хранения, версионирование. Используется для статики, бэкапов, логов, артефактов, Terraform state.
- **IAM** — пользователи, группы, **роли** и **политики** доступа. Сервисам (EC2, Lambda, поды в EKS) права выдаются через роли, а не через ключи доступа.
- **VPC** — изолированная виртуальная сеть: подсети (публичные и приватные), таблицы маршрутов, Internet Gateway, NAT Gateway, Security Groups.
- **RDS / Aurora** — управляемые реляционные БД (PostgreSQL, MySQL): бэкапы, патчи, Multi-AZ, реплики для чтения.
- **Route 53** — DNS. **CloudWatch** — метрики, логи, алармы. **CloudTrail** — аудит всех API-вызовов.
- **EKS** (Kubernetes), **ECS/Fargate** (контейнеры без управления серверами), **Lambda** (функции), **ECR** (реестр образов), **SQS/SNS** (очереди и уведомления), **Secrets Manager / SSM Parameter Store** (секреты и параметры).

Российские облака (Yandex Cloud, VK Cloud, SberCloud/Cloud.ru, Selectel) устроены по тем же принципам: регион и зоны, ВМ, объектное хранилище с S3-совместимым API, VPC, managed-БД и managed Kubernetes, IAM.

## Q: Чем Security Group отличается от Network ACL?
level: middle
type: theory
freq: 3
tags: aws, firewall, vpc

| | Security Group | Network ACL |
|---|---|---|
| Уровень применения | сетевой интерфейс (ENI) — инстанс, под, балансировщик, RDS | **подсеть** целиком |
| Состояние | **stateful**: ответный трафик разрешён автоматически | **stateless**: ответный трафик нужно разрешить явно (включая эфемерные порты 1024–65535) |
| Правила | только **разрешающие** | разрешающие и **запрещающие** |
| Порядок | оцениваются все правила вместе | по **номеру правила**, первое совпавшее срабатывает |
| По умолчанию | входящий запрещён, исходящий разрешён | default NACL разрешает всё |
| Источник в правиле | CIDR или **другая Security Group** | только CIDR |

**Практика:**
- Основной инструмент — **Security Groups**. Правила со ссылкой на другую SG удобны: «БД принимает 5432 только от SG приложения» — не нужно знать IP-адреса, а при масштабировании новые инстансы автоматически подпадают под правило.
- **NACL** — дополнительный грубый уровень защиты: заблокировать конкретный диапазон IP (SG так не умеет, потому что в ней нет deny), жёсткая изоляция подсетей. Чаще всего оставляют по умолчанию.
- Классическая ошибка с NACL: разрешили входящий 443, но забыли исходящие эфемерные порты для ответов → соединения «висят».

**Диагностика «нет доступа»:** проверить SG на обеих сторонах (исходящий у источника, входящий у получателя), NACL подсетей, таблицы маршрутов, затем — файрвол на самой ВМ. Помогают **VPC Reachability Analyzer** и **Flow Logs** (`REJECT` в логах).

Аналоги в других облаках: в GCP — firewall rules VPC с network tags, в Azure — NSG, в Yandex Cloud — группы безопасности.

## Q: Расскажите об устройстве Yandex Cloud: иерархия ресурсов, IAM, основные сервисы.
level: middle
type: theory
freq: 3
tags: yandex-cloud, российские-облака

**Иерархия ресурсов:**
- **Организация** (Yandex Cloud Organization) — пользователи, федерации с корпоративным SSO (SAML, Active Directory), группы;
- **Облако** (cloud) — изолированное пространство, обычно одно на компанию или крупное направление;
- **Каталог** (folder) — аналог проекта в GCP или аккаунта в AWS: в нём создаются все ресурсы. Принято разделять каталоги по окружениям и командам (`prod`, `stage`, `dev`).
- Права, назначенные на облако, **наследуются** каталогами.

Регион `ru-central1` с несколькими зонами доступности (`ru-central1-a`, `-b`, `-d`). Отказоустойчивость строится размещением ресурсов в нескольких зонах.

**IAM:**
- субъекты: аккаунты на Яндексе, федеративные пользователи, **сервисные аккаунты** (для приложений, CI, Terraform), группы;
- **роли** назначаются на облако, каталог или конкретный ресурс: примитивные (`viewer`, `editor`, `admin`) и сервисные (`compute.admin`, `k8s.clusters.agent`, `storage.uploader`, `lockbox.payloadViewer`);
- аутентификация: **IAM-токен** (живёт до 12 часов), **авторизованные ключи** сервисного аккаунта (для получения IAM-токена), **статические ключи** (S3-совместимый доступ к Object Storage), API-ключи; сервисный аккаунт можно привязать к ВМ — тогда токен выдаётся через сервис метаданных без хранения ключей на машине; есть федерация рабочих нагрузок (workload identity) для CI.

**Соответствие основных сервисов AWS:**
| Задача | Yandex Cloud | AWS |
|---|---|---|
| ВМ, группы ВМ | Compute Cloud, Instance Groups | EC2, ASG |
| Сеть | Virtual Private Cloud, группы безопасности, NAT-шлюз | VPC, SG, NAT GW |
| Балансировка | Network Load Balancer (L4), Application Load Balancer (L7) | NLB, ALB |
| Объектное хранилище | Object Storage (S3-совместимый API) | S3 |
| Kubernetes | Managed Service for Kubernetes | EKS |
| Базы данных | Managed Service for PostgreSQL / MySQL / ClickHouse / Redis (Valkey) / Kafka / OpenSearch | RDS, ElastiCache, MSK |
| Реестр образов | Container Registry, Cloud Registry | ECR |
| Секреты и ключи | Lockbox, Key Management Service | Secrets Manager, KMS |
| Serverless | Cloud Functions, Serverless Containers, API Gateway | Lambda, API Gateway |
| Мониторинг и логи | Monitoring, Cloud Logging, Audit Trails | CloudWatch, CloudTrail |
| DNS, CDN | Cloud DNS, Cloud CDN | Route 53, CloudFront |

**Инструменты:** CLI **`yc`**, Terraform-провайдер **`yandex-cloud/yandex`** (доступен через **зеркало** `terraform-mirror.yandexcloud.net`, так как реестр HashiCorp недоступен из России — настраивается в `~/.terraformrc`), хранение Terraform state в Object Storage с блокировками, Packer, Ansible. Для Kubernetes есть интеграции: Ingress-контроллер ALB, CSI для дисков, External Secrets с Lockbox, Cluster Autoscaler в группах узлов.

## Q: Какие российские облачные провайдеры вы знаете? Чем они отличаются и что учитывать при выборе?
level: middle
type: theory
freq: 2
tags: российские-облака, vk-cloud, импортозамещение

**Основные провайдеры:**
- **Yandex Cloud** — крупнейший по набору managed-сервисов (БД, Kafka, ClickHouse, Kubernetes, serverless, ML-сервисы и YandexGPT), развитый IAM и Terraform-провайдер.
- **VK Cloud** — платформа на базе **OpenStack**: ВМ, Managed Kubernetes (Cloud Containers), объектное хранилище, managed-БД; Terraform-провайдер **`vk-cs/vkcs`**, совместимость с инструментами OpenStack.
- **Cloud.ru** (бывший SberCloud) — платформа **Evolution** (собственная): ВМ, Managed Kubernetes, managed PostgreSQL и Redis, ИИ-сервисы и GigaChat; Terraform-провайдер в репозитории `cloud-ru`.
- **Selectel** — облако и **выделенные серверы** (bare metal), Managed Kubernetes, S3-хранилище, сильная сторона — гибкость конфигураций и GPU-серверы.
- **MTS Web Services (MWS)**, **Т1 Облако**, **Рег.облако**, **Timeweb Cloud**, облака операторов связи и региональные провайдеры.

**На что смотреть при выборе:**
- **Требования регуляторов**: размещение персональных данных по **152-ФЗ** (нужный уровень защищённости), аттестованные сегменты (ФСТЭК), требования к КИИ — у многих провайдеров есть отдельные защищённые зоны.
- **Набор managed-сервисов**: есть ли нужные БД, Kafka, Kubernetes нужной версии, или всё придётся поддерживать самим.
- **Совместимость и переносимость**: S3-совместимый API хранилища, стандартный Kubernetes, Terraform-провайдер и его зрелость, OpenStack API.
- **Надёжность**: количество зон доступности, SLA, история инцидентов, возможность разнести ресурсы по зонам.
- **Сеть**: стоимость исходящего трафика, связность с офисами и другими площадками, выделенные каналы.
- **Поддержка**: скорость и качество техподдержки, наличие выделенного менеджера.
- **GPU** для ИИ-задач: доступность и цена.
- **Стоимость** и модель оплаты, скидки за резервирование.

**Практический совет:** проектировать так, чтобы привязка к провайдеру была минимальной там, где это не дорого: Kubernetes, Terraform-модули с чётким интерфейсом, S3-совместимое хранилище, open-source мониторинг вместо проприетарного. Это упрощает миграцию и работу в нескольких облаках (multi-cloud) или гибридную схему с собственным ЦОД.

## Q: Как перенести инфраструктуру из AWS в российское облако? Что может пойти не так?
level: senior
type: scenario
freq: 2
tags: миграция, российские-облака

**1. Инвентаризация и оценка:**
- полный список ресурсов и зависимостей (Terraform state, AWS Config, теги), потоки данных между сервисами;
- проприетарные сервисы без прямого аналога: DynamoDB, SQS/SNS, Kinesis, Lambda со специфичными триггерами, Aurora-функции, Cognito, специфичные IAM-политики. Для каждого — решение: аналог у провайдера, open-source (Kafka, RabbitMQ, PostgreSQL, Keycloak) или переписать;
- объёмы данных и допустимый простой (RPO/RTO) для каждой системы.

**2. Подготовка целевой платформы (landing zone):**
- структура облаков и каталогов (проектов), IAM и сервисные аккаунты, сеть (непересекающиеся CIDR), VPN или выделенный канал между облаками на время миграции;
- **Terraform-модули под нового провайдера**: код AWS не переносится напрямую — другие ресурсы и атрибуты. Переписывание — хороший момент навести порядок в IaC;
- реестр образов, CI/CD-раннеры в новом облаке, мониторинг и логирование, секреты (Vault или Lockbox).

**3. Перенос нагрузки (по волнам, от простого к сложному):**
- stateless-сервисы в Kubernetes переносятся проще всего: те же Helm-чарты и манифесты, меняются StorageClass, аннотации Ingress и балансировщиков, IAM-интеграции (IRSA → сервисные аккаунты провайдера);
- **данные** — самое сложное: для БД — логическая репликация PostgreSQL или CDC (Debezium) с последующим коротким переключением, а не дамп с многочасовым простоем; объектное хранилище — `rclone` / `s3 sync` с повторной синхронизацией дельты перед переключением;
- переключение через DNS (заранее снизить TTL), с планом отката.

**4. Что может пойти не так:**
- недооценка проприетарных зависимостей (код приложения, использующий AWS SDK напрямую: SQS, S3 presigned URL, KMS);
- различия в поведении: лимиты и квоты (их нужно заранее согласовать с провайдером), производительность дисков и сети, версии Kubernetes и managed-БД, особенности балансировщиков (таймауты, health checks, сохранение IP клиента);
- **межоблачный трафик**: стоимость исходящего трафика из AWS при переносе данных и рост задержки, если сервисы временно живут в разных облаках;
- сертификаты, DNS-зоны, почтовые записи (SPF/DKIM), IP-адреса в белых списках у партнёров;
- мониторинг и алерты «забыли» перенести — после переключения система работает вслепую;
- недоступность внешних зависимостей из РФ: реестры образов и пакетов (Docker Hub, реестр Terraform, некоторые SaaS) → нужны **зеркала и прокси-репозитории** (Nexus, Harbor, зеркало Terraform-провайдеров);
- обучение команды: другие консоли, CLI, IAM-модель, процедуры поддержки.

**5. После миграции:** нагрузочное тестирование, учения по отказу зоны, сверка стоимости, удаление ресурсов в старом облаке (чтобы не платить за забытое), обновление документации и runbook'ов.

## Q: Как устроен Google Cloud: иерархия ресурсов, IAM, сеть?
level: middle
type: theory
freq: 2
tags: gcp

**Иерархия ресурсов:**
- **Organization** (привязана к домену Google Workspace или Cloud Identity) → **Folders** (подразделения, окружения) → **Projects** → ресурсы.
- **Проект** — основная единица: биллинг, квоты, API, IAM. Принято разделять проекты по окружениям и командам.
- **Organization Policies** — ограничения на всю организацию или папку: разрешённые регионы, запрет внешних IP, запрет создания ключей сервисных аккаунтов.

**IAM:**
- субъекты (principals): пользователи Google, группы, **сервисные аккаунты**, домены, федеративные идентичности;
- роли: **basic** (Owner, Editor, Viewer — слишком широкие, в проде избегать), **predefined** (`roles/storage.objectViewer`, `roles/container.developer`), **custom**;
- роли назначаются на организацию, папку, проект или ресурс и **наследуются вниз**;
- **ключи сервисных аккаунтов** (JSON-файлы) — главный источник утечек; вместо них — привязка сервисного аккаунта к ВМ и Cloud Run, **Workload Identity Federation for GKE** (поды получают права через Kubernetes ServiceAccount) и **Workload Identity Federation** для CI и других облаков (GitHub Actions, GitLab → GCP без ключей);
- IAM Conditions — условия по времени, ресурсам, тегам.

**Сеть — главное отличие от AWS:**
- **VPC глобальная**: одна сеть охватывает все регионы, а **подсети региональные**. Виртуальные машины в разных регионах общаются по внутренним IP без peering;
- правила файрвола на уровне VPC с применением по **network tags** или сервисным аккаунтам (а не security groups на интерфейсе); новые возможности — иерархические и сетевые политики файрвола;
- **Shared VPC** — одна сеть в host-проекте, которой пользуются service-проекты разных команд (централизованное управление сетью);
- **Cloud NAT**, **Private Google Access** (доступ к API Google без внешних IP), Private Service Connect;
- **глобальный балансировщик HTTP(S)** с одним anycast-IP для всего мира.

**Основные сервисы:** Compute Engine (ВМ, Managed Instance Groups), **GKE** (Standard и **Autopilot** — Google управляет нодами, оплата за поды), **Cloud Run** (serverless-контейнеры), Cloud Functions, Cloud Storage, Cloud SQL, AlloyDB, Spanner, Memorystore, **BigQuery**, Pub/Sub, Artifact Registry, Secret Manager, Cloud KMS, Cloud Logging и Cloud Monitoring, Cloud Build, Cloud DNS, Cloud Armor (WAF).

**Инструменты:** `gcloud` CLI, Terraform-провайдер `hashicorp/google`, Config Connector (ресурсы GCP как объекты Kubernetes).

## Q: Как устроен Microsoft Azure: иерархия, Entra ID и RBAC, managed identities, сеть?
level: middle
type: theory
freq: 2
tags: azure

**Иерархия:**
- **Microsoft Entra ID** (бывший Azure Active Directory) **tenant** — каталог пользователей и приложений организации;
- **Management groups** — группировка подписок для общих политик и прав;
- **Subscriptions** — граница биллинга, квот и доступа (часто отдельные подписки для prod и non-prod);
- **Resource groups** — логический контейнер ресурсов с общим жизненным циклом (удаление группы удаляет всё в ней);
- ресурсы.

**Доступ:**
- **Entra ID** отвечает за идентичность (пользователи, группы, **service principals** приложений, условный доступ, MFA);
- **Azure RBAC** — назначение ролей (Owner, Contributor, Reader, специализированные: `AcrPull`, `Key Vault Secrets User`) на **scope**: management group, подписка, группа ресурсов, ресурс; права наследуются вниз;
- **Managed identities** — идентичность ресурса Azure (ВМ, App Service, Functions, AKS) без секретов: **system-assigned** (живёт и удаляется вместе с ресурсом) и **user-assigned** (отдельный ресурс, можно назначить нескольким). Аналог IAM-ролей для EC2;
- **Workload identity** для AKS (поды получают токен Entra ID по Kubernetes ServiceAccount) и **federated credentials** для CI (GitHub Actions, Azure DevOps) без секретов;
- **Azure Policy** — правила соответствия (разрешённые регионы, обязательные теги, запрет публичных IP) с аудитом и автоматическим исправлением.

**Сеть:**
- **VNet** (региональная) с подсетями, **NSG** (network security group — stateful правила на подсеть или интерфейс), **ASG** (группировка ВМ для правил NSG);
- **VNet peering**, hub-and-spoke с **Azure Firewall** или Virtual WAN, VPN Gateway, ExpressRoute;
- **Private Endpoint / Private Link** — доступ к PaaS-сервисам (Storage, SQL, Key Vault) по приватному IP в вашей VNet;
- балансировка: **Load Balancer** (L4), **Application Gateway** (L7 + WAF, региональный), **Front Door** (глобальный L7 + CDN).

**Основные сервисы:** Virtual Machines и VM Scale Sets, **AKS**, App Service, Azure Functions, Container Apps, Blob Storage, Azure SQL, Azure Database for PostgreSQL, Cosmos DB, Service Bus, Event Hubs (совместим с протоколом Kafka), Key Vault, Azure Container Registry, Azure Monitor и Log Analytics, Microsoft Defender for Cloud.

**IaC и CI/CD:** ARM-шаблоны, **Bicep** (более удобный язык поверх ARM), Terraform-провайдер `azurerm`, **Azure DevOps** (Boards, Repos, Pipelines, Artifacts), GitHub Actions.

## Q: Сравните AWS, GCP и Azure. Как бы вы выбирали облако для нового проекта?
level: senior
type: design
freq: 2
tags: облака, сравнение

**Соответствие основных сервисов:**
| Задача | AWS | GCP | Azure |
|---|---|---|---|
| ВМ и автомасштабирование | EC2, ASG | Compute Engine, MIG | VMs, VM Scale Sets |
| Kubernetes | EKS | GKE (Standard, Autopilot) | AKS |
| Serverless-контейнеры | ECS Fargate, App Runner | Cloud Run | Container Apps |
| Функции | Lambda | Cloud Run functions | Azure Functions |
| Объектное хранилище | S3 | Cloud Storage | Blob Storage |
| Реляционные БД | RDS, Aurora | Cloud SQL, AlloyDB, Spanner | Azure SQL, Database for PostgreSQL |
| Очереди и события | SQS, SNS, EventBridge, MSK | Pub/Sub | Service Bus, Event Grid, Event Hubs |
| Секреты и ключи | Secrets Manager, KMS | Secret Manager, Cloud KMS | Key Vault |
| Идентичность | IAM, IAM Identity Center | Cloud IAM, Cloud Identity | Entra ID, Azure RBAC |
| Сеть | VPC (региональная) | VPC (глобальная) | VNet (региональная) |
| Мониторинг | CloudWatch, X-Ray | Cloud Monitoring, Logging, Trace | Azure Monitor, Application Insights |
| IaC (нативный) | CloudFormation, CDK | Infrastructure Manager | ARM, Bicep |
| Аналитика | Redshift, Athena | BigQuery | Synapse, Fabric |

**Сильные стороны (обобщённо):**
- **AWS** — самый широкий набор сервисов, зрелость, крупнейшая экосистема и рынок специалистов;
- **GCP** — сильный Kubernetes (GKE), данные и аналитика (BigQuery), глобальная сеть, удобные Cloud Run и Autopilot;
- **Azure** — интеграция с экосистемой Microsoft (Entra ID, Office 365, Windows, .NET, SQL Server), популярен в энтерпрайзе, гибридные сценарии.

**Критерии выбора:**
1. **Требования к данным и законодательство**: где должны храниться данные (для российских персональных данных — российские облака или собственный ЦОД).
2. **Существующие компетенции команды** и экосистема компании (уже есть Microsoft 365 и Entra ID → Azure проще интегрировать).
3. **Нужные managed-сервисы** и их зрелость для вашего стека.
4. **Стоимость**: не прайс-лист, а расчёт для своей нагрузки, включая трафик, поддержку и скидки за обязательства (Savings Plans, CUD, Reservations).
5. **География**: регионы рядом с пользователями.
6. **Партнёрские условия**, кредиты для стартапов, поддержка.

**Multi-cloud:** звучит как защита от зависимости, но удваивает сложность (разные IAM, сети, сервисы, экспертиза). Оправдан при конкретных причинах: регуляторика, слияние компаний, использование уникального сервиса другого облака. Чаще разумнее одно основное облако + **переносимость** там, где это недорого (Kubernetes, Terraform, open-source БД и мониторинг).
