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
