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

## Q: Напишите манифест Deployment. Что такое ResourceQuota и LimitRange?
level: middle
type: practice
freq: 3
tags: deployment, манифест, квоты

Минимально грамотный Deployment с ресурсами, пробами и безопасным контекстом:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: shop
  labels: { app: api }
spec:
  replicas: 3
  revisionHistoryLimit: 5
  selector:
    matchLabels: { app: api }          # должен совпадать с labels шаблона; неизменяем
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
  template:
    metadata:
      labels: { app: api }
    spec:
      serviceAccountName: api
      securityContext: { runAsNonRoot: true, runAsUser: 10001 }
      containers:
      - name: api
        image: registry.example.com/shop/api:1.4.2
        ports:
        - containerPort: 8080
        env:
        - name: DB_HOST
          valueFrom: { configMapKeyRef: { name: api-config, key: db_host } }
        - name: DB_PASSWORD
          valueFrom: { secretKeyRef: { name: api-secrets, key: db_password } }
        resources:
          requests: { cpu: 200m, memory: 256Mi }
          limits: { memory: 256Mi }
        readinessProbe:
          httpGet: { path: /ready, port: 8080 }
          periodSeconds: 5
        livenessProbe:
          httpGet: { path: /healthz, port: 8080 }
          initialDelaySeconds: 10
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities: { drop: ["ALL"] }
        lifecycle:
          preStop: { exec: { command: ["sleep", "10"] } }
      terminationGracePeriodSeconds: 40
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: ScheduleAnyway
        labelSelector: { matchLabels: { app: api } }
```
Что стоит проговорить: связь `selector` ↔ `labels` (по ним Deployment находит свои ReplicaSet и поды, а Service — эндпоинты), фиксированный тег образа вместо `latest`, секреты через `secretKeyRef`, к Deployment обычно добавляют Service, PDB и HPA.

**ResourceQuota** — ограничивает **суммарное** потребление ресурсов в **namespace**:
```yaml
apiVersion: v1
kind: ResourceQuota
metadata: { name: team-quota, namespace: shop }
spec:
  hard:
    requests.cpu: "20"
    requests.memory: 40Gi
    limits.memory: 60Gi
    pods: "100"
    services.loadbalancers: "2"
    persistentvolumeclaims: "20"
    requests.storage: 500Gi
```
Если квота задана на `requests.cpu`, то **каждый** под в namespace обязан указывать requests, иначе API-сервер его отклонит. При превышении квоты новые поды не создаются: ошибка `exceeded quota` появляется в событиях ReplicaSet, а не пода. Состояние смотрят командой `kubectl describe quota -n shop`.

**LimitRange** — ограничения и значения по умолчанию для **каждого отдельного** контейнера, пода или PVC в namespace:
```yaml
apiVersion: v1
kind: LimitRange
metadata: { name: defaults, namespace: shop }
spec:
  limits:
  - type: Container
    defaultRequest: { cpu: 100m, memory: 128Mi }   # подставится, если requests не указаны
    default: { memory: 256Mi }                      # limits по умолчанию
    max: { cpu: "2", memory: 4Gi }
    min: { cpu: 50m, memory: 64Mi }
```
Вместе они дают multi-tenant кластер: квота делит ресурсы между командами, LimitRange не даёт одному поду забрать всё и подставляет значения по умолчанию, чтобы поды без requests проходили квоту.

## Q: Что такое ConfigMap и Secret? Как передать их в под?
level: middle
type: practice
freq: 3
tags: configmap, secret

**ConfigMap** — неконфиденциальная конфигурация (ключ-значение или целые файлы). **Secret** — то же самое для чувствительных данных: пароли, токены, TLS-сертификаты. Значения в Secret хранятся в **base64 — это кодирование, а не шифрование**. Защиту дают RBAC, шифрование etcd и внешние хранилища секретов.

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: app-config }
data:
  LOG_LEVEL: info
  app.yaml: |
    cache:
      ttl: 60
---
apiVersion: v1
kind: Secret
metadata: { name: app-secrets }
type: Opaque
stringData:                     # stringData — без ручного base64
  DB_PASSWORD: s3cr3t
```
Создать из командной строки: `kubectl create configmap app-config --from-file=app.yaml --from-literal=LOG_LEVEL=info`, `kubectl create secret generic app-secrets --from-literal=DB_PASSWORD=...`.

**Способы передачи в под:**
```yaml
containers:
- name: app
  env:
  - name: LOG_LEVEL                          # 1. одна переменная
    valueFrom: { configMapKeyRef: { name: app-config, key: LOG_LEVEL } }
  - name: DB_PASSWORD
    valueFrom: { secretKeyRef: { name: app-secrets, key: DB_PASSWORD } }
  envFrom:                                   # 2. все ключи как переменные
  - configMapRef: { name: app-config }
  volumeMounts:                              # 3. как файлы
  - { name: config, mountPath: /etc/app, readOnly: true }
volumes:
- name: config
  configMap: { name: app-config }
```

**Важные нюансы:**
- **Переменные окружения не обновляются** при изменении ConfigMap — нужен перезапуск пода (`kubectl rollout restart deployment/app`). Файлы из volume обновляются автоматически (с задержкой до минуты), но только если не используется `subPath`, и приложение должно само перечитать файл.
- Частый приём для автоматического рестарта: добавить хеш конфигурации в аннотацию шаблона пода (в Helm — `checksum/config`) или использовать Reloader.
- Если ConfigMap или Secret не существует, под не стартует (`CreateContainerConfigError`), если ссылка не помечена `optional: true`.
- Ограничение размера — 1 МБ.
- `immutable: true` для неизменяемых конфигураций снижает нагрузку на API-сервер.
- Секреты в Git хранить только зашифрованными (Sealed Secrets, SOPS) или брать из Vault через External Secrets Operator.

## Q: Что такое namespace, labels, selectors и annotations в Kubernetes?
level: middle
type: theory
freq: 2
tags: namespace, labels

**Namespace** — логическое разделение кластера: команды, окружения, приложения.
- Имена ресурсов уникальны внутри namespace.
- На namespace навешиваются RBAC, ResourceQuota, LimitRange, NetworkPolicy, Pod Security.
- Системные: `default`, `kube-system`, `kube-public`, `kube-node-lease`.
- Некоторые ресурсы не принадлежат namespace: Node, PersistentVolume, StorageClass, ClusterRole, CRD, сами Namespace (`kubectl api-resources --namespaced=false`).
- DNS между namespace: `service.namespace.svc.cluster.local`.
- Namespace — **не граница сетевой изоляции**: без NetworkPolicy поды разных namespace видят друг друга.

**Labels** — пары ключ-значение на объектах для **идентификации и выборки**: `app: api`, `tier: backend`, `env: prod`. Рекомендуемые: `app.kubernetes.io/name`, `app.kubernetes.io/instance`, `app.kubernetes.io/version`, `app.kubernetes.io/part-of`.

**Selectors** — выборка объектов по меткам. На них построена связь объектов друг с другом:
- Service находит свои поды по `selector`;
- Deployment/ReplicaSet управляет подами по `matchLabels`;
- NetworkPolicy, PDB, HPA, nodeSelector тоже используют метки.

```bash
kubectl get pods -l app=api,env=prod
kubectl get pods -l 'env in (prod,stage)'
kubectl label pod api-xyz debug=true
```
Частая ошибка: Service не видит поды из-за несовпадения меток (`kubectl get endpoints <svc>` пустой).

**Annotations** — тоже ключ-значение, но **не для выборки**, а для произвольных метаданных и настройки инструментов: `prometheus.io/scrape: "true"`, настройки Ingress-контроллера (`nginx.ingress.kubernetes.io/rewrite-target`), `kubernetes.io/change-cause`, информация о сборке и владельце. Могут быть большими (до 256 КБ суммарно).

## Q: Какие команды kubectl вы используете чаще всего?
level: middle
type: practice
freq: 3
tags: kubectl

```bash
# Контекст и namespace
kubectl config get-contexts
kubectl config use-context prod
kubectl config set-context --current --namespace=shop     # или kubens / kubectx

# Просмотр
kubectl get pods -o wide                     # IP и нода
kubectl get all -n shop
kubectl get pod api-xyz -o yaml              # полный манифест с status
kubectl describe pod api-xyz                 # события — первое место для диагностики
kubectl get events --sort-by=.lastTimestamp
kubectl top pods --sort-by=memory            # нужен metrics-server
kubectl explain deployment.spec.strategy     # документация по полям

# Логи и отладка
kubectl logs api-xyz -c app --previous -f --tail=100
kubectl logs -l app=api --all-containers --since=15m
kubectl exec -it api-xyz -- sh
kubectl port-forward svc/api 8080:80         # доступ к сервису с ноутбука
kubectl debug -it api-xyz --image=nicolaka/netshoot --target=app
kubectl cp api-xyz:/tmp/dump.hprof ./dump.hprof

# Изменения
kubectl apply -f manifests/                  # декларативно
kubectl diff -f manifests/                   # что изменится
kubectl scale deployment api --replicas=5
kubectl set image deployment/api app=registry/api:1.5.0

# Деплой и откат
kubectl rollout status deployment/api
kubectl rollout history deployment/api
kubectl rollout undo deployment/api --to-revision=3
kubectl rollout restart deployment/api       # перезапустить поды (например, после смены ConfigMap)

# Ноды
kubectl cordon node-1; kubectl drain node-1 --ignore-daemonsets --delete-emptydir-data
kubectl uncordon node-1

# Права
kubectl auth can-i create deployments -n shop
```
Полезные инструменты: **k9s** (терминальный UI), kubectx/kubens, stern (логи нескольких подов), алиас `k=kubectl` и автодополнение. На проде — осторожность с `delete` и обязательная проверка текущего контекста.

## Q: Что такое Helm? Как устроен чарт и как обновлять и откатывать релизы?
level: middle
type: practice
freq: 3
tags: helm

**Helm** — пакетный менеджер для Kubernetes. **Чарт** — шаблонизированный набор манифестов; **релиз** — установленный экземпляр чарта в кластере с конкретными значениями.

**Структура чарта:**
```
mychart/
  Chart.yaml          # имя, версия чарта (version) и приложения (appVersion), зависимости
  values.yaml         # значения по умолчанию
  values.schema.json  # (опционально) валидация values
  templates/
    deployment.yaml   # шаблоны Go template + функции Sprig
    service.yaml
    _helpers.tpl      # именованные шаблоны (метки, имена)
    NOTES.txt         # подсказка после установки
  charts/             # зависимости (subcharts)
```
Фрагмент шаблона:
```yaml
spec:
  replicas: {{ .Values.replicaCount }}
  template:
    spec:
      containers:
      - name: app
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
        {{- with .Values.resources }}
        resources: {{- toYaml . | nindent 10 }}
        {{- end }}
```

**Основные команды:**
```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts && helm repo update
helm install shop ./mychart -n shop --create-namespace -f values-prod.yaml
helm upgrade --install shop ./mychart -f values-prod.yaml --set image.tag=1.5.0 --atomic --wait
helm list -n shop
helm history shop -n shop
helm rollback shop 3 -n shop
helm template ./mychart -f values-prod.yaml    # отрендерить локально, не применяя
helm diff upgrade shop ./mychart -f values-prod.yaml   # плагин helm-diff
helm lint ./mychart
helm uninstall shop -n shop
```
- `upgrade --install` — идемпотентная команда для CI: установит, если релиза нет.
- `--atomic` — при неудаче автоматически откатиться; `--wait` — дождаться готовности ресурсов.
- Приоритет значений: `values.yaml` чарта < файлы `-f` (по порядку) < `--set`.
- История релизов хранится в Secret'ах в namespace релиза.

**Хорошие практики:** фиксировать версии чартов, хранить values для каждого окружения в Git, публиковать чарты в OCI-реестр (`helm push`), не держать секреты в values открытым текстом (helm-secrets/SOPS, External Secrets), использовать Helm через GitOps (ArgoCD, Flux) или helmfile.

## Q: Helm или Kustomize — что выбрать?
level: middle
type: theory
freq: 2
tags: helm, kustomize

**Kustomize** — встроен в kubectl (`kubectl apply -k`). Работает **без шаблонов**: берёт обычные YAML-манифесты (**base**) и накладывает на них изменения для окружений (**overlays**) через патчи.
```
base/
  deployment.yaml  service.yaml  kustomization.yaml
overlays/
  prod/kustomization.yaml
```
```yaml
# overlays/prod/kustomization.yaml
resources: [../../base]
namespace: shop-prod
images:
- name: registry/api
  newTag: "1.5.0"
patches:
- target: { kind: Deployment, name: api }
  patch: |
    - op: replace
      path: /spec/replicas
      value: 5
configMapGenerator:
- name: app-config
  literals: [LOG_LEVEL=warn]     # имя получит хеш-суффикс → автоматический рестарт подов
```

| | Helm | Kustomize |
|---|---|---|
| Подход | шаблоны + values | патчи поверх чистого YAML |
| Пакетирование и распространение | да: чарты, репозитории, версии, зависимости | нет |
| Жизненный цикл | релизы, история, rollback, hooks | нет, только генерация манифестов |
| Порог входа | шаблоны Go бывает тяжело читать и отлаживать | проще, манифесты остаются валидным YAML |
| Готовые сторонние приложения | огромная экосистема чартов | мало |

**Практический ответ:**
- для **сторонних** приложений (ingress-nginx, Prometheus, cert-manager) — Helm-чарты;
- для **собственных** сервисов — по вкусу команды: свой Helm-чарт (часто один общий «библиотечный» чарт на все микросервисы) или Kustomize с overlays;
- их можно **комбинировать**: Kustomize умеет рендерить Helm-чарты (`helmCharts:`), ArgoCD поддерживает оба варианта.

## Q: Что такое service mesh? Istio, Linkerd, Cilium — в чём разница и когда mesh действительно нужен?
level: senior
type: theory
freq: 2
tags: service-mesh, istio, linkerd

**Service mesh** — инфраструктурный слой, который берёт на себя сетевое взаимодействие между сервисами **без изменения их кода**:
- **безопасность**: автоматический **mTLS** между всеми сервисами, идентичность сервисов (SPIFFE), авторизация «кто к кому может обращаться» на уровне L7;
- **управление трафиком**: канареечные и blue-green релизы по весам и заголовкам, ретраи, таймауты, circuit breaking, зеркалирование трафика, fault injection;
- **наблюдаемость**: единообразные метрики RED для всех сервисов, распределённый трейсинг (распространение заголовков всё равно нужно в приложении), карта зависимостей.

**Архитектура:** **data plane** — прокси, через которые идёт трафик; **control plane** — раздаёт им конфигурацию и сертификаты.

**Модели data plane:**
- **Sidecar** — прокси (обычно Envoy) в каждом поде, трафик перехватывается через iptables. Минусы: дополнительные CPU и память на каждый под, задержка, сложности с порядком запуска контейнеров и Job'ами.
- **Ambient mode (Istio)** — без sidecar: L4 и mTLS обеспечивает общий узловой прокси **ztunnel**, а L7-функции — опциональные **waypoint**-прокси на namespace или сервис. Меньше накладных расходов.
- **eBPF / узловой прокси (Cilium Service Mesh)** — часть функций в ядре через eBPF, L7 — через Envoy на ноде.

**Сравнение:**
| | Istio | Linkerd | Cilium |
|---|---|---|---|
| Прокси | Envoy (sidecar или ambient) | собственный лёгкий прокси на Rust | eBPF + Envoy на ноде |
| Возможности | максимальные: сложная маршрутизация, внешний трафик, мультикластер | основное (mTLS, ретраи, метрики) с минимальной настройкой | mesh как продолжение CNI |
| Сложность | высокая | низкая | средняя, если Cilium уже используется как CNI |

**Когда mesh нужен:** десятки и сотни микросервисов, требования к шифрованию всего внутреннего трафика (zero trust, регуляторы), сложные стратегии выкатки, разные языки (нельзя решить всё одной библиотекой).

**Когда не нужен:** несколько сервисов, команда без опыта эксплуатации — mesh добавляет сложный компонент, который сам может стать причиной инцидентов. Часть задач решается проще: mTLS — через cert-manager или CNI с шифрованием (Cilium, WireGuard), канарейки — Argo Rollouts с Ingress, метрики — библиотеками.

## Q: Как в Istio сделать канареечный релиз, ретраи и включить mTLS? Как отлаживать проблемы mesh?
level: senior
type: practice
freq: 2
tags: istio, канарейка, mtls

**Канарейка 90/10 и ретраи** (классический API Istio; в новых установках то же можно описать через Gateway API `HTTPRoute`):
```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata: { name: reviews }
spec:
  host: reviews
  subsets:                                  # версии по меткам подов
  - { name: v1, labels: { version: v1 } }
  - { name: v2, labels: { version: v2 } }
  trafficPolicy:
    outlierDetection:                       # выкидывать неисправные поды из балансировки
      consecutive5xxErrors: 5
      interval: 10s
      baseEjectionTime: 30s
---
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: { name: reviews }
spec:
  hosts: [reviews]
  http:
  - match:
    - headers: { x-canary: { exact: "true" } }   # тестировщики идут на v2 по заголовку
    route: [{ destination: { host: reviews, subset: v2 } }]
  - route:
    - { destination: { host: reviews, subset: v1 }, weight: 90 }
    - { destination: { host: reviews, subset: v2 }, weight: 10 }
    timeout: 3s
    retries: { attempts: 2, perTryTimeout: 1s, retryOn: "5xx,connect-failure,reset" }
```
Автоматизировать постепенное увеличение веса с откатом по метрикам — **Argo Rollouts** или **Flagger**.

**Строгий mTLS** для namespace:
```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata: { name: default, namespace: shop }
spec:
  mtls: { mode: STRICT }      # PERMISSIVE — принимать и mTLS, и открытый трафик (для миграции)
```
Плюс **AuthorizationPolicy** — какие сервисы (по ServiceAccount) могут обращаться к каким и с какими методами и путями.

**Отладка:**
- `istioctl analyze` — ошибки конфигурации (VirtualService ссылается на несуществующий subset и т.д.);
- `istioctl proxy-status` — синхронизирована ли конфигурация прокси с control plane;
- `istioctl proxy-config routes|clusters|endpoints <pod>` — что реально получил Envoy;
- логи `istio-proxy`: **флаги ответа Envoy** в access log многое объясняют: `UF` (upstream connection failure), `UH` (нет здоровых эндпоинтов), `URX` (исчерпаны ретраи), `NR` (нет маршрута), `UC` (апстрим закрыл соединение);
- типичные проблемы: **503 после включения STRICT mTLS** (клиент без sidecar), ретраи mesh **поверх** ретраев приложения (лавина запросов), sidecar ещё не готов, когда приложение уже делает запросы при старте (`holdApplicationUntilProxyStarts`), Job'ы не завершаются из-за живого sidecar (решено native sidecars в Kubernetes 1.29+).

## Q: Что такое init-контейнеры и sidecar-контейнеры? Что изменили native sidecars?
level: middle
type: theory
freq: 2
tags: pod, init, sidecar

**Init-контейнеры** запускаются **до** основных контейнеров пода, **по очереди**, каждый должен **успешно завершиться**. Если init-контейнер падает, kubelet перезапускает его (по `restartPolicy` пода), а основные контейнеры не стартуют.

Применение:
- дождаться зависимости (`until nc -z db 5432; do sleep 2; done` — хотя приложению всё равно лучше уметь ретраить);
- подготовить данные: миграции схемы (с оговорками), скачивание конфигурации или моделей, генерация файлов в общий `emptyDir`;
- выставить права на volume (`chown`), параметры ядра в привилегированном init-контейнере;
- образ init-контейнера может содержать утилиты, которых нет (и не должно быть) в основном образе.

**Sidecar** — вспомогательный контейнер, работающий **параллельно** с основным весь срок жизни пода: прокси service mesh (Envoy), агент сбора логов, Vault Agent, cloud-sql-proxy, синхронизация файлов.

**Проблемы «старых» sidecar** (просто второй контейнер в `containers`):
- нет гарантии порядка: приложение стартует раньше прокси и не может сделать первые запросы;
- **Job не завершается**, пока жив sidecar (основной контейнер закончил работу, а Envoy работает вечно);
- при остановке пода sidecar может завершиться раньше приложения и оборвать его последние запросы.

**Native sidecars** (стабильны с Kubernetes 1.33, доступны с 1.29): sidecar объявляется в **`initContainers` с `restartPolicy: Always`**:
```yaml
spec:
  initContainers:
  - name: log-shipper
    image: fluent-bit:3
    restartPolicy: Always          # это делает init-контейнер sidecar'ом
  - name: migrate
    image: app:1.4
    command: ["./migrate"]         # обычный init — выполнится после старта sidecar
  containers:
  - name: app
    image: app:1.4
```
Гарантии: sidecar стартует **до** основных контейнеров (и следующих init-контейнеров) и может иметь startupProbe; живёт весь срок пода и перезапускается при падении; **не мешает завершению Job**; при остановке пода завершается **после** основных контейнеров.

## Q: Namespace завис в состоянии Terminating. Почему и как это исправить?
level: senior
type: scenario
freq: 2
tags: finalizers, траблшутинг

При удалении namespace Kubernetes удаляет все объекты в нём. Namespace остаётся в `Terminating`, пока внутри что-то не удалилось. Почти всегда причина — **finalizers**.

**Finalizer** — метка в `metadata.finalizers`, которая говорит: «прежде чем удалить объект, контроллер X должен выполнить очистку» (удалить облачный балансировщик, диск, DNS-запись, внешнюю БД). Объект получает `deletionTimestamp`, но удаляется из etcd только после того, как все finalizers сняты соответствующими контроллерами.

**Почему зависает:**
- контроллер, который должен снять finalizer, **удалён или не работает** (удалили оператор раньше его ресурсов; сломался ingress- или storage-контроллер);
- **API-сервис агрегации недоступен** (`kubectl get apiservice` → `False (MissingEndpoints)`, часто metrics-server или удалённый адаптер): namespace-контроллер не может перечислить ресурсы этого API и не может завершить удаление;
- внешний ресурс не удаётся удалить (нет прав в облаке, ресурс защищён).

**Диагностика:**
```bash
kubectl get namespace shop -o json | jq '.status.conditions'
# NamespaceDeletionContentFailure / NamespaceFinalizersRemaining подскажут, что мешает
kubectl api-resources --verbs=list --namespaced -o name \
  | xargs -n 1 kubectl get --show-kind --ignore-not-found -n shop
kubectl get apiservice | grep False
```

**Исправление (правильный порядок):**
1. Починить причину: вернуть контроллер или оператор, починить или удалить сломанный APIService.
2. Если контроллера больше не будет — **осознанно** снять finalizer с конкретного объекта:
   `kubectl patch <kind>/<name> -n shop --type=merge -p '{"metadata":{"finalizers":null}}'`
   Понимая последствия: внешние ресурсы (балансировщик, диск, запись в БД) **останутся** и их нужно удалить вручную, иначе они будут стоить денег или висеть мусором.
3. Крайняя мера для самого namespace — удаление `spec.finalizers` через `/finalize` API. Это скрывает проблему, а не решает её.

**Профилактика:** удалять ресурсы операторов **до** удаления самого оператора (в Helm и GitOps — порядок удаления), следить за состоянием APIService.

## Q: Нода перешла в состояние NotReady. Как диагностировать?
level: senior
type: scenario
freq: 3
tags: node, траблшутинг

**NotReady** означает, что **kubelet** перестал сообщать о здоровье ноды API-серверу (lease не обновляется) или сам сообщает о проблеме. Через некоторое время (по умолчанию около 5 минут) поды с ноды начинают выселяться (taint `node.kubernetes.io/unreachable` / `not-ready` с `NoExecute` и `tolerationSeconds: 300`).

**1. Со стороны кластера:**
```bash
kubectl describe node node-3
# Conditions: Ready, MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable
# Events и время последнего heartbeat
kubectl get pods -A -o wide --field-selector spec.nodeName=node-3
```

**2. На самой ноде** (если доступна по SSH или через консоль облака):
- `systemctl status kubelet`, `journalctl -u kubelet -e` — почему kubelet упал или не может работать: сертификат истёк, не может связаться с API-сервером, ошибки CNI (`network plugin is not ready: cni config uninitialized`), ошибки рантайма;
- `systemctl status containerd`, `crictl ps`, `crictl info`;
- **ресурсы**: `df -h` и `df -i` (заполненный диск под `/var/lib/containerd` или `/var/lib/kubelet` → DiskPressure), `free -m`, OOM killer в `dmesg` (убил kubelet или containerd), исчерпание PID;
- **сеть**: доступен ли API-сервер (`curl -k https://<apiserver>:6443/healthz`), DNS, MTU, файрвол, маршруты;
- **время**: рассинхронизация часов ломает проверку сертификатов;
- **ядро и железо**: `dmesg -T` — ошибки дисков, сетевой карты, kernel panic, зависания.

**3. Нода недоступна целиком** — проблема ВМ или железа: консоль облака, статус-проверки инстанса, гипервизор, сеть (security groups, NACL после изменений).

**Частые причины:** заполненный диск (образы, логи контейнеров, emptyDir), нехватка памяти без резерва для системы (`systemReserved` / `kubeReserved` не заданы → OOM убивает системные процессы), сбой CNI-пода на ноде, истёкшие сертификаты kubelet (без ротации), проблемы с рантаймом, сетевая изоляция ноды.

**Митигация:** `kubectl cordon` + `drain` (если нода частично работает), в облаке — **заменить ноду** (автоматически через node auto-repair в managed-кластерах, Machine Health Checks в Cluster API), затем разбираться с причиной по логам, если они сохранились.

## Q: Что такое eviction? Почему поды выселяются с ноды и как это предотвратить?
level: senior
type: theory
freq: 2
tags: eviction, ресурсы

**Eviction** — kubelet принудительно завершает поды, когда на ноде заканчивается несжимаемый ресурс:
- **memory.available** (по умолчанию порог < 100Mi);
- **nodefs.available / imagefs.available** — свободное место на диске (по умолчанию < 10% / < 15%), а также inode'ы;
- **pid.available**.

При превышении порога нода получает условие `MemoryPressure` / `DiskPressure` / `PIDPressure` и taint, новые поды на неё не планируются, а kubelet выселяет поды в порядке:
1. поды, **превысившие свои requests** по этому ресурсу (больше всего сверх запроса — первыми);
2. с учётом **PriorityClass**;
3. по QoS: фактически **BestEffort** → **Burstable** → **Guaranteed** (последним).
Выселенный под получает статус `Failed` с причиной `Evicted`; контроллер (ReplicaSet) создаёт замену на другой ноде.

**Ephemeral storage** — частая неочевидная причина выселений: логи контейнеров, записываемый слой контейнера и `emptyDir` расходуют диск ноды. Под можно ограничить:
```yaml
resources:
  requests: { ephemeral-storage: 1Gi }
  limits:   { ephemeral-storage: 4Gi }   # превышение → под выселяется
volumes:
- name: tmp
  emptyDir: { sizeLimit: 2Gi }
```

**Мягкие и жёсткие пороги:** `evictionHard` (выселение сразу), `evictionSoft` + grace period. **Резервирование** ресурсов для системы: `systemReserved`, `kubeReserved` — иначе поды съедают всю память, и OOM убивает kubelet или containerd, а нода становится NotReady.

**Отличия от других механизмов:**
- **OOMKilled** — ядро убивает контейнер при превышении его собственного **limit** памяти (cgroup), это не eviction;
- **preemption** — планировщик вытесняет поды с низким приоритетом, чтобы разместить высокоприоритетный под;
- **API-initiated eviction** — при `kubectl drain`, уважает **PodDisruptionBudget**. Выселение kubelet'ом из-за нехватки ресурсов PDB **не учитывает**.

**Как предотвратить:**
- корректные **requests** по реальному потреблению (поды сверх requests выселяются первыми);
- requests = limits для памяти у критичных сервисов (Guaranteed);
- лимиты ephemeral-storage и `sizeLimit` для emptyDir, ротация логов контейнеров (`containerLogMaxSize` в kubelet);
- очистка образов (kubelet делает GC образов по порогам `imageGCHighThresholdPercent`);
- **PriorityClass** для критичных компонентов;
- мониторинг давления на нодах и алерты до наступления порогов.

## Q: Что такое admission controllers и webhooks? Какие с ними бывают проблемы?
level: senior
type: theory
freq: 2
tags: admission, политики

**Admission controllers** — этап обработки запроса в API-сервере **после аутентификации и авторизации, но до записи в etcd**. Могут **изменить** объект (mutating) или **отклонить** запрос (validating).

**Встроенные контроллеры** (включаются флагами API-сервера): `NamespaceLifecycle`, `LimitRanger` (подставляет значения по умолчанию), `ResourceQuota`, `ServiceAccount`, `DefaultStorageClass`, `PodSecurity` (Pod Security Admission), `NodeRestriction` и др.

**Динамические webhooks:**
- **MutatingAdmissionWebhook** — внешний HTTPS-сервис изменяет объект: инжекция sidecar (Istio, Vault Agent), добавление меток и значений по умолчанию;
- **ValidatingAdmissionWebhook** — внешний сервис разрешает или запрещает: **Kyverno**, **OPA Gatekeeper**, проверки подписей образов, кастомные правила;
- **ValidatingAdmissionPolicy** (стабильна с 1.30) — правила на **CEL** выполняются **внутри API-сервера** без внешнего webhook: быстрее и надёжнее для простых проверок. Появляется и **MutatingAdmissionPolicy**.

Порядок: mutating webhooks → валидация схемы → validating webhooks.

**Проблемы и риски:**
- **Webhook недоступен** → при `failurePolicy: Fail` API-сервер **отклоняет все подходящие запросы**. Если правило охватывает поды во всех namespace, а сам webhook работает как под, который не может запуститься, — получаем «мёртвую петлю»: кластер не может создать ни одного пода, включая сам webhook. При `failurePolicy: Ignore` — политики молча не применяются.
- **Латентность**: каждый webhook добавляет задержку к запросам API, особенно при массовых операциях.
- Неправильный `namespaceSelector` / `objectSelector` — webhook перехватывает системные компоненты (`kube-system`).
- Истёкший TLS-сертификат webhook'а — та же картина, что и недоступность.

**Хорошие практики:**
- исключать `kube-system` и namespace самого webhook'а через `namespaceSelector`;
- несколько реплик webhook'а, PDB, PriorityClass;
- узкие правила (`rules`: только нужные ресурсы и операции), разумный `timeoutSeconds`;
- для критичных правил безопасности — `Fail`, для вспомогательных — `Ignore`;
- мониторинг метрик API-сервера: `apiserver_admission_webhook_rejection_count`, латентность webhooks;
- простые проверки переносить в ValidatingAdmissionPolicy.

## Q: Напишите NetworkPolicy: доступ к БД только от приложения, запрет остального трафика.
level: middle
type: practice
freq: 2
tags: networkpolicy, безопасность

**NetworkPolicy** работает только при поддержке CNI (Calico, Cilium, Antrea и др.; Flannel без дополнений — нет). Правила **аддитивны**: если под выбран хотя бы одной политикой определённого направления (Ingress или Egress), разрешено **только** то, что явно описано во всех политиках; иначе — всё разрешено.

**1. Запрет всего по умолчанию в namespace:**
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-all, namespace: shop }
spec:
  podSelector: {}                 # все поды namespace
  policyTypes: [Ingress, Egress]
```

**2. Разрешить DNS всем подам** (иначе с запретом egress сломается резолв имён — самая частая ошибка):
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-dns, namespace: shop }
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
  - to:
    - namespaceSelector:
        matchLabels: { kubernetes.io/metadata.name: kube-system }
      podSelector:
        matchLabels: { k8s-app: kube-dns }
    ports:
    - { protocol: UDP, port: 53 }
    - { protocol: TCP, port: 53 }
```

**3. БД принимает трафик только от API на порт 5432:**
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: db-from-api, namespace: shop }
spec:
  podSelector: { matchLabels: { app: postgres } }
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector: { matchLabels: { app: api } }
    ports: [{ protocol: TCP, port: 5432 }]
```

**4. API может ходить в БД** (раз egress у API тоже запрещён по умолчанию):
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: api-to-db, namespace: shop }
spec:
  podSelector: { matchLabels: { app: api } }
  policyTypes: [Egress]
  egress:
  - to: [{ podSelector: { matchLabels: { app: postgres } } }]
    ports: [{ protocol: TCP, port: 5432 }]
```
Плюс политика, разрешающая Ingress-контроллеру доступ к API.

**Частые ловушки:**
- в `from` **два элемента списка** (`- namespaceSelector` и `- podSelector`) — это «ИЛИ»; **один элемент** с обоими селекторами — «И» (под с такой меткой в таком namespace). Перепутать — значит открыть доступ шире, чем задумано;
- забыли DNS при запрете egress;
- трафик от kubelet (пробы) к поду с узла обычно разрешён в зависимости от реализации CNI — проверять;
- стандартный NetworkPolicy не умеет L7 (пути HTTP) и доменные имена в egress — это расширения CNI (`CiliumNetworkPolicy` с `toFQDNs`, Calico GlobalNetworkPolicy);
- проверка: `kubectl exec` в под и `nc -zv`, визуализация политик (Cilium Hubble, редактор на networkpolicy.io).

## Q: Какие нюансы есть у Job и CronJob в Kubernetes?
level: middle
type: practice
freq: 2
tags: job, cronjob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly-report }
spec:
  schedule: "0 3 * * *"
  timeZone: "Europe/Moscow"          # иначе время по часовому поясу kube-controller-manager
  concurrencyPolicy: Forbid          # не запускать новый, пока работает предыдущий
  startingDeadlineSeconds: 600       # если пропустили запуск больше чем на 10 мин — не запускать
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 3                # повторов при ошибке
      activeDeadlineSeconds: 3600    # жёсткий лимит времени выполнения
      ttlSecondsAfterFinished: 86400 # удалить Job и поды через сутки
      template:
        spec:
          restartPolicy: Never       # для Job — Never или OnFailure (Always запрещён)
          containers:
          - name: report
            image: registry.example.com/report:1.2.0
            resources: { requests: { cpu: 200m, memory: 256Mi }, limits: { memory: 512Mi } }
```

**Job:**
- `completions` и `parallelism` — сколько успешных выполнений нужно и сколько подов одновременно; **Indexed Job** (`completionMode: Indexed`) — каждый под получает свой индекс для обработки своей части данных;
- **`restartPolicy: OnFailure`** — перезапускается контейнер в том же поде (логи предыдущих попыток теряются), **`Never`** — каждая попытка в новом поде (логи сохраняются, но поды накапливаются);
- `backoffLimit` (по умолчанию 6) с экспоненциальной задержкой между попытками; **`podFailurePolicy`** — не повторять при определённых кодах выхода (ошибка в данных) или игнорировать выселение пода;
- без `ttlSecondsAfterFinished` завершённые Job и поды остаются навсегда и засоряют кластер.

**CronJob:**
- **`concurrencyPolicy`**: `Allow` (по умолчанию — запуски могут накладываться), `Forbid`, `Replace` (убить текущий и запустить новый);
- контроллер **не гарантирует** ровно один запуск: в редких случаях задача может запуститься дважды или ни разу — задачи должны быть **идемпотентными**;
- если контроллер пропустил больше 100 запусков (например, CronJob был приостановлен `suspend: true` или кластер был недоступен), он перестанет планировать задачу — `startingDeadlineSeconds` ограничивает окно подсчёта пропусков;
- часовой пояс — поле `timeZone`.

**Типичные проблемы:**
- **sidecar** (Istio, агент логов) не завершается → Job никогда не становится Completed; решение — native sidecars (`initContainers` с `restartPolicy: Always`);
- Job не помещается на ноды (requests) и висит в Pending — следить за метрикой `kube_job_status_failed` и возрастом незавершённых Job;
- **мониторинг «тихих» отказов**: CronJob, который не запускается вообще, сам ошибок не создаёт. Нужен алерт на время **последнего успешного** выполнения (`kube_cronjob_status_last_successful_time` из kube-state-metrics) или heartbeat во внешний сервис (Healthchecks) в конце задачи.
