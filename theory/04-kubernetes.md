---
topic: kubernetes
---

Kubernetes проще понять через одну идею: **вы описываете желаемое состояние, а контроллеры бесконечно приводят к нему фактическое**. Всё остальное — Deployment, Service, HPA, операторы — частные случаи этого цикла.

Порядок глав: архитектура и цикл согласования → объекты API → под → контроллеры нагрузки → ресурсы и планирование → сеть и входящий трафик → конфигурация и хранилища → безопасность → масштабирование → расширение (CRD, операторы) → Helm и Kustomize → service mesh → эксплуатация → диагностика. Глава о диагностике в конце собирает всё вместе.

## Архитектура и цикл согласования
id: architecture

> **Суть:** кластер — это **control plane** (API-сервер, etcd, планировщик, менеджер контроллеров) и **рабочие узлы** (kubelet, рантайм, kube-proxy или CNI). Все компоненты общаются только через API-сервер, а состояние хранится в etcd. Каждый контроллер в цикле сравнивает желаемое с фактическим и исправляет разницу.

### Компоненты control plane

- **kube-apiserver** — единственная точка входа. Аутентификация, авторизация (RBAC), admission-контроллеры, валидация, запись в etcd. Все остальные — его клиенты, включая kubelet и контроллеры.
- **etcd** — распределённое key-value хранилище с консенсусом **Raft**. Хранит всё состояние кластера. Нужен кворум: из 3 узлов можно потерять 1, из 5 — 2. Поэтому узлов нечётное число.
- **kube-scheduler** — выбирает узел для подов без узла (см. [Планирование](#/theory/kubernetes/scheduling)).
- **kube-controller-manager** — набор контроллеров: Deployment, ReplicaSet, Node, Job, EndpointSlice, ServiceAccount и другие.
- **cloud-controller-manager** — интеграция с облаком: балансировщики для Service LoadBalancer, маршруты, информация об узлах.

### Компоненты узла

- **kubelet** — агент на каждом узле. Видит поды, назначенные его узлу, и через **CRI** просит рантайм (containerd, CRI-O) их запустить; выполняет пробы; монтирует тома через CSI; докладывает статус узла и подов.
- **Рантайм контейнеров** — containerd или CRI-O, ниже runc (см. [рантаймы](#/theory/containers/runtimes)).
- **kube-proxy** — программирует правила (iptables, IPVS или nftables), реализующие Service. В кластерах с Cilium может быть заменён eBPF.
- **CNI-плагин** — выдаёт поду IP и обеспечивает сеть между узлами.

### Цикл согласования (reconciliation)

Контроллеры работают не по командам «сделай X», а по **уровню**: «должно быть 3 реплики, сейчас 2 → создать ещё одну». Они **подписываются** на изменения объектов через API (механизм watch) и реагируют. Отсюда свойства Kubernetes:
- **самовосстановление**: удалили под — ReplicaSet создаст новый;
- **декларативность**: `kubectl apply` описывает результат, а не шаги;
- **итоговая согласованность**: изменения применяются не мгновенно, а цепочкой контроллеров.

### Что происходит после `kubectl apply -f deployment.yaml`

1. **kubectl** отправляет объект в API-сервер (server-side apply или PATCH).
2. **API-сервер**: аутентификация → авторизация RBAC → **mutating admission** (подставить значения по умолчанию, добавить sidecar) → валидация схемы → **validating admission** (политики) → запись в **etcd**.
3. **Deployment-контроллер** видит новый Deployment и создаёт **ReplicaSet**.
4. **ReplicaSet-контроллер** видит, что подов меньше, чем нужно, и создаёт объекты **Pod** (пока без узла).
5. **Планировщик** видит поды без `nodeName`, фильтрует и оценивает узлы, записывает выбранный узел (binding).
6. **kubelet** выбранного узла видит свой новый под и:
   - через CRI просит рантайм создать **sandbox пода** (pause-контейнер с сетевым namespace);
   - **CNI** выдаёт поду IP и настраивает сеть;
   - **CSI** монтирует тома;
   - рантайм скачивает образ и запускает init-контейнеры по очереди, затем основные контейнеры.
7. **kubelet** запускает пробы; когда readiness проходит, под помечается Ready.
8. **EndpointSlice-контроллер** добавляет IP пода в эндпоинты Service, **kube-proxy** на всех узлах обновляет правила — трафик пошёл на под.

### Проверьте себя
- Почему все компоненты общаются только через API-сервер?
- Что такое кворум etcd и почему узлов нечётное число?
- Чем подход «контроллер по уровню» лучше «выполнить команду»?
- Пройдите путь от `kubectl apply` до трафика на поде.

## Объекты API: namespace, labels, selectors и kubectl
id: objects

> **Суть:** всё в Kubernetes — объекты API с полями `apiVersion`, `kind`, `metadata`, `spec` (желаемое) и `status` (фактическое). **Labels** связывают объекты между собой через **selectors**, **annotations** хранят метаданные для инструментов, **namespace** группирует объекты и задаёт границу прав и квот.

### Структура объекта

```yaml
apiVersion: apps/v1          # группа/версия API
kind: Deployment             # тип
metadata:
  name: api
  namespace: shop
  labels: {app: api, team: payments}
  annotations: {deployment.kubernetes.io/revision: "3"}
spec: {...}                  # что вы хотите
status: {...}                # что есть (пишут контроллеры)
```

### Namespace

- Логическая группировка: окружения, команды, приложения.
- Граница для **RBAC** (Role действует в namespace), **ResourceQuota**, **LimitRange**, **NetworkPolicy**.
- Имена объектов уникальны в пределах namespace. DNS-имя сервиса: `<service>.<namespace>.svc.cluster.local`.
- **Не** граница безопасности сама по себе: без NetworkPolicy поды разных namespace свободно общаются, а узлы общие.
- Некоторые объекты кластерные, без namespace: Node, PersistentVolume, StorageClass, ClusterRole, CRD, Namespace.

### Labels и selectors

**Labels** — пары ключ-значение для **выборки**. На них держится связь объектов:
- Service находит свои поды по `selector`;
- Deployment и ReplicaSet считают «свои» поды по `selector.matchLabels`;
- NetworkPolicy, affinity, PodDisruptionBudget выбирают поды по меткам.

```bash
kubectl get pods -l app=api,env=prod
kubectl get pods -l 'env in (prod,staging)'
```
Рекомендуемые метки: `app.kubernetes.io/name`, `app.kubernetes.io/instance`, `app.kubernetes.io/version`, `app.kubernetes.io/part-of`.

Ловушка: `selector` у Deployment **неизменяем** после создания. И если селектор Service случайно совпадает с метками чужих подов, трафик пойдёт и на них.

**Annotations** — произвольные метаданные, по ним **не** выбирают: настройки ingress-контроллера, описание, хеш конфигурации для перезапуска подов, информация для инструментов.

### kubectl: команды на каждый день

```bash
kubectl get pods -n shop -o wide            # с узлом и IP
kubectl get all -n shop
kubectl describe pod api-7d9f -n shop       # события внизу — первое место для диагностики
kubectl logs api-7d9f -c app --previous     # логи предыдущего (упавшего) запуска
kubectl logs -l app=api -f --max-log-requests 10
kubectl exec -it api-7d9f -- sh
kubectl debug -it api-7d9f --image=busybox --target=app   # отладочный контейнер рядом
kubectl port-forward svc/api 8080:80
kubectl apply -f k8s/ ; kubectl diff -f k8s/
kubectl rollout status|history|undo deploy/api
kubectl get events -n shop --sort-by=.lastTimestamp
kubectl top pods; kubectl top nodes
kubectl explain deployment.spec.strategy    # документация по полям
kubectl auth can-i create pods --as=system:serviceaccount:ci:deployer -n shop
kubectl get pod api-7d9f -o yaml
kubectl config get-contexts; kubectl config use-context prod
```
`apply` — декларативный (сохраняет, что вы применили, и умеет удалять убранные поля), `create` и `edit` — императивные; в продакшене изменения идут через Git и CI или GitOps.

### Проверьте себя
- Чем `spec` отличается от `status`?
- Чем labels отличаются от annotations?
- Является ли namespace границей безопасности?
- Как Service понимает, на какие поды слать трафик?
- Где искать причину, если под не запускается?

## Под: pause, init, sidecar и пробы
id: pods

> **Суть:** под — минимальная единица запуска: один или несколько контейнеров с **общей сетью** (один IP, общий localhost) и общими томами, всегда на одном узле. Init-контейнеры выполняются до основных, sidecar работают рядом, а пробы говорят kubelet и балансировке, жив ли контейнер и готов ли он принимать трафик.

### Зачем несколько контейнеров и pause

Контейнеры пода разделяют сетевой namespace (и IPC, и, по желанию, PID). Кто-то должен **держать** эти namespaces, даже если контейнеры приложения перезапускаются. Это делает **pause-контейнер** (sandbox, «инфраструктурный контейнер»):
- создаётся первым, владеет сетевым namespace — IP пода принадлежит ему;
- ничего не делает (вызывает `pause()`), почти не потребляет ресурсов;
- при включённом общем PID namespace (`shareProcessNamespace: true`) становится PID 1 и «пожинает» зомби.

Поэтому при перезапуске контейнера приложения IP пода не меняется.

### Жизненный цикл и фазы

Фазы пода: `Pending` (принят, но контейнеры не запущены: ждёт планирования, скачивания образа) → `Running` → `Succeeded` / `Failed`; `Unknown` — нет связи с узлом.

Состояния контейнеров: `Waiting` (с причиной: `ContainerCreating`, `ImagePullBackOff`, `CrashLoopBackOff`), `Running`, `Terminated` (с кодом и причиной: `Completed`, `Error`, `OOMKilled`).

`restartPolicy`: `Always` (Deployment), `OnFailure` и `Never` (Job). Перезапуски идут с растущей задержкой до 5 минут — это и есть **CrashLoopBackOff**: контейнер падает, и kubelet ждёт всё дольше перед следующей попыткой.

### Init-контейнеры

Выполняются **по очереди до** основных, каждый должен завершиться успешно:
- дождаться зависимости (`until nc -z db 5432; do sleep 2; done`);
- применить миграции, подготовить файлы, скачать конфигурацию;
- выставить права на том.

Если init-контейнер падает, под остаётся в `Init:CrashLoopBackOff` / `Init:Error`, основные контейнеры не стартуют.

### Sidecar-контейнеры

Вспомогательный контейнер рядом с приложением: прокси service mesh (Envoy), сборщик логов, обновление сертификатов, агент секретов.

Проблема «классических» sidecar: порядок не гарантирован — приложение может стартовать раньше прокси и не иметь сети, а Job не завершается, потому что sidecar продолжает работать.

**Native sidecars** (стабильно с 1.33, доступно раньше за feature gate) — это init-контейнер с `restartPolicy: Always`:
- стартует **до** основных контейнеров (и можно дождаться его готовности через startupProbe);
- работает всё время жизни пода;
- останавливается **после** основных контейнеров;
- не мешает завершению Job.

### Пробы

| Проба | Вопрос | Что делает при провале |
|---|---|---|
| **startupProbe** | приложение уже запустилось? | пока не прошла, liveness и readiness не проверяются; при провале за отведённое время — перезапуск |
| **livenessProbe** | процесс не завис безнадёжно? | **перезапуск контейнера** |
| **readinessProbe** | готов принимать трафик прямо сейчас? | **убрать под из эндпоинтов Service** (без перезапуска) |

Типы проверок: `httpGet`, `tcpSocket`, `exec`, `grpc`. Параметры: `initialDelaySeconds`, `periodSeconds`, `timeoutSeconds`, `failureThreshold`.

```yaml
startupProbe:
  httpGet: {path: /healthz, port: 8080}
  periodSeconds: 5
  failureThreshold: 30          # до 150 с на старт
livenessProbe:
  httpGet: {path: /healthz, port: 8080}
  periodSeconds: 10
  failureThreshold: 3
readinessProbe:
  httpGet: {path: /ready, port: 8080}
  periodSeconds: 5
```

Типичные ошибки:
1. **Liveness проверяет зависимости** (БД, другой сервис). База моргнула → все поды перезапускаются одновременно → каскадный отказ. Liveness должна проверять только сам процесс.
2. **Одинаковые liveness и readiness** — при перегрузке под не только уходит из балансировки, но и перезапускается, усиливая перегрузку.
3. Нет startupProbe у медленно стартующего приложения → liveness убивает его до окончания старта → бесконечный CrashLoop.
4. Слишком маленький `timeoutSeconds` (по умолчанию 1 с) при нагрузке или GC-паузах.
5. Нет readiness вовсе → трафик идёт на ещё не готовый под при деплое.

### Завершение пода

1. Под помечается удаляемым; параллельно он **убирается из эндпоинтов** и выполняется `preStop`-хук.
2. Контейнеры получают **SIGTERM**.
3. Через `terminationGracePeriodSeconds` (30 с) — **SIGKILL**.

Удаление из эндпоинтов распространяется по кластеру не мгновенно, поэтому несколько секунд трафик ещё может прийти. Стандартный приём: `preStop` со `sleep 5–10` секунд, чтобы под продолжал обслуживать запросы, пока его не уберут из всех балансировщиков.

### Проверьте себя
- Зачем в поде pause-контейнер?
- Чем readiness отличается от liveness и что будет при провале каждой?
- Почему liveness не должна проверять базу данных?
- Что изменили native sidecars?
- Почему при удалении пода запросы ещё могут приходить и как с этим бороться?

## Контроллеры нагрузки: Deployment, StatefulSet, DaemonSet, Job
id: workloads

> **Суть:** под сам по себе не восстанавливается — им управляют контроллеры. **Deployment** — для взаимозаменяемых реплик без состояния, **StatefulSet** — для реплик со стабильными именами и своими дисками, **DaemonSet** — по поду на каждом узле, **Job/CronJob** — для задач, которые должны завершиться.

### Сравнение

| | Deployment | StatefulSet | DaemonSet | Job / CronJob |
|---|---|---|---|---|
| Для чего | API, веб, воркеры без состояния | БД, Kafka, ZooKeeper, кластеры с идентичностью | агенты узла: логи, мониторинг, CNI, CSI | миграции, бэкапы, пакетная обработка |
| Имена подов | случайные (`api-7d9f-x2k`) | **стабильные**: `db-0`, `db-1` | по одному на узел | случайные |
| Хранилище | общее или нет | **свой PVC на каждую реплику** (`volumeClaimTemplates`) | обычно hostPath | — |
| Порядок | параллельно | **по порядку** запуск, обратный порядок остановки | — | — |
| Сеть | через Service | плюс **headless Service**: DNS на каждый под `db-0.db.ns.svc` | — | — |

### Deployment и rolling update

Deployment управляет **ReplicaSet**-ами: каждое изменение шаблона пода создаёт новый ReplicaSet, а старый постепенно уменьшается.

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 25%          # сколько подов можно создать сверх нужного числа
    maxUnavailable: 0      # сколько может быть недоступно — 0 для zero-downtime
minReadySeconds: 10        # под должен быть Ready столько секунд, чтобы считаться доступным
revisionHistoryLimit: 5
```
- Стратегия `Recreate` — сначала убить все старые, потом создать новые (когда две версии не могут работать одновременно), с простоем.
- `kubectl rollout status deploy/api`, `kubectl rollout undo deploy/api` — откат на предыдущий ReplicaSet.
- Если новые поды не становятся Ready, выкатка останавливается (`progressDeadlineSeconds`), но **сама не откатывается** — это делает CI или Argo Rollouts.

### StatefulSet

- Поды создаются по порядку (`db-0`, затем `db-1`...) и удаляются в обратном порядке (`podManagementPolicy: Parallel` меняет это).
- `volumeClaimTemplates` создают PVC `data-db-0`, `data-db-1`; при пересоздании пода `db-0` он получит **тот же** диск. При удалении StatefulSet PVC по умолчанию **остаются** (защита данных).
- Обновление по одному поду, с конца; `partition` позволяет обновить только часть реплик (канарейка).
- StatefulSet даёт идентичность, но **не делает** базу отказоустойчивой: репликацию, выбор лидера, бэкапы обеспечивает сама СУБД или **оператор** (CloudNativePG, Strimzi).

### DaemonSet

Под на каждом подходящем узле (или на подмножестве через `nodeSelector`/affinity). Новый узел — автоматически новый под. Обычно нужны **tolerations**, чтобы попадать и на узлы с taints (control plane, специальные пулы).

### Job и CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
spec:
  schedule: "0 3 * * *"
  timeZone: "Europe/Moscow"
  concurrencyPolicy: Forbid            # не запускать, пока идёт предыдущий
  startingDeadlineSeconds: 600         # если пропустили запуск — не позже чем через 10 мин
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 3                  # повторов при ошибке
      activeDeadlineSeconds: 3600      # общий таймаут
      ttlSecondsAfterFinished: 86400   # удалить завершённый Job
      template:
        spec:
          restartPolicy: OnFailure
          containers: [...]
```
Нюансы:
- задача может выполниться **больше одного раза** (повтор после сбоя узла, двойной запуск CronJob в редких случаях) → задача должна быть **идемпотентной**;
- `restartPolicy: OnFailure` перезапускает контейнер в том же поде, `Never` — создаёт новый под (удобнее разбирать логи);
- параллельная обработка: `completions` и `parallelism`, индексированные Job (`completionMode: Indexed`);
- sidecar без native sidecar не даёт Job завершиться.

### Zero-downtime деплой — что должно сойтись

1. `maxUnavailable: 0` и разумный `maxSurge`;
2. **readinessProbe**, чтобы трафик шёл только на готовые поды;
3. **graceful shutdown**: обработка SIGTERM + `preStop: sleep`;
4. **PodDisruptionBudget** для обслуживания узлов (см. [Эксплуатация](#/theory/kubernetes/operations));
5. несколько реплик, разнесённых по узлам и зонам;
6. обратная совместимость версий и миграций БД (две версии работают одновременно).

### Проверьте себя
- Чем StatefulSet отличается от Deployment? Когда что выбрать?
- Как Deployment делает rolling update и что значат maxSurge и maxUnavailable?
- Откатывается ли Deployment сам при неудачной выкатке?
- Почему задача CronJob должна быть идемпотентной?
- Что нужно для деплоя без простоя?

## Ресурсы: requests, limits, QoS, квоты и eviction
id: resources

> **Суть:** **requests** — сколько ресурсов поду гарантировано; по ним планировщик ищет узел. **limits** — потолок: превышение памяти убивает контейнер (OOMKilled), превышение CPU замедляет (throttling). Сочетание requests и limits задаёт класс QoS, от которого зависит, кого выселят первым при нехватке ресурсов на узле.

### requests и limits

```yaml
resources:
  requests: {cpu: 250m, memory: 256Mi}
  limits:   {memory: 512Mi}
```
- `cpu: 250m` — четверть ядра (millicores); `memory: 256Mi` — мебибайты.
- **Планировщик** учитывает **только requests**: сумма requests подов на узле не превышает allocatable узла. Фактическое потребление он не смотрит.
- На узле requests и limits превращаются в настройки **cgroups** (см. [cgroups в Linux](#/theory/linux/isolation)):
  - `requests.cpu` → `cpu.weight` (доля при конкуренции);
  - `limits.cpu` → `cpu.max` (жёсткая квота за период 100 мс);
  - `limits.memory` → `memory.max`.

### Память против CPU

- Память **несжимаемая**: её нельзя «отобрать», поэтому превышение лимита = **OOMKilled** (код 137).
- CPU **сжимаемый**: при превышении лимита контейнер не убивают, а **троттлят** — он ждёт следующего периода квоты. Латентность растёт, а средняя загрузка выглядит нормальной. Метрика: `container_cpu_cfs_throttled_periods_total`.

Распространённая практика: **requests по фактическому потреблению**, **limit памяти** обязательно (равен или чуть выше request), **limit CPU часто не ставят** или ставят с запасом, чтобы избежать троттлинга. Для чувствительных к латентности сервисов это важно. Без CPU-лимита под может пользоваться свободными ресурсами узла, но гарантирована ему всё равно только доля по request.

### QoS-классы

| Класс | Условие | При нехватке на узле |
|---|---|---|
| **Guaranteed** | у **всех** контейнеров requests = limits по CPU и памяти | выселяется последним |
| **Burstable** | хотя бы один request или limit задан, но не Guaranteed | в середине |
| **BestEffort** | ничего не задано | выселяется первым |

### Eviction — выселение

Когда на **узле** заканчивается память, диск (`nodefs`, `imagefs`) или inode, kubelet начинает **выселять** поды, не дожидаясь системного OOM:
- пороги: `memory.available<100Mi`, `nodefs.available<10%` (жёсткие и мягкие с grace period);
- порядок: сначала поды, которые **превысили свои requests**, с учётом приоритета (PriorityClass) и величины превышения; Guaranteed в пределах requests — последними;
- выселенный под получает статус `Evicted` (Failed); контроллер создаёт замену на другом узле;
- на время давления узел получает taint `node.kubernetes.io/memory-pressure` и т.п., и новые поды на него не планируются.

Как не допускать: честные requests, лимиты на эфемерное хранилище (`ephemeral-storage`) — логи и временные файлы в контейнере тоже заполняют диск узла; ротация логов на узлах; запас под системные процессы (`system-reserved`, `kube-reserved`).

Другие виды «выселения»: **preemption** (планировщик вытесняет низкоприоритетные поды ради высокоприоритетного) и **API-initiated eviction** (`kubectl drain`, уважает PodDisruptionBudget).

### ResourceQuota и LimitRange

- **ResourceQuota** — ограничение на **namespace** в целом: сумма requests и limits, число подов, сервисов, PVC, LoadBalancer.
- **LimitRange** — значения **по умолчанию** и минимум/максимум для **каждого** контейнера в namespace.

Связка: если в namespace есть квота на CPU и память, каждый под **обязан** указывать requests и limits — иначе его отклонят. LimitRange подставит значения по умолчанию, чтобы забытые ресурсы не ломали деплой.

```yaml
apiVersion: v1
kind: LimitRange
spec:
  limits:
  - type: Container
    defaultRequest: {cpu: 100m, memory: 128Mi}
    default:        {memory: 256Mi}
    max:            {memory: 2Gi}
```

### Проверьте себя
- По каким значениям планировщик размещает поды: requests или limits?
- Что произойдёт при превышении лимита памяти и при превышении лимита CPU?
- Как получить класс Guaranteed?
- Почему под может быть выселен, хотя он в пределах своих лимитов?
- Зачем нужен LimitRange, если есть ResourceQuota?

## Планирование: scheduler, affinity, taints и Pending
id: scheduling

> **Суть:** планировщик для каждого пода без узла **фильтрует** узлы (хватит ли requests, подходят ли метки, taints, тома, порты), затем **оценивает** оставшиеся и выбирает лучший. Если ни один узел не прошёл фильтр — под остаётся в `Pending`, а причина написана в событиях.

### Два этапа

1. **Фильтрация** (predicates): достаточно ли свободных requests (allocatable минус сумма requests), подходит ли `nodeSelector` и node affinity, есть ли toleration для taints узла, свободен ли hostPort, можно ли подключить том в этой зоне.
2. **Оценка** (scoring): равномерность загрузки, affinity с предпочтениями, распределение по зонам, наличие образа на узле.

### Инструменты управления размещением

**nodeSelector** — простое требование меток узла: `nodeSelector: {disktype: ssd}`.

**Node affinity** — гибче: жёсткие (`requiredDuringScheduling...`) и мягкие (`preferredDuringScheduling...`) правила с операторами `In`, `NotIn`, `Exists`.

**Pod affinity / anti-affinity** — относительно **других подов**:
- affinity: «рядом с подами кеша» (меньше задержка);
- anti-affinity: «не на одном узле с другими репликами» (`topologyKey: kubernetes.io/hostname`) — отказ узла не убьёт все реплики.

**Taints и tolerations** — обратная логика: узел **отталкивает** поды, если у них нет «допуска».
```bash
kubectl taint nodes gpu-1 gpu=true:NoSchedule
```
```yaml
tolerations:
- {key: gpu, operator: Equal, value: "true", effect: NoSchedule}
```
Эффекты: `NoSchedule` (не планировать новых), `PreferNoSchedule`, `NoExecute` (выгнать и уже работающие). Важно: toleration **разрешает**, но **не притягивает** под на узел. Для выделенных узлов используют taint **и** affinity вместе.

**Topology spread constraints** — равномерно распределить реплики по зонам или узлам:
```yaml
topologySpreadConstraints:
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: DoNotSchedule
  labelSelector: {matchLabels: {app: api}}
```

**PriorityClass** — приоритет подов: при нехватке места высокоприоритетный под может вытеснить (preempt) низкоприоритетные.

### Под в Pending: причины и диагностика

`kubectl describe pod` → раздел **Events**. Типичные сообщения:

| Сообщение | Причина | Что делать |
|---|---|---|
| `Insufficient cpu` / `Insufficient memory` | ни на одном узле нет свободных **requests** | уменьшить requests, добавить узлы, проверить работу autoscaler |
| `node(s) didn't match Pod's node affinity/selector` | нет узлов с нужными метками | проверить метки узлов и селектор |
| `node(s) had untolerated taint` | узлы закрыты taints | добавить toleration или использовать другие узлы |
| `pod has unbound immediate PersistentVolumeClaims` | PVC не привязан | нет StorageClass, ошибка provisioner, квота облака |
| `volume node affinity conflict` | диск в одной зоне, свободные узлы — в другой | `WaitForFirstConsumer` в StorageClass, узлы в нужной зоне |
| `didn't have free ports` | занят hostPort | убрать hostPort |
| нет событий вовсе | планировщик не работает или под ждёт квоты / admission | статус планировщика, ResourceQuota (тогда под не создаётся, ошибка у ReplicaSet) |

Если под **назначен узлу**, но висит в `ContainerCreating` — это уже не планирование: проблемы с образом (`ImagePullBackOff`: опечатка в имени, нет доступа к реестру, нет imagePullSecret), CNI (нет IP), монтированием томов, секретом или ConfigMap, которого нет.

### Проверьте себя
- По каким данным планировщик решает, хватит ли места на узле?
- Чем taint отличается от node affinity? Почему toleration не притягивает под?
- Как гарантировать, что реплики окажутся в разных зонах?
- Под в Pending с `Insufficient memory`, а `kubectl top nodes` показывает 40% памяти. Почему?

## Сеть: модель, CNI, Service и NetworkPolicy
id: networking

> **Суть:** сетевая модель Kubernetes: **у каждого пода свой IP**, и все поды видят друг друга без NAT. Реализует её CNI-плагин. Так как поды смертны и IP меняются, **Service** даёт стабильный виртуальный IP и DNS-имя, а kube-proxy (или eBPF) распределяет трафик по живым подам. **NetworkPolicy** ограничивает, кто с кем может говорить.

### Модель и CNI

Требования модели:
- каждый под получает уникальный IP;
- поды на любых узлах общаются напрямую, без NAT;
- узлы общаются с подами без NAT.

**CNI-плагин** вызывается при создании пода: создаёт интерфейс в сетевом namespace пода (veth-пару), выдаёт IP из диапазона узла (IPAM), прописывает маршруты. Между узлами трафик идёт:
- **через overlay** (VXLAN, Geneve, IP-in-IP): пакет пода заворачивается в пакет между узлами. Работает поверх любой сети, но добавляет накладные расходы и уменьшает MTU (см. [VXLAN](#/theory/network/l2));
- **маршрутизацией** без инкапсуляции: маршруты к подсетям подов распространяются по BGP (Calico) или в таблицах облака;
- **нативно в облаке**: поды получают IP из VPC (AWS VPC CNI, Azure CNI) — нет overlay, но адреса VPC расходуются быстро.

Популярные плагины: **Calico** (BGP или overlay, сильные NetworkPolicy), **Cilium** (eBPF: замена kube-proxy, политики L7, наблюдаемость через Hubble), **Flannel** (простой overlay, без политик), облачные.

### Service

| Тип | Что даёт |
|---|---|
| **ClusterIP** (по умолчанию) | виртуальный IP внутри кластера + DNS-имя |
| **NodePort** | ClusterIP + порт 30000–32767 на **каждом** узле |
| **LoadBalancer** | NodePort + внешний балансировщик облака (через cloud-controller-manager или MetalLB) |
| **ExternalName** | DNS CNAME на внешнее имя, без прокси |
| **Headless** (`clusterIP: None`) | без виртуального IP: DNS возвращает **IP всех подов**; для StatefulSet и клиентской балансировки |

Как работает ClusterIP:
1. Service выбирает поды по **selector**; контроллер ведёт **EndpointSlice** — список IP готовых (Ready) подов.
2. **kube-proxy** на каждом узле превращает это в правила: в режиме iptables — DNAT с вероятностным выбором пода, в режиме IPVS — виртуальный сервер ядра с алгоритмами балансировки (лучше масштабируется на тысячи сервисов), в Cilium — eBPF-программы.
3. ClusterIP **не принадлежит ни одному интерфейсу** — это правило перехвата. Поэтому `ping` на ClusterIP обычно не работает, а `curl` на порт — работает.

DNS: CoreDNS отвечает на `api.shop.svc.cluster.local` адресом ClusterIP. Внутри namespace достаточно `api`.

Балансировка происходит **на уровне соединений** (L4): долгоживущее соединение (gRPC, HTTP/2, пул к БД) прилипает к одному поду. Решение — балансировка L7 (service mesh, клиентская балансировка через headless Service).

`externalTrafficPolicy: Local` — трафик извне идёт только на поды этого узла: сохраняется IP клиента, нет лишнего прыжка, но балансировщик должен знать, где поды.

### NetworkPolicy

По умолчанию **всё разрешено**. Как только под выбран **хотя бы одной** политикой для направления (ingress или egress), для этого направления разрешено **только** явно описанное.

«Доступ к БД только от приложения»:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: db-allow-api, namespace: shop}
spec:
  podSelector: {matchLabels: {app: postgres}}
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector: {matchLabels: {app: api}}
    ports:
    - {protocol: TCP, port: 5432}
```
Базовая практика — «запрещено по умолчанию» в namespace и явные разрешения:
```yaml
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
```
Подводные камни:
- политики **работают, только если CNI их поддерживает** (Flannel — нет): объект создастся, но ничего не будет фильтровать;
- при запрете egress нужно явно разрешить **DNS** (UDP и TCP 53 к kube-dns), иначе ничего не резолвится;
- `from` с двумя элементами списка — это ИЛИ, а `namespaceSelector` и `podSelector` в **одном** элементе — это И. Лишний дефис меняет смысл политики;
- политики стандартного API работают на L3/L4 (IP, порты); L7-правила (HTTP-пути) — у Cilium и service mesh.

### Проверьте себя
- Какие требования у сетевой модели Kubernetes?
- Чем overlay отличается от маршрутизируемой сети подов?
- Как трафик на ClusterIP попадает на конкретный под? Почему ClusterIP не пингуется?
- Когда нужен headless Service?
- Создали NetworkPolicy, а трафик всё равно проходит. Почему?

## Входящий трафик: LoadBalancer, Ingress и Gateway API
id: ingress

> **Суть:** снаружи в кластер трафик попадает через внешний балансировщик (Service LoadBalancer). Чтобы не заводить по балансировщику на каждый сервис, ставят **Ingress-контроллер** — L7-прокси в кластере, который маршрутизирует HTTP по хосту и пути. **Gateway API** — новый, более выразительный стандарт, разделяющий ответственность инфраструктуры и команд приложений.

### Путь запроса из интернета

```
клиент → DNS → облачный балансировщик (L4/L7) → NodePort на узлах или напрямую IP подов
       → Ingress-контроллер (nginx, Traefik, HAProxy, Envoy) → Service → под приложения
```
Где завершается TLS: на облачном балансировщике или на Ingress-контроллере (сертификаты из Secret, обычно через **cert-manager**).

### Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: 20m
spec:
  ingressClassName: nginx
  tls:
  - hosts: [shop.example.com]
    secretName: shop-tls
  rules:
  - host: shop.example.com
    http:
      paths:
      - {path: /api, pathType: Prefix, backend: {service: {name: api, port: {number: 80}}}}
      - {path: /,    pathType: Prefix, backend: {service: {name: web, port: {number: 80}}}}
```
- Объект Ingress — только **правила**. Работают они, только если установлен **Ingress-контроллер** соответствующего класса.
- Ограничения: только HTTP/HTTPS, а всё сверх базовой маршрутизации (таймауты, rewrite, канарейки, лимиты) задаётся **аннотациями**, своими у каждого контроллера — переносимости нет.
- Проект ingress-nginx (сообщества Kubernetes) переведён в режим завершения поддержки; новые установки ориентируются на Gateway API и другие контроллеры.

### Gateway API

Набор ресурсов с разделением ролей:
- **GatewayClass** — какой реализацией (Envoy Gateway, Istio, Cilium, NGINX Gateway Fabric, облачные) — задаёт провайдер инфраструктуры;
- **Gateway** — точка входа: слушатели, порты, TLS — задаёт команда платформы;
- **HTTPRoute**, **GRPCRoute**, **TLSRoute**, **TCPRoute** — маршруты приложений — пишут команды сервисов в своих namespace.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: {name: api, namespace: shop}
spec:
  parentRefs: [{name: public, namespace: infra}]
  hostnames: [shop.example.com]
  rules:
  - matches: [{path: {type: PathPrefix, value: /api}}]
    backendRefs:
    - {name: api-v1, port: 80, weight: 90}
    - {name: api-v2, port: 80, weight: 10}     # канарейка без аннотаций
```
Плюсы: разделение прав, переносимость между реализациями, встроенные веса трафика, заголовки, зеркалирование, поддержка не только HTTP.

### Проверьте себя
- Почему одного объекта Ingress недостаточно, чтобы трафик пошёл?
- Какие ограничения Ingress решает Gateway API?
- Где может завершаться TLS и кто выпускает сертификаты?
- Опишите путь запроса из интернета до пода.

## ConfigMap и Secret
id: config

> **Суть:** конфигурацию отделяют от образа. **ConfigMap** хранит несекретные настройки, **Secret** — секреты. Оба передаются в под как переменные окружения или как файлы в томе. Secret по умолчанию лишь закодирован в base64, а не зашифрован — защищают его RBAC, шифрование etcd и внешние хранилища секретов.

### Способы передачи в под

```yaml
env:
- name: LOG_LEVEL
  valueFrom: {configMapKeyRef: {name: api-config, key: log_level}}
- name: DB_PASSWORD
  valueFrom: {secretKeyRef: {name: db, key: password}}
envFrom:
- configMapRef: {name: api-config}
volumeMounts:
- {name: config, mountPath: /etc/api, readOnly: true}
volumes:
- name: config
  configMap: {name: api-config}
```

| | Переменные окружения | Файлы в томе |
|---|---|---|
| Обновление при изменении | **нет**, только после перезапуска пода | **да**, файлы обновятся через ~минуту (кроме `subPath`) |
| Видимость | `/proc/PID/environ`, логи краш-дампов, дочерние процессы | только файл |
| Удобство | просто | приложение должно перечитывать файл |

Чтобы поды перезапускались при изменении конфигурации, в шаблон пода добавляют аннотацию с хешем конфига (`checksum/config` в Helm) — изменение хеша вызывает rolling update. Альтернатива — Reloader. Ещё вариант — **неизменяемые** ConfigMap с версией в имени (`api-config-v7`): меньше нагрузки на API и предсказуемые откаты.

### Безопасность Secret

- base64 — **кодирование, не шифрование**: `kubectl get secret db -o jsonpath='{.data.password}' | base64 -d`.
- **Шифрование в etcd** (`EncryptionConfiguration`, в облаках — KMS) — иначе секреты лежат в etcd и его бэкапах открыто.
- **RBAC**: право `get`/`list` на secrets в namespace = доступ ко всем секретам; право создавать поды в namespace тоже даёт доступ к его секретам (под может их смонтировать).
- **Не хранить секреты в Git** открытым текстом. Варианты:
  - **External Secrets Operator** — синхронизирует из Vault, AWS Secrets Manager, GCP Secret Manager в Secret;
  - **Sealed Secrets** — шифрование ключом контроллера, в Git лежит зашифрованное;
  - **SOPS** — шифрование файлов (age, KMS), расшифровка в CI или Argo CD;
  - **Secrets Store CSI Driver** — монтирование секретов из внешнего хранилища файлами, минуя Secret;
  - Vault Agent Injector.
- Для доступа к облаку — не статические ключи в Secret, а **идентичность пода**: IRSA и Pod Identity в AWS, Workload Identity в GCP и Azure.

### Проверьте себя
- Чем отличается передача конфигурации через переменные и через файлы?
- Почему изменение ConfigMap не применилось к работающему приложению?
- Зашифрован ли Secret? Что нужно сделать, чтобы он был в безопасности?
- Как хранить секреты при GitOps?

## Хранение данных: PV, PVC, StorageClass и CSI
id: storage

> **Суть:** под просит хранилище через **PVC** («мне нужно 20 ГБ, ReadWriteOnce, класса fast»), кластер удовлетворяет запрос **PV** — реальным диском, который обычно создаётся динамически по **StorageClass** через **CSI-драйвер**. Так приложение не знает, где физически лежат данные.

### Объекты

- **PersistentVolume (PV)** — реальный ресурс хранения в кластере (облачный диск, NFS-ресурс, локальный диск). Кластерный объект.
- **PersistentVolumeClaim (PVC)** — запрос приложения в namespace: размер, режим доступа, класс. Под ссылается на PVC.
- **StorageClass** — «тип хранилища» и способ его создания: provisioner (CSI-драйвер), параметры (тип диска, IOPS), `reclaimPolicy`, `volumeBindingMode`, `allowVolumeExpansion`.
- **CSI** (Container Storage Interface) — стандартный интерфейс драйверов хранилищ: создать, подключить к узлу, смонтировать, расширить, сделать снапшот.

### Динамическое создание

1. Создаётся PVC с `storageClassName: fast`.
2. Provisioner по StorageClass создаёт диск в облаке и объект PV.
3. PV **привязывается** (bind) к PVC — один к одному.
4. Когда под запускается на узле, CSI-драйвер **подключает** диск к узлу (attach) и **монтирует** его в под.

`volumeBindingMode: WaitForFirstConsumer` — создавать диск только после того, как под запланирован: диск окажется **в той же зоне**, что и узел. С `Immediate` диск может быть создан в зоне, где поду нет места, и под застрянет в Pending (`volume node affinity conflict`).

### Режимы доступа

| Режим | Значение | Пример |
|---|---|---|
| `ReadWriteOnce` (RWO) | чтение-запись **одним узлом** | облачные блочные диски (EBS, PD) |
| `ReadWriteOncePod` | одним **подом** | строгая эксклюзивность |
| `ReadOnlyMany` (ROX) | только чтение многими узлами | |
| `ReadWriteMany` (RWX) | запись многими узлами | NFS, EFS, CephFS, Azure Files |

Блочный облачный диск нельзя смонтировать на два узла — Deployment с несколькими репликами и одним RWO-PVC будет иметь поды, застрявшие в `ContainerCreating` (`Multi-Attach error`).

### Политика освобождения

`reclaimPolicy`:
- **Delete** (часто по умолчанию для динамических) — удалили PVC → удалился PV и **диск с данными**;
- **Retain** — PV и диск остаются, их нужно разбирать вручную.

Для важных данных — `Retain` или хотя бы бэкапы и снапшоты (**VolumeSnapshot**, Velero).

### Что ещё стоит знать

- Расширение: увеличить `resources.requests.storage` у PVC при `allowVolumeExpansion: true`; уменьшать нельзя.
- `emptyDir` — временный каталог пода (живёт, пока жив под), может быть в памяти (`medium: Memory`).
- `hostPath` — каталог узла: опасно (доступ к ФС узла) и непереносимо, только для системных DaemonSet.
- Local Persistent Volumes — быстрые локальные NVMe, но данные привязаны к узлу.
- Базы данных в Kubernetes — через StatefulSet и **операторы** (CloudNativePG, Percona, Strimzi), с продуманными бэкапами. Многие команды держат продакшен-БД в управляемых облачных сервисах.

### Проверьте себя
- Чем PV отличается от PVC и кто их создаёт?
- Зачем `WaitForFirstConsumer`?
- Почему Deployment из трёх реплик с одним RWO-диском не запускается?
- Что произойдёт с данными при удалении PVC и как это контролировать?

## Безопасность: RBAC, ServiceAccount, admission и Pod Security
id: security

> **Суть:** каждый запрос к API проходит **аутентификацию** (кто вы), **авторизацию** RBAC (можно ли вам это), **admission** (соответствует ли объект политикам). Поды обращаются к API от имени **ServiceAccount**. Принцип — минимально необходимые права и запрет опасных настроек подов.

### Аутентификация

В Kubernetes нет объекта «пользователь». Люди приходят через сертификаты клиента, OIDC (Keycloak, Dex, облачный IAM) или токены облака. Программы внутри кластера — через **ServiceAccount**: поду монтируется короткоживущий токен (projected token), который автоматически обновляется.

### RBAC

- **Role** — набор правил (`apiGroups`, `resources`, `verbs`) в namespace.
- **ClusterRole** — то же на весь кластер или для кластерных ресурсов; может использоваться в namespace через RoleBinding.
- **RoleBinding** — выдать Role или ClusterRole субъекту **в namespace**.
- **ClusterRoleBinding** — выдать ClusterRole **во всём кластере**.
- Субъекты: User, Group, ServiceAccount.
- RBAC только **разрешает**; запрещающих правил нет.

Доступ CI-системы только к одному namespace:
```yaml
apiVersion: v1
kind: ServiceAccount
metadata: {name: deployer, namespace: shop}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {name: deployer, namespace: shop}
rules:
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
- apiGroups: [""]
  resources: ["services", "configmaps"]
  verbs: ["get", "list", "create", "update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: {name: deployer, namespace: shop}
subjects: [{kind: ServiceAccount, name: deployer, namespace: shop}]
roleRef: {kind: Role, name: deployer, apiGroup: rbac.authorization.k8s.io}
```
Токен для CI: `kubectl create token deployer -n shop --duration=1h` или, лучше, федерация OIDC (CI получает короткоживущий токен без хранения секретов).

Проверка: `kubectl auth can-i --list --as=system:serviceaccount:shop:deployer -n shop`.

Опасные права, равные почти полному доступу: `*` на всё, `create pods` (под может смонтировать любые секреты namespace и запуститься привилегированным, если не запрещено политиками), `get secrets`, `escalate`, `bind`, `impersonate`, `nodes/proxy`.

### Admission-контроллеры

Срабатывают после авторизации и до записи в etcd:
- **mutating** — изменяют объект: подставить значения по умолчанию, добавить sidecar (Istio), метки;
- **validating** — разрешить или отклонить: политики безопасности, обязательные метки, запрет `latest`.

Встроенные (LimitRanger, ResourceQuota, PodSecurity, NamespaceLifecycle) и **webhooks** — внешние сервисы, которые API-сервер вызывает по HTTPS: Kyverno, OPA Gatekeeper, cert-manager, Istio. Также есть встроенные **ValidatingAdmissionPolicy** на языке CEL без отдельного сервиса.

Проблемы webhooks:
- если webhook-сервис недоступен при `failurePolicy: Fail` — **нельзя создать** подходящие объекты, вплоть до неработающего кластера (особенно если webhook применяется к подам самого себя или kube-system). Решения: исключать системные namespace (`namespaceSelector`), несколько реплик webhook, `failurePolicy: Ignore` для некритичных;
- таймауты webhooks замедляют каждый запрос к API;
- порядок mutating webhooks и неожиданные изменения объектов («кто добавил это поле?»).

### Pod Security

**Pod Security Admission** — встроенные уровни, включаются меткой namespace:
- `privileged` — без ограничений;
- `baseline` — запрет очевидно опасного (privileged, hostNetwork, hostPath);
- `restricted` — лучшие практики: не root, drop ALL capabilities, seccomp RuntimeDefault, запрет повышения привилегий.

```bash
kubectl label ns shop pod-security.kubernetes.io/enforce=restricted
```
Пример `securityContext`:
```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: {drop: ["ALL"]}
  seccompProfile: {type: RuntimeDefault}
```

### Прочее

- **NetworkPolicy** — сегментация сети (см. [Сеть](#/theory/kubernetes/networking)).
- Не монтировать токен ServiceAccount тем подам, которым API не нужен: `automountServiceAccountToken: false`.
- Аудит-логи API-сервера, обновления кластера, CIS Benchmark (kube-bench).
- Мониторинг поведения: Falco, Tetragon.

### Проверьте себя
- Чем Role отличается от ClusterRole, а RoleBinding от ClusterRoleBinding?
- Как дать CI доступ только к одному namespace?
- Почему право создавать поды почти равно доступу ко всем секретам namespace?
- Что будет, если упадёт validating webhook с `failurePolicy: Fail`?
- Что запрещает уровень `restricted` Pod Security?

## Автомасштабирование: HPA, VPA, Cluster Autoscaler, Karpenter, KEDA
id: scaling

> **Суть:** масштабирование бывает двух уровней. **Поды**: HPA меняет число реплик по метрикам, VPA подбирает requests. **Узлы**: Cluster Autoscaler или Karpenter добавляют узлы, когда поды не помещаются (Pending), и убирают недогруженные. Без правильных requests ни один из них не работает корректно.

### HPA — горизонтальное масштабирование подов

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
spec:
  scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: api}
  minReplicas: 3
  maxReplicas: 30
  metrics:
  - type: Resource
    resource: {name: cpu, target: {type: Utilization, averageUtilization: 70}}
  behavior:
    scaleDown: {stabilizationWindowSeconds: 300}
```
- Формула: `нужно реплик = ceil(текущие × текущая метрика / целевая)`. При CPU 140% от цели и 4 репликах → 8 реплик.
- **Utilization считается от requests**: без requests HPA по CPU не работает, а с завышенными requests масштабирование срабатывает слишком поздно.
- Метрики: CPU и память через **metrics-server**; свои и внешние метрики (RPS, длина очереди) через адаптер Prometheus или **KEDA**.
- `behavior` защищает от «качелей»: окно стабилизации при уменьшении, ограничение скорости.
- Масштабирование по памяти часто бессмысленно: многие рантаймы не отдают память обратно.

**KEDA** — масштабирование по событиям: длина очереди Kafka или RabbitMQ, метрики Prometheus, cron. Умеет **до нуля** реплик и обратно.

### VPA — вертикальное

Анализирует фактическое потребление и рекомендует или выставляет **requests** (и limits пропорционально). Режимы: `Off` (только рекомендации — полезно для подбора requests), `Initial` (при создании подов), `Auto` (пересоздаёт поды; новые версии умеют менять ресурсы без перезапуска — in-place resize). Нельзя одновременно использовать VPA и HPA **по одной метрике** (CPU) — они будут мешать друг другу.

### Масштабирование узлов

**Cluster Autoscaler**:
- видит поды в `Pending` из-за нехватки ресурсов → увеличивает подходящую **группу узлов** (ASG, node pool);
- видит недогруженные узлы (сумма requests ниже порога), поды с которых можно разместить в другом месте → удаляет узел, предварительно выселив поды (уважая PodDisruptionBudget).

**Karpenter** (AWS, Azure): не привязан к заранее созданным группам — сам выбирает **тип и размер инстанса** под конкретные ожидающие поды, умеет spot, консолидацию (пересобрать узлы в более дешёвые), быстрее Cluster Autoscaler.

Что мешает уменьшению: поды без контроллера, поды с локальным хранилищем (`emptyDir` по умолчанию в CA), строгие PDB, аннотация `safe-to-evict: false`, системные поды без PDB.

### Как всё работает вместе

Рост трафика → HPA увеличивает реплики → новые поды не помещаются → Pending → Cluster Autoscaler или Karpenter добавляет узел (1–3 минуты) → поды запускаются. Задержку узлов компенсируют запасом: «пустые» поды с низким приоритетом (overprovisioning), которые вытесняются реальными.

### Проверьте себя
- Почему HPA по CPU не работает без requests?
- Как HPA рассчитывает число реплик?
- Чем Karpenter отличается от Cluster Autoscaler?
- Почему Cluster Autoscaler не удаляет недогруженный узел?
- Как масштабировать воркеры по длине очереди?

## Расширение: CRD, операторы и finalizers
id: extensibility

> **Суть:** **CRD** добавляет в API новый тип объектов (например, `PostgresCluster`), а **оператор** — контроллер, который знает, как приводить реальный мир к описанию таких объектов: создать кластер БД, сделать бэкап, переключить лидера. **Finalizers** не дают удалить объект, пока контроллер не выполнит очистку.

### CRD

CustomResourceDefinition регистрирует новый ресурс с OpenAPI-схемой. После этого `kubectl get certificates`, RBAC, `apply`, watch работают как со встроенными объектами. Но сам по себе CRD — только хранение данных; без контроллера ничего не происходит.

### Оператор

Оператор = CRD + контроллер с **операционными знаниями** конкретной системы. Пример `Certificate` у cert-manager: вы пишете желаемый сертификат, оператор проходит проверку ACME, кладёт ключ в Secret и продлевает заранее.

Известные операторы: cert-manager, Prometheus Operator (`ServiceMonitor`, `PrometheusRule`), CloudNativePG, Strimzi (Kafka), Argo CD (`Application`), Crossplane (облачные ресурсы как объекты Kubernetes).

**Когда писать свой**: у системы есть сложный жизненный цикл, который сейчас выполняется руками или скриптами (масштабирование с перебалансировкой, бэкапы и восстановление, обновления по шагам), и вы готовы **поддерживать** оператор как продукт. Не стоит, если хватает Helm-чарта, CronJob или существующего оператора. Инструменты: Kubebuilder, Operator SDK (Go), kopf (Python).

Принципы хорошего контроллера: идемпотентный цикл согласования, состояние — в `status` объекта, повторные попытки с задержкой, **owner references** для автоматической уборки дочерних объектов.

### Finalizers и зависший Terminating

**Finalizer** — строка в `metadata.finalizers`. Пока список не пуст, объект при удалении получает `deletionTimestamp` и висит в **Terminating**: контроллер должен выполнить очистку (удалить облачный балансировщик, отвязать диск) и убрать свой finalizer.

Почему **namespace завис в Terminating**:
1. В namespace остались объекты с finalizers, чей **контроллер удалён или не работает** (удалили оператор раньше его ресурсов).
2. Недоступен **APIService** агрегированного API (например, сломанный metrics-server): контроллер namespace не может перечислить все типы ресурсов и не завершает удаление. Видно в `kubectl get apiservice` (`False`) и в `status.conditions` namespace.

Диагностика и решение:
```bash
kubectl get ns shop -o yaml                  # status.conditions — что мешает
kubectl api-resources --verbs=list --namespaced -o name \
  | xargs -n1 kubectl get -n shop --ignore-not-found --show-kind
kubectl get apiservice | grep False
```
Правильно — починить или вернуть контроллер, чтобы он выполнил очистку, или удалить сломанный APIService. Ручное удаление finalizer (`kubectl patch ... -p '{"metadata":{"finalizers":null}}' --type=merge`) — крайняя мера: внешние ресурсы (балансировщики, диски) могут остаться висеть и стоить денег.

### Проверьте себя
- Чем CRD отличается от оператора?
- Когда стоит писать свой оператор, а когда нет?
- Зачем нужны finalizers?
- Namespace висит в Terminating. Какие две основные причины и как их найти?

## Helm и Kustomize
id: packaging

> **Суть:** **Helm** — пакетный менеджер: шаблоны манифестов + values, установка с историей релизов и откатами. **Kustomize** — без шаблонов: базовые манифесты плюс наложения (overlays) с патчами для окружений. Helm удобен для распространяемых пакетов, Kustomize — для собственных приложений с небольшими различиями окружений; часто их сочетают.

### Helm

Структура чарта:
```
mychart/
  Chart.yaml          # имя, версия чарта, appVersion, зависимости
  values.yaml         # значения по умолчанию
  templates/          # шаблоны Go template + функции Sprig
    deployment.yaml
    _helpers.tpl      # именованные шаблоны (метки, имена)
  charts/             # зависимости
```
```yaml
image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
replicas: {{ .Values.replicaCount }}
```
Команды:
```bash
helm upgrade --install api ./mychart -n shop -f values-prod.yaml --set image.tag=1.4.2 --atomic --wait
helm history api -n shop
helm rollback api 3 -n shop
helm template ./mychart -f values-prod.yaml      # отрендерить без установки
helm diff upgrade api ./mychart -f values-prod.yaml   # плагин helm-diff
helm lint ./mychart
```
- **Релиз** — установленный экземпляр чарта; каждая установка или обновление — новая **ревизия**, хранится в Secret в namespace релиза.
- `--atomic` — откатить автоматически, если обновление не удалось; `--wait` — дождаться готовности.
- Helm 3 применяет **трёхстороннее слияние** (старый манифест, новый, текущее состояние): ручные правки в кластере могут неожиданно сохраниться или затереться.
- Хуки (`pre-install`, `pre-upgrade`) — для миграций, но их жизненный цикл неочевиден; многие выносят миграции в отдельный Job в пайплайне.
- Чарты распространяются через репозитории или OCI-реестры.

Минусы: шаблоны YAML на Go template трудно читать и отлаживать (отступы, `nindent`), большие values-файлы превращаются в «язык программирования».

### Kustomize

```
base/
  deployment.yaml  service.yaml  kustomization.yaml
overlays/
  prod/
    kustomization.yaml
    replicas-patch.yaml
```
```yaml
# overlays/prod/kustomization.yaml
resources: [../../base]
namespace: shop-prod
images:
- {name: api, newTag: 1.4.2}
patches:
- path: replicas-patch.yaml
configMapGenerator:
- name: api-config
  literals: [LOG_LEVEL=info]
```
- Встроен в kubectl: `kubectl apply -k overlays/prod`, `kubectl kustomize overlays/prod`.
- Манифесты остаются обычным YAML, читаемым и проверяемым.
- `configMapGenerator` добавляет хеш к имени ConfigMap → изменение конфигурации автоматически перезапускает поды.
- Нет истории релизов и откатов (это задача Git и GitOps), нет логики и циклов.

### Что выбрать

| | Helm | Kustomize |
|---|---|---|
| Подход | шаблоны + параметры | патчи поверх базы |
| Распространение сторонним | **да**, стандарт де-факто | неудобно |
| Читаемость | хуже | лучше |
| Релизы, откаты | есть | через Git/GitOps |
| Логика | условия, циклы | нет (намеренно) |

Частый практический вариант: сторонние компоненты (ingress, мониторинг, cert-manager) — Helm-чартами; свои сервисы — общим внутренним чартом или Kustomize; поверх Helm можно применить Kustomize-патчи. Argo CD и Flux поддерживают оба.

### Проверьте себя
- Из чего состоит Helm-чарт и что такое релиз и ревизия?
- Как откатить релиз Helm и что делает `--atomic`?
- Как Kustomize решает задачу разных окружений без шаблонов?
- Когда вы выберете Helm, а когда Kustomize?

## Service mesh: Istio, Linkerd, Cilium
id: service-mesh

> **Суть:** service mesh выносит сетевую логику сервисов (mTLS, ретраи, таймауты, балансировка L7, разделение трафика, метрики) из кода приложений в инфраструктуру: прокси рядом с каждым подом (sidecar) или на узле (ambient), управляемые централизованным control plane.

### Что даёт mesh

- **Безопасность**: автоматический **mTLS** между всеми сервисами, идентичность сервиса (SPIFFE) и политики «кто к кому может» на основе идентичности, а не IP.
- **Управление трафиком**: канарейки по весам и заголовкам, ретраи, таймауты, circuit breaking, зеркалирование трафика, внедрение ошибок для тестов.
- **Наблюдаемость**: золотые сигналы для каждого вызова между сервисами и трейсинг без изменения кода (заголовки трассировки приложение всё же должно пробрасывать).
- **Балансировка L7** для gRPC и HTTP/2 (решает проблему «прилипания» долгих соединений).

### Архитектуры

- **Sidecar**: Envoy (Istio) или linkerd2-proxy (Linkerd) в каждом поде; iptables перехватывают трафик пода в прокси. Цена: CPU и память на каждый под, задержка, сложности со стартом и Job.
- **Ambient / sidecarless**: Istio ambient — L4-прокси `ztunnel` на узле для mTLS и отдельные waypoint-прокси для L7 только там, где нужно. Cilium — eBPF в ядре плюс Envoy на узле.

### Сравнение

| | Istio | Linkerd | Cilium Service Mesh |
|---|---|---|---|
| Прокси | Envoy (sidecar) или ambient | свой лёгкий прокси на Rust | eBPF + Envoy на узле |
| Возможности | максимум | основное: mTLS, ретраи, метрики, разделение трафика | сеть, политики, mTLS, L7 частично |
| Сложность | высокая | низкая | средняя, если Cilium уже CNI |

### Когда mesh действительно нужен

Нужен: много сервисов, требование mTLS везде (регуляторика, zero trust), сложное управление трафиком, однообразная наблюдаемость для команд на разных языках.

Не нужен: несколько сервисов, команда без ресурсов на поддержку, задачи решаются библиотеками или ingress. Mesh добавляет движущиеся части, задержки, сложность отладки и обновлений.

### Istio на практике

Канарейка 90/10:
```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata: {name: api}
spec:
  host: api
  subsets:
  - {name: v1, labels: {version: v1}}
  - {name: v2, labels: {version: v2}}
---
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: {name: api}
spec:
  hosts: [api]
  http:
  - route:
    - {destination: {host: api, subset: v1}, weight: 90}
    - {destination: {host: api, subset: v2}, weight: 10}
    retries: {attempts: 3, perTryTimeout: 2s, retryOn: "5xx,reset,connect-failure"}
    timeout: 10s
```
Строгий mTLS в namespace: `PeerAuthentication` с `mtls.mode: STRICT` (переход через `PERMISSIVE`, пока не все клиенты в mesh). Автоматизация канарейки по метрикам — Argo Rollouts или Flagger.

Ретраи осторожно: ретраи на каждом уровне цепочки умножаются (3 × 3 × 3 = 27 запросов) и могут добить перегруженный сервис; ретраить только идемпотентные запросы, с бюджетом.

Отладка: `istioctl analyze` (ошибки конфигурации), `istioctl proxy-status` (синхронизирован ли прокси с control plane), `istioctl proxy-config routes|clusters|listeners pod`, логи `istio-proxy`, коды флагов Envoy в access-логах (`UH` — нет здоровых апстримов, `UF` — ошибка подключения, `NR` — нет маршрута). Частые проблемы: порт сервиса назван не по протоколу, под без sidecar при STRICT mTLS, приложение стартует раньше прокси (решается `holdApplicationUntilProxyStarts` или native sidecar).

### Проверьте себя
- Какие задачи решает service mesh?
- Чем sidecar-архитектура отличается от ambient?
- Когда mesh не нужен?
- Почему ретраи в mesh могут навредить?
- Как сделать канарейку 10% в Istio?

## Эксплуатация: обновление кластера, etcd, drain и PDB
id: operations

> **Суть:** обновление кластера идёт по одной минорной версии за раз: сначала control plane, потом узлы. Узлы выводят через `drain`, который уважает **PodDisruptionBudget**. etcd — единственное состояние кластера, его регулярно бэкапят снапшотами и проверяют восстановление.

### Политика версий

- Kubernetes выходит примерно три раза в год, поддерживаются три последних минорных версии (около 14 месяцев патчей). Отставать нельзя долго: обновляться через несколько версий сразу запрещено.
- **Version skew**: kubelet может отставать от API-сервера на несколько минорных версий (до трёх в современных версиях), но не может быть новее.
- Удалённые API: перед обновлением проверить манифесты и чарты на устаревшие версии API (`pluto`, `kubent`, метрика `apiserver_requested_deprecated_apis`).

### Порядок обновления

1. Прочитать changelog, проверить удалённые API и совместимость дополнений (CNI, CSI, ingress, операторы).
2. **Бэкап etcd**.
3. Обновить в тестовом кластере.
4. **Control plane**: в managed-кластерах — кнопкой или Terraform; в kubeadm — `kubeadm upgrade plan` / `apply` на первом мастере, затем на остальных.
5. **Узлы** по одному или пачками: `cordon` → `drain` → обновить kubelet (или заменить узел новым образом) → `uncordon`. В облаках часто удобнее **заменять** узлы: новая группа узлов, перенос нагрузки, удаление старой (blue/green для узлов).
6. Обновить дополнения.

### drain и PodDisruptionBudget

```bash
kubectl cordon node-1                       # запретить планирование новых подов
kubectl drain node-1 --ignore-daemonsets --delete-emptydir-data
kubectl uncordon node-1
```
`drain` выселяет поды через Eviction API, который **уважает PDB**:
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
spec:
  minAvailable: 2          # или maxUnavailable: 1
  selector: {matchLabels: {app: api}}
```
- PDB защищает от **добровольных** нарушений (drain, обновление, Cluster Autoscaler), но не от падения узла.
- Ловушки: PDB `minAvailable: 1` у сервиса с одной репликой или `maxUnavailable: 0` — drain **зависнет навсегда**. PDB для одной реплики бессмыслен — нужно минимум две.

### etcd

- Хранит всё состояние. Потеря etcd без бэкапа = потеря кластера (манифесты в Git помогают восстановить приложения, но не всё состояние).
- Бэкап:
```bash
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-$(date +%F).db \
  --endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key
etcdutl snapshot status /backup/etcd-2026-10-07.db
```
  Хранить вне кластера, шифровать (там секреты), **регулярно проверять восстановление**.
- Восстановление: `etcdutl snapshot restore` в новый каталог данных на всех членах, перезапуск etcd и API-серверов. Состояние откатывается на момент снапшота.
- Здоровье: `etcdctl endpoint health`, `endpoint status` (лидер, размер БД). etcd чувствителен к **задержке диска** (нужны SSD, метрика `etcd_disk_wal_fsync_duration_seconds`) и к размеру БД (дефрагментация, квота по умолчанию 2 ГБ, превышение — кластер только для чтения).
- В managed-кластерах (EKS, GKE, AKS) etcd обслуживает провайдер; для защиты приложений и PV — **Velero**.

### Сертификаты

В kubeadm-кластерах сертификаты компонентов действуют год и обновляются при `kubeadm upgrade`; иначе — `kubeadm certs check-expiration` и `renew`. Истёкшие сертификаты — частая причина «внезапно сломавшегося» самостоятельного кластера.

### Проверьте себя
- Почему нельзя обновиться сразу через две минорные версии?
- В каком порядке обновляются компоненты кластера?
- Почему `kubectl drain` завис и при чём здесь PDB?
- Как бэкапить etcd и почему бэкап без проверки восстановления не бэкап?

## Диагностика: Pending, CrashLoopBackOff, NotReady и другие
id: troubleshooting

> **Суть:** у каждого симптома свой первый шаг. Почти всегда начинайте с `kubectl describe` (события внизу) и `kubectl logs --previous`, затем спускайтесь на уровень узла. Знайте, какой компонент отвечает за какой этап: планировщик — Pending, kubelet и рантайм — ContainerCreating, приложение — CrashLoopBackOff.

### Карта симптомов

| Статус | Чья зона | Первые шаги |
|---|---|---|
| `Pending` | планировщик, ресурсы, тома | `describe pod` → Events (см. [Планирование](#/theory/kubernetes/scheduling)) |
| `ContainerCreating` долго | kubelet, CNI, CSI, секреты | `describe pod`: ошибки монтирования, `failed to setup network`, нет Secret/ConfigMap |
| `ImagePullBackOff`, `ErrImagePull` | рантайм, реестр | имя и тег, доступ к реестру с узла, `imagePullSecrets`, лимиты Docker Hub |
| `CrashLoopBackOff` | приложение | `logs --previous`, код выхода в `describe` |
| `Running`, но не Ready | readinessProbe | `describe` (Readiness probe failed), эндпоинт пробы |
| `OOMKilled` | лимит памяти | `describe` → Last State, потребление, утечки |
| `Evicted` | давление на узле | `describe pod` (причина), состояние узла |
| `Terminating` долго | finalizers, узел недоступен | см. [finalizers](#/theory/kubernetes/extensibility); `--grace-period=0 --force` — крайняя мера |

### CrashLoopBackOff по шагам

1. `kubectl describe pod` → **Last State: Terminated**, `Reason` и `Exit Code`:
   - `OOMKilled` / 137 — память;
   - 1 и другие — ошибка приложения;
   - 127 / 126 — нет команды или прав;
   - `Completed` / 0 — процесс просто завершился (не сервис, неверная команда).
2. `kubectl logs pod -c app --previous` — лог упавшего запуска.
3. Проверить конфигурацию: переменные, Secret и ConfigMap (неверные значения), монтирования, доступность зависимостей.
4. Пробы: не убивает ли **liveness** приложение до окончания старта (тогда в событиях `Liveness probe failed`, а код выхода — 137 или 143 от kubelet).
5. Воспроизвести: `kubectl debug pod --copy-to=dbg --container=app -- sh` (копия пода с другой командой) или запустить образ локально.

### Узел NotReady

kubelet перестал докладывать статус API-серверу (по умолчанию через ~40 с узел становится NotReady; через 5 минут поды начинают выселяться через taint `node.kubernetes.io/unreachable`).

1. `kubectl describe node` → **Conditions**: `MemoryPressure`, `DiskPressure`, `PIDPressure`, `NetworkUnavailable`, `Ready` с сообщением.
2. На узле (SSH или консоль облака):
   - `systemctl status kubelet`, `journalctl -u kubelet -e` — почему не работает: сертификаты истекли, не может достучаться до API, ошибка конфигурации;
   - `systemctl status containerd`, `crictl ps` — работает ли рантайм;
   - ресурсы: `df -h` (полный диск — частая причина), `free -m`, `dmesg -T` (OOM, ошибки диска, kernel panic);
   - сеть до API-сервера: `curl -k https://<api>:6443/healthz`;
   - CNI: поды CNI на узле (`NetworkUnavailable`, «cni plugin not initialized»).
3. Если узел мёртв (ВМ не отвечает) — в облаке его заменит группа узлов или autoscaler; поды StatefulSet с RWO-дисками могут долго не переезжать (диск «привязан» к мёртвому узлу) — тогда нужна осознанная ручная очистка.

### Сеть и сервисы

Приложение не доступно по Service:
1. `kubectl get endpointslices -l kubernetes.io/service-name=api` — есть ли там IP подов? Пусто → **селектор не совпадает с метками** или поды не Ready.
2. `targetPort` совпадает с портом, который слушает контейнер? Слушает ли приложение `0.0.0.0`?
3. Из отладочного пода: `nslookup api.shop`, `curl api.shop:80`, `curl <pod-ip>:<port>`.
4. NetworkPolicy, которая режет трафик (в том числе DNS).
5. kube-proxy и CNI на узле, CoreDNS (`kubectl -n kube-system logs deploy/coredns`).

### Общий набор

```bash
kubectl get events -A --sort-by=.lastTimestamp | tail -30
kubectl describe pod|node|pvc <name>
kubectl logs <pod> -c <container> --previous
kubectl get pod <pod> -o yaml          # status: conditions, containerStatuses
kubectl debug node/<node> -it --image=busybox   # shell на узле через под
kubectl top pods --containers
```

### Проверьте себя
- Под в CrashLoopBackOff: какие три команды вы выполните первыми и что ищете?
- Service есть, поды Running, а запросы не проходят. Что проверить по порядку?
- Как отличить падение из-за OOM от падения из-за liveness-пробы?
- Узел NotReady. Что смотреть на самом узле?
