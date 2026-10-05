# Исследование: что спрашивают на собеседованиях Senior DevOps (2025–2026)

Анализ открытых источников (статьи Habr и DOU, агрегаторы реальных вопросов, англоязычные гайды для нанимающих, GitHub-сборники вопросов). Собран в октябре 2026 года.

## 1. Как устроены собеседования

Типичная воронка для Senior DevOps / SRE / Platform Engineer:

| Этап | Что проверяют | Длительность |
|---|---|---|
| HR-скрининг | мотивация, ожидания, стек, опыт с технологиями из вакансии | 20–30 мин |
| Техническое интервью | Linux, сети, контейнеры, Kubernetes, CI/CD, IaC, облака, мониторинг | 60–90 мин |
| Практика / live-траблшутинг | сломанная VM или кластер, разбор логов, скрипт на Bash/Python | 45–90 мин |
| System design | спроектировать инфраструктуру/пайплайн/HA-систему, обсуждение компромиссов | 45–60 мин |
| Поведенческое / с руководителем | инциденты, влияние, конфликты, менторство, принятие решений | 45–60 мин |

Главные наблюдения из источников:
- На уровне senior проверяют **не знание команд, а рассуждение**: компромиссы, «почему этот инструмент, а не другой», методичную диагностику продакшен-проблем.
- Четыре слоя вопросов: концептуальное понимание → глубина по инструментам → сценарии траблшутинга → поведенческие и лидерские качества.
- Много вопросов вида **«что делали и как делали»** — по реальному опыту кандидата.
- Самые частые темы (по агрегатору реальных вопросов российских компаний): **Kubernetes, Linux, Docker**, затем сети, CI/CD и мониторинг.

## 2. Карта тем и частота

Частота — экспертная оценка по совокупности источников (●●● — встречается почти на каждом собеседовании).

| Тема | Частота | Типичные вопросы |
|---|---|---|
| Linux | ●●● | load average, процессы и зомби, сигналы, память и OOM, inode, systemd, загрузка ОС, namespaces/cgroups, диагностика производительности |
| Сети | ●●● | путь запроса по URL, TCP/UDP и состояния, DNS, HTTP/1.1–2–3, TLS/mTLS, L4 vs L7, 502/504, CIDR, NAT/conntrack |
| Docker и контейнеры | ●●● | VM vs контейнер, слои и размер образа, CMD/ENTRYPOINT и PID 1, сети и тома, безопасность, рантаймы (containerd, runc, CRI) |
| Kubernetes | ●●● | архитектура и путь `kubectl apply`, Pending/CrashLoopBackOff/OOMKilled, requests/limits и QoS, пробы, Service и kube-proxy, Ingress/Gateway API, HPA/Karpenter, RBAC, CNI, PV/CSI, обновление кластера, etcd |
| CI/CD и GitOps | ●●● | дизайн пайплайна с нуля, стратегии деплоя, миграции БД без даунтайма, ускорение пайплайна, GitOps (ArgoCD/Flux), supply chain security |
| Terraform / IaC | ●●● | state и блокировки, дрейф, структура для окружений, count vs for_each, рефакторинг (`moved`, `import`), секреты, тестирование |
| Мониторинг / Observability | ●●● | Prometheus и PromQL, кардинальность, SLI/SLO/error budget, алертинг по burn rate, логи (ELK vs Loki), трейсинг и OpenTelemetry |
| Облака | ●●○ | дизайн VPC, IAM и least privilege, HA и DR (RPO/RTO), FinOps, managed vs self-hosted Kubernetes, serverless |
| Безопасность / DevSecOps | ●●○ | управление секретами, утечка ключа, безопасность Kubernetes, SBOM/SLSA/cosign, Zero Trust |
| SRE и System Design | ●●○ | управление инцидентами и постмортемы, проектирование под нагрузку, ретраи и thundering herd, Kafka vs RabbitMQ, toil, DORA |
| Базы данных | ●●○ | ACID и изоляция, репликация и failover (Patroni), бэкапы и PITR, медленные запросы, PgBouncer, БД в Kubernetes |
| Git | ●●○ | merge vs rebase, GitFlow vs trunk-based, reflog, revert vs reset, удаление секрета из истории |
| Ansible / Config management | ●○○ | идемпотентность, структура ролей, rolling update, производительность, mutable vs immutable |
| Скрипты (Bash/Python/Go) | ●●○ | `set -euo pipefail`, парсинг логов awk, скрипт проверки URL, кавычки в Bash, зачем DevOps-инженеру Go |
| Поведенческие | ●●● | сложный инцидент, внедрение изменений против сопротивления, собственная ошибка, работа с разработчиками, техдолг, менторство |

## 3. Тренды 2025–2026, которые стоит знать

- **Gateway API** вытесняет Ingress; community-проект ingress-nginx выводится из поддержки — вопросы о миграции.
- **Platform Engineering**: внутренние платформы, golden paths, self-service (Backstage), DevEx.
- **Supply chain security**: SBOM, подпись образов (Sigstore/cosign), SLSA, OIDC вместо статических ключей в CI.
- **OpenTelemetry** как стандарт телеметрии; tail-based sampling; continuous profiling.
- **eBPF** (Cilium, Tetragon, bpftrace) — сеть, безопасность и наблюдаемость без sidecar'ов.
- **Karpenter** и FinOps: стоимость инфраструктуры как инженерная метрика.
- **OpenTofu** как альтернатива Terraform после смены лицензии; новые возможности Terraform (`import`/`moved`/`removed` блоки, `terraform test`, ephemeral-ресурсы).
- **Kafka 4.0 без ZooKeeper** (KRaft).
- **AI в эксплуатации**: использование LLM-ассистентов для инфраструктурного кода и инцидентов, инфраструктура для ML-нагрузок (GPU-ноды в Kubernetes).

## 4. Как это заложено в тренажёр

- Каждый вопрос размечен: **уровень** (middle/senior/lead), **тип** (теория, практика, кейс, дизайн, поведенческий), **частота** (1–3), теги.
- Ответы — развёрнутые эталоны senior-уровня: не только «что», но и «почему», подводные камни и вопросы, которые могут задать дальше.
- У каждой темы есть блок **теории/шпаргалки** для повторения перед собеседованием.
- Режимы: изучение темы, тренировка карточками с интервальным повторением, пробное собеседование с таймером и итоговой оценкой по темам.

## 5. Источники

- [Habr — вопросы на собеседовании Senior DevOps (HR и технический этапы)](https://habr.com/en/articles/733158)
- [Habr — какие вопросы задают DevOps-инженеру](https://habr.com/ru/post/699634)
- [Habr — вебинары с экспертами BigTech о требованиях к DevOps](https://habr.com/ru/post/904482)
- [DOU — как проводить собеседование на позицию DevOps Engineer](https://dou.ua/lenta/articles/how-to-interview-devops-engineer/)
- [Enigma AI — реальные вопросы с собеседований DevOps, отсортированные по частоте](https://enigmai.ru/prep/devops/)
- [Adaface — Senior DevOps Engineer interview questions](https://www.adaface.com/blog/senior-devops-engineer-interview-questions/)
- [Futurense — DevOps interview questions for experienced professionals (2026)](https://futurense.com/blog/devops-interview-questions-for-experienced-professionals)
- [KodeKloud — DevOps interview questions](https://kodekloud.com/blog/devops-interview-questions/)
- [ExamCert — DevOps engineer interview questions 2026](https://www.examcert.app/blog/devops-engineer-interview-questions-2026/)
- [PracHub — Kubernetes interview questions for SRE and platform engineers](https://prachub.com/resources/kubernetes-interview-questions-for-sre-and-platform-engineers-production-scenarios-not-trivia)
- [SecondTalent — Advanced Kubernetes interview questions](https://secondtalent.com/?p=31818)
- [GitHub — NotHarshhaa/DevOps-Interview-Questions (550+ вопросов)](https://github.com/NotHarshhaa/DevOps-Interview-Questions)
- [GitHub — devopscloud-java/Devops-Interview (сценарные вопросы)](https://github.com/devopscloud-java/Devops-Interview)
- [GitHub — umeshdevopseng/interview-questions](https://github.com/umeshdevopseng/interview-questions)
- Дополнительно при составлении ответов: Google SRE Book и SRE Workbook (SLO, burn rate, toil, инциденты), методология USE Брендана Грегга, документация Kubernetes, Terraform, Prometheus, PostgreSQL.
