---
id: kubernetes
title: Kubernetes
icon: ☸️
order: 4
summary: Архитектура, планирование, сеть, хранение, масштабирование, траблшутинг
---

# Ключевые концепции

Kubernetes — самая частая тема на собеседованиях DevOps в 2025–2026. Senior проверяют не на знание объектов, а на **понимание внутренней механики** и умение **чинить продакшен**.

### Архитектура
**Control plane**
- **kube-apiserver** — единственная точка входа, валидация, аутентификация/авторизация, admission, хранение в etcd.
- **etcd** — распределённое KV-хранилище (Raft), источник истины. Кворум: (N/2)+1, поэтому 3 или 5 узлов.
- **kube-scheduler** — выбирает ноду для подов (фильтрация → скоринг).
- **kube-controller-manager** — циклы согласования (Deployment, ReplicaSet, Node, Job, EndpointSlice...).
- **cloud-controller-manager** — интеграция с облаком (LoadBalancer, ноды, маршруты).

**Worker node**
- **kubelet** — запускает поды через CRI, пробы, отчёт о статусе.
- **kube-proxy** — правила iptables/IPVS для Service (или заменяется eBPF в Cilium).
- **Container runtime** — containerd/CRI-O.
- **CNI-плагин** — сеть подов (Calico, Cilium, Flannel, AWS VPC CNI).

### Главная идея — декларативность и reconciliation loop
Вы описываете **желаемое состояние**, контроллеры постоянно сравнивают его с фактическим и приводят к нему. Все компоненты общаются только через API-сервер (watch).

### Траблшутинг-шпаргалка
```bash
kubectl get pods -o wide
kubectl describe pod <pod>          # Events — самое важное
kubectl logs <pod> -c <ctr> --previous
kubectl get events --sort-by=.lastTimestamp
kubectl top pod / node
kubectl debug -it <pod> --image=busybox --target=<ctr>
kubectl auth can-i <verb> <resource> --as=system:serviceaccount:ns:sa
```

## Q: Что происходит после kubectl apply -f deployment.yaml до запуска контейнера?
level: senior
type: theory
freq: 3
tags: архитектура

1. **kubectl** валидирует манифест и отправляет запрос (server-side apply/PATCH) в **API-сервер**.
2. API-сервер: **аутентификация** (сертификат, токен, OIDC) → **авторизация** (RBAC) → **mutating admission** (webhooks, дефолты, инжекция sidecar) → валидация схемы → **validating admission** (политики) → запись объекта в **etcd**.
3. **Deployment controller** (в controller-manager) видит новый Deployment через watch и создаёт **ReplicaSet**.
4. **ReplicaSet controller** создаёт нужное число объектов **Pod** (без `nodeName`).
5. **Scheduler** видит неназначенные поды: фильтрует ноды (ресурсы, taints/tolerations, affinity, volume topology), ранжирует, записывает `nodeName` (binding).
6. **kubelet** на выбранной ноде видит под, назначенный ему:
   - через **CRI** просит containerd создать sandbox (pause-контейнер с network namespace);
   - вызывает **CNI** — под получает IP;
   - **CSI** монтирует тома;
   - скачивает образы, запускает init-контейнеры, затем основные;
   - запускает startup/liveness/readiness-пробы.
7. Когда под становится **Ready**, EndpointSlice controller добавляет его IP в эндпоинты Service, **kube-proxy** обновляет правила — под начинает получать трафик.
8. kubelet постоянно отправляет статус пода обратно в API-сервер.

## Q: Под находится в статусе Pending. Какие причины и как диагностировать?
level: middle
type: scenario
freq: 3
tags: траблшутинг, scheduling

Pending = под ещё не запущен на ноде. Первое — `kubectl describe pod` → секция **Events**.

Причины:
- **Недостаточно ресурсов**: `0/5 nodes are available: 3 Insufficient cpu`. Requests пода больше, чем свободная **allocatable** ёмкость (считается по requests, а не по реальному потреблению!). Решение: уменьшить requests, добавить ноды, проверить работу Cluster Autoscaler.
- **Taints без tolerations**: `node(s) had untolerated taint`.
- **nodeSelector/affinity** не совпадают ни с одной нодой; **podAntiAffinity** не может быть удовлетворена (реплик больше, чем нод/зон).
- **PVC не привязан**: нет StorageClass, нет PV, том в другой зоне доступности (`volume node affinity conflict`) — решается `volumeBindingMode: WaitForFirstConsumer`.
- **ResourceQuota / LimitRange** в namespace — тогда под обычно даже не создастся (ошибка в событиях ReplicaSet).
- Ноды `NotReady` или `cordoned`.
- Если статус `ContainerCreating` (под уже назначен) — проблемы образа, CNI (нет IP), монтирования секретов/томов.

## Q: Под в CrashLoopBackOff. Ваши действия?
level: middle
type: scenario
freq: 3
tags: траблшутинг

CrashLoopBackOff — контейнер стартует и падает, kubelet перезапускает его с экспоненциальной задержкой (10с → 20с → … → 5 мин).

Шаги:
1. `kubectl describe pod` — **Last State**: `Reason` и `Exit Code` (137 + `OOMKilled` → память; 1 → ошибка приложения; 127 → нет бинарника), события по пробам.
2. `kubectl logs <pod> --previous` — логи **упавшего** экземпляра.
3. Частые причины:
   - ошибка конфигурации: нет переменной, Secret/ConfigMap, неверная строка подключения;
   - недоступна зависимость (БД) и приложение падает вместо ретраев;
   - **liveness-проба** убивает медленно стартующее приложение → нужна **startupProbe** или больше `initialDelaySeconds`;
   - OOMKilled — лимит памяти ниже реального потребления (JVM без `-XX:MaxRAMPercentage`);
   - нет прав (readOnlyRootFilesystem, non-root user пишет в каталог);
   - неверная архитектура образа.
4. Если логов нет — запустить отладочную копию: `kubectl debug pod/x --copy-to=x-debug --container=app -- sh` или временно заменить команду на `sleep infinity` и исследовать изнутри.

## Q: Объясните requests и limits. Что такое QoS-классы и CPU throttling?
level: senior
type: theory
freq: 3
tags: ресурсы

- **requests** — гарантированный объём, используется **планировщиком** для размещения и как вес CPU (`cpu.weight`).
- **limits** — потолок, применяется через cgroups:
  - **CPU limit** → квота CFS (`cpu.max`): за период 100 мс контейнер может использовать limit×100мс процессорного времени. Превысил — **throttling** до конца периода, даже если нода простаивает. Многопоточные приложения выбирают квоту за первые миллисекунды → всплески латентности.
  - **Memory limit** → при превышении **OOMKill** контейнера.

**QoS-классы** (влияют на порядок вытеснения при нехватке памяти на ноде):
- **Guaranteed** — requests = limits для CPU и памяти у всех контейнеров; выселяется последним.
- **Burstable** — заданы requests, limits выше или отсутствуют.
- **BestEffort** — ничего не задано; выселяется первым.

Практические рекомендации (часто спорные — хорошо показать понимание компромисса):
- Память: limit ≈ request (память несжимаема, overcommit ведёт к OOM и eviction).
- CPU: многие отказываются от CPU limits для latency-чувствительных сервисов, оставляя корректные requests; метрика троттлинга — `container_cpu_cfs_throttled_periods_total`.
- Requests подбирать по фактическому потреблению (VPA в режиме рекомендаций, Goldilocks).
- Учитывать runtime: JVM/Go должны знать лимиты (`GOMAXPROCS`, automaxprocs, `GOMEMLIMIT`).

## Q: Чем отличаются liveness, readiness и startup пробы? Какие ошибки при их настройке бывают?
level: middle
type: theory
freq: 3
tags: пробы, надёжность

- **readinessProbe** — готов ли под **принимать трафик**. При провале под убирается из эндпоинтов Service, но **не перезапускается**.
- **livenessProbe** — жив ли процесс. При провале kubelet **перезапускает контейнер**. Нужна для выхода из дедлоков.
- **startupProbe** — пока не успешна, liveness и readiness не проверяются. Для медленно стартующих приложений.

Типы: HTTP GET, TCP socket, exec, gRPC.

Типичные ошибки:
- **Liveness проверяет внешние зависимости** (БД). БД моргнула → все поды одновременно перезапускаются → каскадный отказ. Liveness должна проверять только сам процесс.
- Одинаковые liveness и readiness — нет смысла и опасно.
- Слишком агрессивные таймауты (`timeoutSeconds: 1`) при GC-паузах → ложные рестарты.
- Нет readiness → трафик идёт на неготовый под при деплое → ошибки.
- Readiness, учитывающая зависимости, может быть оправдана, но приведёт к выводу всех подов из ротации, если общая зависимость упала.

## Q: Как работает Service в Kubernetes? Какие типы бывают?
level: middle
type: theory
freq: 3
tags: сеть, service

Service даёт стабильный виртуальный IP (**ClusterIP**) и DNS-имя (`svc.ns.svc.cluster.local`) для набора подов, выбранных по **selector**. Контроллер поддерживает **EndpointSlice** — список IP готовых подов.

**kube-proxy** на каждой ноде превращает Service в правила:
- **iptables** — DNAT на случайный под (вероятностные правила), O(n) правил;
- **IPVS** — хеш-таблицы ядра, лучше масштабируется, больше алгоритмов;
- или kube-proxy заменяется **eBPF** (Cilium).

ClusterIP не «пингуется» — это не интерфейс, а правило трансляции.

Типы:
- **ClusterIP** — внутри кластера.
- **NodePort** — порт 30000–32767 на каждой ноде.
- **LoadBalancer** — внешний балансировщик облака (через cloud-controller или MetalLB).
- **ExternalName** — CNAME на внешнее имя.
- **Headless** (`clusterIP: None`) — DNS возвращает IP подов напрямую; нужен StatefulSet для стабильных имён `pod-0.svc`.

Нюансы: `externalTrafficPolicy: Local` сохраняет IP клиента и убирает лишний хоп, но трафик идёт только на ноды с подами; `internalTrafficPolicy`, topology-aware routing для экономии межзонового трафика.

## Q: Ingress vs Gateway API. Как трафик доходит из интернета до пода?
level: senior
type: theory
freq: 2
tags: сеть, ingress

Путь: DNS → облачный L4/L7-балансировщик → (NodePort или напрямую IP подов) → **Ingress-контроллер** (nginx, Traefik, HAProxy, Envoy) → Service/эндпоинты → под.

**Ingress** — ресурс L7-маршрутизации по хосту и пути + TLS. Недостатки: ограниченная спецификация, всё нестандартное — через **аннотации** конкретного контроллера (непереносимо), одна сущность для владельцев инфраструктуры и разработчиков.

**Gateway API** — новый стандарт (GA с 2023):
- Ролевая модель: **GatewayClass** (провайдер инфраструктуры) → **Gateway** (оператор кластера: слушатели, порты, TLS) → **HTTPRoute/GRPCRoute/TCPRoute** (команды приложений).
- В спецификации: разделение трафика по весам (канарейки), матчинг по заголовкам, зеркалирование, межнеймспейсные ссылки через `ReferenceGrant`.
- Поддерживается Istio, Cilium, Envoy Gateway, NGINX Gateway Fabric, облачными провайдерами.

Важный контекст 2025–2026: проект **ingress-nginx** (community) объявлен к выводу из поддержки — хороший повод упомянуть миграцию на Gateway API.

## Q: Deployment, StatefulSet, DaemonSet, Job — когда что использовать?
level: middle
type: theory
freq: 3
tags: workloads

- **Deployment** — stateless-приложения. Поды взаимозаменяемы, случайные имена, rolling update через ReplicaSet'ы, откат (`kubectl rollout undo`).
- **StatefulSet** — stateful (БД, Kafka, ZooKeeper):
  - стабильные имена и DNS (`app-0`, `app-1`) через headless Service;
  - **отдельный PVC на каждую реплику** (`volumeClaimTemplates`), сохраняющийся при перезапуске;
  - упорядоченный старт/остановка/обновление (можно `Parallel`, `partition` для поэтапных обновлений).
- **DaemonSet** — по одному поду на каждую (или выбранные) ноду: агенты логов, мониторинга, CNI, CSI.
- **Job** — задача до успешного завершения (`completions`, `parallelism`, `backoffLimit`); **CronJob** — по расписанию (`concurrencyPolicy`, `startingDeadlineSeconds`).

Senior-вопрос «а стоит ли держать БД в Kubernetes?» — ответ с компромиссами: с операторами (CloudNativePG, Zalando, Percona) это реально, но нужна экспертиза в хранилище, бэкапах и сетевой задержке; managed-БД часто проще.

## Q: Как обеспечить zero-downtime при деплое и обслуживании нод?
level: senior
type: scenario
freq: 3
tags: деплой, надёжность

Rolling update сам по себе не гарантирует отсутствия ошибок. Чек-лист:

1. **Стратегия**: `maxUnavailable: 0`, `maxSurge: 25%` — новые поды поднимаются до удаления старых.
2. **readinessProbe** — трафик только на готовые поды.
3. **Graceful shutdown** с учётом гонки: удаление пода и удаление его из эндпоинтов происходят **параллельно**, kube-proxy и Ingress обновляются с задержкой. Поэтому:
   - `preStop: sleep 5–15` — под продолжает обслуживать запросы, пока его выводят из балансировки;
   - приложение по SIGTERM перестаёт принимать новые соединения и дорабатывает текущие;
   - `terminationGracePeriodSeconds` больше, чем preStop + время дообработки.
4. **PodDisruptionBudget** (`minAvailable`/`maxUnavailable`) — `kubectl drain` и автоскейлер не выселят слишком много подов одновременно.
5. **Anti-affinity / topologySpreadConstraints** — реплики на разных нодах и в разных зонах.
6. **Несколько реплик** (минимум 2–3) и HPA.
7. **Совместимость версий**: миграции БД по схеме expand/contract, обратная совместимость API между старой и новой версией (обе работают одновременно).
8. Для долгоживущих соединений (WebSocket, gRPC) — механизмы переподключения на клиенте.

## Q: Как работает автомасштабирование в Kubernetes?
level: senior
type: theory
freq: 3
tags: масштабирование

Три уровня:

1. **HPA** (Horizontal Pod Autoscaler) — меняет число реплик. Формула: `desired = ceil(current × currentMetric / targetMetric)`. Метрики: CPU/память (metrics-server, в процентах **от requests**), custom (Prometheus Adapter), external. Параметры `behavior` — скорость scale up/down, окно стабилизации (по умолчанию 300с на понижение).
2. **VPA** — подбирает requests/limits. Режимы Off (рекомендации), Initial, Auto (пересоздаёт поды; с 1.33+ доступно in-place resize). Нельзя использовать вместе с HPA по тем же метрикам CPU/памяти.
3. **Масштабирование нод**:
   - **Cluster Autoscaler** — добавляет ноды, если есть **Pending**-поды, которые поместятся в новую ноду из группы; удаляет недогруженные ноды. Работает с node groups/ASG.
   - **Karpenter** — подбирает тип инстанса под конкретные поды, быстрее, консолидация, spot.
4. **KEDA** — event-driven масштабирование по длине очереди Kafka/RabbitMQ/SQS, cron, в том числе **до нуля**.

Подводные камни: HPA по CPU бесполезен, если не заданы requests; задержка цепочки (метрика → HPA → pending → новая нода ~ минуты) — нужен запас или overprovisioning-поды с низким приоритетом; масштабирование по CPU не подходит для I/O-bound сервисов.

## Q: Как устроен RBAC в Kubernetes? Как дать CI-системе доступ только к одному namespace?
level: senior
type: practice
freq: 2
tags: безопасность, rbac

Субъекты: **User** и **Group** (из сертификата/OIDC, в Kubernetes не хранятся), **ServiceAccount** (объект в namespace).

Объекты:
- **Role** (namespace) / **ClusterRole** (кластер) — набор правил: `apiGroups`, `resources`, `verbs`.
- **RoleBinding** / **ClusterRoleBinding** — связывают роль с субъектами. RoleBinding может ссылаться на ClusterRole — права будут только в этом namespace (удобно переиспользовать роли).

Пример для CI:
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: deployer, namespace: app }
rules:
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "patch", "update"]
- apiGroups: [""]
  resources: ["services", "configmaps"]
  verbs: ["get", "list", "create", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: ci-deployer, namespace: app }
subjects:
- kind: ServiceAccount
  name: ci
  namespace: app
roleRef: { kind: Role, name: deployer, apiGroup: rbac.authorization.k8s.io }
```

Лучшие практики: короткоживущие токены (`kubectl create token`, projected tokens) вместо статических; аутентификация CI через **OIDC** (workload identity); не давать `secrets: list` (видит все секреты), `pods/exec`, `escalate`, `bind`, `impersonate`; проверка через `kubectl auth can-i --as`. Ещё лучше — GitOps, где CI вообще не ходит в кластер.

## Q: Что такое CNI и как работает сеть между подами на разных нодах?
level: senior
type: theory
freq: 2
tags: сеть, cni

Сетевая модель Kubernetes требует: **каждый под имеет свой IP**, поды общаются друг с другом **без NAT**, ноды видят поды. Реализацию отдают CNI-плагину — kubelet вызывает его при создании sandbox, плагин создаёт veth-пару, выдаёт IP (IPAM) и настраивает маршруты.

Способы доставки между нодами:
- **Overlay** (VXLAN, Geneve, IPIP) — пакет пода инкапсулируется в пакет ноды. Работает в любой сети, но оверхед и меньший MTU. Flannel, Calico IPIP/VXLAN.
- **Маршрутизация без инкапсуляции** — маршруты к pod CIDR анонсируются через BGP (Calico) или прописываются в облачные таблицы маршрутов.
- **Нативные IP облака** — AWS VPC CNI выдаёт подам адреса из подсети VPC (нет оверлея, но расход IP и лимиты ENI на ноду).
- **eBPF** (Cilium) — маршрутизация и Service без iptables, L7-политики, наблюдаемость (Hubble).

**NetworkPolicy** реализуется именно CNI (Flannel их не поддерживает!). По умолчанию весь трафик разрешён — хорошая практика: default deny + явные разрешения, не забыв про DNS (UDP/TCP 53 к kube-dns).

## Q: Как организовано хранение данных в Kubernetes: PV, PVC, StorageClass, CSI?
level: middle
type: theory
freq: 2
tags: хранение

- **PersistentVolume (PV)** — ресурс хранилища в кластере (диск, NFS-шар).
- **PersistentVolumeClaim (PVC)** — запрос приложения: размер, режим доступа.
- **StorageClass** — «тип» хранилища и параметры **динамического провижининга**: при создании PVC провижинер (CSI-драйвер) сам создаёт диск и PV.
- **CSI** — стандартный интерфейс драйверов хранилищ (EBS, Ceph RBD, Longhorn).

Режимы доступа: **RWO** (одна нода), **RWX** (много нод — NFS, CephFS, EFS), **ROX**, **RWOP** (один под).

Важные параметры:
- `reclaimPolicy`: **Delete** (по умолчанию для динамических — диск удалится вместе с PVC!) или **Retain**.
- `volumeBindingMode: WaitForFirstConsumer` — диск создаётся в зоне, куда запланирован под (иначе под и диск могут оказаться в разных AZ).
- `allowVolumeExpansion` — увеличение без пересоздания.
- **VolumeSnapshot** — снапшоты через CSI; для бэкапа кластера целиком — Velero.

## Q: Как вы обновляете Kubernetes-кластер? Как бэкапить etcd?
level: senior
type: practice
freq: 2
tags: эксплуатация, etcd

**Обновление** (на одну минорную версию за раз):
1. Прочитать changelog, найти **удалённые API** (`kubent`, `pluto`), проверить совместимость аддонов (CNI, Ingress, CSI, операторов).
2. Бэкап etcd.
3. Обновить **control plane** (сначала API-серверы, потом controller-manager/scheduler). Версии kubelet могут отставать от API-сервера (до 3 минорных версий), но не опережать его.
4. Обновить ноды: `cordon` → `drain` (уважая PDB) → обновить kubelet → `uncordon`; в облаке чаще — **замена нод** (новая node group, перенос нагрузки).
5. Проверить работоспособность, метрики, smoke-тесты. Сначала — на staging-кластере.

Альтернатива для минимизации риска — **blue/green кластеры**: поднять новый кластер и переключать трафик.

**Бэкап etcd**:
```bash
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-$(date +%F).db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```
Восстановление — `etcdutl snapshot restore` в новый data-dir на всех членах кластера. Бэкап etcd не включает данные в PV — для этого Velero/снапшоты. В managed-кластерах (EKS/GKE) etcd обслуживает провайдер, но бэкап ресурсов (GitOps-репозиторий + Velero) всё равно нужен.

## Q: Как управлять размещением подов: nodeSelector, affinity, taints, topology spread?
level: middle
type: theory
freq: 2
tags: scheduling

- **nodeSelector** — простое совпадение лейблов ноды.
- **nodeAffinity** — выразительные правила: `requiredDuringScheduling...` (жёстко) и `preferred...` (с весом).
- **podAffinity / podAntiAffinity** — размещение относительно других подов (рядом с кешем; реплики не на одной ноде) по `topologyKey` (`kubernetes.io/hostname`, `topology.kubernetes.io/zone`). Дорого на больших кластерах.
- **topologySpreadConstraints** — равномерное распределение по зонам/нодам с допустимым перекосом `maxSkew`. Предпочтительнее anti-affinity для HA.
- **Taints/tolerations** — нода **отталкивает** поды без соответствующего toleration (`NoSchedule`, `PreferNoSchedule`, `NoExecute` — выселяет уже запущенные). Применение: выделенные GPU-ноды, ноды для системных компонентов, spot-ноды. Важно: toleration **разрешает**, но не **притягивает** — для выделенных нод нужно taint + affinity вместе.
- **PriorityClass** и вытеснение — критичные поды вытесняют менее важные.

## Q: Что такое оператор и CRD? Когда стоит писать свой оператор?
level: senior
type: theory
freq: 2
tags: расширяемость

**CRD** (CustomResourceDefinition) расширяет API Kubernetes новым типом ресурса (например, `PostgresCluster`), с OpenAPI-схемой и валидацией. Сам по себе CRD — только хранение данных в etcd.

**Оператор** = CRD + **контроллер**, который реализует reconcile-цикл для этого ресурса и кодирует операционные знания: создание кластера БД, failover, бэкапы, обновления, масштабирование.

Примеры: Prometheus Operator, cert-manager, CloudNativePG, Strimzi (Kafka), ArgoCD, Crossplane.

Писать свой оператор (Kubebuilder, Operator SDK, kopf на Python) стоит, когда:
- есть сложный **stateful**-жизненный цикл, который нельзя выразить Helm-чартом;
- нужно непрерывное согласование, а не однократная установка;
- готового зрелого оператора нет.

Не стоит, если хватает Helm/Kustomize + GitOps — оператор — это код, который придётся поддерживать, тестировать и обновлять (идемпотентность reconcile, finalizers, status, обработка конфликтов версий).

## Q: Что такое pause-контейнер и зачем он нужен в поде?
level: senior
type: theory
freq: 2
tags: pod, архитектура

**Pause-контейнер** (infra container, образ `registry.k8s.io/pause`) — первый контейнер, который kubelet через CRI создаёт для каждого пода (**pod sandbox**). Это крошечный процесс (несколько сотен КБ), который почти всё время спит в `pause()`.

Зачем он нужен:
1. **Держит namespaces пода.** Именно pause-контейнер владеет **network namespace** (и IPC, иногда UTS). CNI-плагин настраивает сеть (veth, IP-адрес) для него, а все остальные контейнеры пода присоединяются к его namespace. Поэтому:
   - все контейнеры пода имеют **один IP** и общаются через `localhost`;
   - контейнеры пода не могут слушать один и тот же порт;
   - если приложение упало и перезапустилось, **IP пода не меняется** и CNI не нужно заново вызывать — namespace живёт, пока жив pause.
2. **PID 1 и «жнец» зомби.** При `shareProcessNamespace: true` pause становится PID 1 общего PID namespace и подбирает осиротевшие процессы (вызывает `wait()`), предотвращая накопление зомби.

Жизненный цикл: sandbox создаётся первым и удаляется последним; перезапуск приложения внутри пода не пересоздаёт sandbox. Если умирает сам pause-контейнер — пересоздаётся весь под (новый IP).

Где увидеть: на ноде `crictl pods` (sandbox'ы) и `crictl ps -a`; в Docker-эпоху — контейнеры `k8s_POD_...` в `docker ps`. Образ pause должен быть доступен на нодах — в закрытых контурах его нужно зеркалировать в свой реестр (настройка `sandbox_image` в containerd), иначе поды висят в `ContainerCreating`.
