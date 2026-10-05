---
id: linux
title: Linux и ОС
icon: 🐧
order: 1
summary: Процессы, память, файловые системы, systemd, диагностика производительности
---

# Ключевые концепции

Linux — фундамент почти любого собеседования DevOps. На уровне senior ждут не список команд, а понимание **как работает ядро** и умение **методично диагностировать** проблему.

### Что нужно уверенно знать
- **Процессы**: `fork()` + `exec()`, состояния (R, S, D, Z, T), PID 1, сироты и зомби, сигналы.
- **Память**: виртуальная память, page cache, RSS vs VSZ, swap, OOM killer, overcommit.
- **Файловые системы**: inode, жёсткие и символические ссылки, VFS, ext4/xfs, mount, права, SUID/SGID/sticky.
- **Загрузка**: UEFI/BIOS → загрузчик (GRUB) → ядро + initramfs → init (systemd) → targets.
- **systemd**: unit-файлы, зависимости, journald, cgroups.
- **Изоляция**: namespaces (pid, net, mnt, uts, ipc, user, cgroup) и cgroups — основа контейнеров.
- **Производительность**: методология USE (Utilization, Saturation, Errors), инструменты `top/htop`, `vmstat`, `iostat`, `pidstat`, `sar`, `ss`, `strace`, `perf`, `bpftrace`.

### Шпаргалка «60 секунд на сервере» (Brendan Gregg)
```bash
uptime              # load average
dmesg -T | tail     # OOM, ошибки диска/сети
vmstat 1            # r (очередь CPU), si/so (swap), wa (iowait)
mpstat -P ALL 1     # дисбаланс по ядрам
pidstat 1           # кто ест CPU
iostat -xz 1        # await, %util дисков
free -m             # память и page cache
sar -n DEV 1        # сетевой трафик
sar -n TCP,ETCP 1   # новые соединения, ретрансмиты
top                 # общая картина
```

> На собеседовании проговаривайте ход мыслей: «сначала смотрю X, потому что хочу исключить Y». Это ценится больше, чем знание конкретного флага.

## Q: Что такое load average и как его интерпретировать?
level: middle
type: theory
freq: 3
tags: производительность, cpu

**Load average** — экспоненциально сглаженное среднее количество задач, которые **выполняются или ждут выполнения** за 1, 5 и 15 минут.

Важный нюанс Linux: в load average входят не только процессы в состоянии **R** (running/runnable), но и в **D** (uninterruptible sleep — обычно ожидание I/O, NFS, блокировок ядра). Поэтому высокий LA **не всегда означает нехватку CPU**.

Как интерпретировать:
- Сравнивать с количеством ядер (`nproc`): LA = 8 на 16 ядрах — нормально, на 2 ядрах — перегрузка.
- Смотреть на динамику: 1-мин > 15-мин — нагрузка растёт.
- Высокий LA при низком %CPU → ищите процессы в состоянии D: `ps -eo state,pid,cmd | grep '^D'`, смотрите `iostat -x` (await, %util), `vmstat` (столбец `b` и `wa`).

**Что могут спросить дальше:** чем LA отличается от утилизации CPU; что такое PSI (`/proc/pressure/cpu|io|memory`) — более точная метрика «давления» ресурсов в современных ядрах.

## Q: Расскажите о жизненном цикле процесса. Что такое зомби и сироты?
level: middle
type: theory
freq: 3
tags: процессы

Новый процесс создаётся через `fork()` (копия родителя с copy-on-write страницами), затем обычно `exec()` заменяет образ программы. Состояния: **R** (running), **S** (interruptible sleep), **D** (uninterruptible sleep), **T** (stopped), **Z** (zombie).

**Зомби** — процесс, который завершился, но родитель ещё не прочитал его код возврата через `wait()/waitpid()`. Ресурсы освобождены, но запись в таблице процессов (PID) осталась. Убить зомби нельзя — он уже мёртв. Решение: заставить родителя вызвать `wait` (послать ему `SIGCHLD`) или завершить родителя — тогда зомби усыновит init и «пожнёт».

**Сирота** — процесс, чей родитель завершился. Его усыновляет PID 1 (или ближайший процесс с `PR_SET_CHILD_SUBREAPER`).

Почему это важно в контейнерах: если ваше приложение стало PID 1 и не умеет «жать» детей, накапливаются зомби и в итоге кончаются PID'ы. Решение — `tini`/`dumb-init` или `docker run --init`, `shareProcessNamespace` в Kubernetes.

## Q: Какие сигналы вы знаете? Чем SIGTERM отличается от SIGKILL?
level: middle
type: theory
freq: 3
tags: процессы, сигналы

Сигнал — асинхронное уведомление процесса ядром.

| Сигнал | № | Назначение |
|---|---|---|
| SIGHUP | 1 | обрыв терминала; демоны часто перечитывают конфиг |
| SIGINT | 2 | Ctrl+C |
| SIGKILL | 9 | немедленное завершение, **нельзя перехватить** |
| SIGTERM | 15 | вежливая просьба завершиться, можно обработать |
| SIGSTOP/SIGCONT | 19/18 | приостановить / продолжить (STOP нельзя перехватить) |
| SIGCHLD | 17 | дочерний процесс изменил состояние |
| SIGSEGV | 11 | нарушение доступа к памяти |

**SIGTERM** даёт приложению шанс корректно завершиться: дописать данные, закрыть соединения, снять блокировки. **SIGKILL** обрабатывается ядром, процесс не узнает о нём. Процесс в состоянии D не умрёт даже от SIGKILL, пока не выйдет из системного вызова.

Практика: Kubernetes при удалении пода шлёт SIGTERM, ждёт `terminationGracePeriodSeconds` (по умолчанию 30с), затем SIGKILL. Если приложение запущено через shell-форму `CMD npm start`, SIGTERM получит `sh`, а не приложение — частая причина «долгого» завершения подов.

## Q: Как устроена память в Linux? Почему free показывает, что памяти почти нет?
level: middle
type: theory
freq: 3
tags: память

Linux использует свободную память под **page cache** (кеш файлов) и буферы — неиспользуемая память считается потраченной впустую. Поэтому смотреть надо на колонку **available** в `free -m`, а не `free`: она оценивает, сколько можно выделить без свопинга (включая освобождаемый кеш).

Ключевые понятия:
- **VSZ** — виртуальный размер (включает незатронутые страницы, mmap), почти ничего не говорит.
- **RSS** — резидентная память процесса, но разделяемые библиотеки считаются в каждом процессе. Точнее — **PSS** (`smem`, `/proc/PID/smaps_rollup`).
- **Overcommit** (`vm.overcommit_memory`): ядро позволяет выделить больше, чем есть, полагаясь на то, что не всё будет использовано.
- **OOM killer** при нехватке выбирает жертву по `oom_score` (можно править `oom_score_adj`). Следы — в `dmesg`: `Out of memory: Killed process`.
- **Swap** и `vm.swappiness` — склонность выгружать анонимную память vs сбрасывать кеш.

В контейнерах лимит задаётся cgroup (`memory.max` в cgroup v2), и OOM происходит **внутри cgroup**, даже если на хосте память есть — под получит `OOMKilled`.

## Q: Диск показывает «No space left on device», но df показывает свободное место. Почему?
level: senior
type: scenario
freq: 3
tags: файловые системы, траблшутинг

Возможные причины:
1. **Закончились inode'ы** — много мелких файлов (кеши, сессии, почтовая очередь). Проверка: `df -i`. Поиск: `find / -xdev -type d -size +1M` или подсчёт файлов по каталогам.
2. **Удалённый, но открытый файл** — место не освободится, пока процесс держит дескриптор. Это обычно обратная ситуация (df полон, du нет). Поиск: `lsof +L1` или `ls -l /proc/*/fd | grep deleted`. Решение: перезапустить процесс или `: > /proc/PID/fd/N`.
3. **Зарезервированные блоки** ext4 (по умолчанию 5% для root) — обычный пользователь видит «нет места» раньше. `tune2fs -m`.
4. **Квоты** пользователя/проекта (`quota`, xfs project quotas).
5. **Другая файловая система**: пишут в overlay контейнера, tmpfs (`/dev/shm`, `/run`) или в каталог, поверх которого смонтирован другой раздел (данные «спрятаны» под точкой монтирования).
6. **Btrfs/ZFS** — метаданные или снапшоты занимают место, `df` врёт; нужны `btrfs filesystem usage`.

Хороший ответ — показать последовательность: `df -h` → `df -i` → `lsof +L1` → `du -xsh` по каталогам → проверка монтирований.

## Q: Что такое inode? Чем жёсткая ссылка отличается от символической?
level: middle
type: theory
freq: 2
tags: файловые системы

**Inode** — структура ФС, хранящая метаданные файла: тип, права, владельца, размеры, временные метки, количество ссылок и указатели на блоки данных. **Имя файла в inode не хранится** — оно хранится в записи каталога (directory entry), которая сопоставляет имя → номер inode.

**Жёсткая ссылка** — ещё одна запись каталога на тот же inode. Счётчик ссылок увеличивается; данные удаляются, когда счётчик = 0 и файл никем не открыт. Ограничения:
- **нельзя между разными файловыми системами**: запись каталога хранит только **номер inode**, а номера уникальны лишь в пределах одной ФС. На другом разделе inode с тем же номером — совсем другой файл. Попытка даст `Invalid cross-device link` (EXDEV). По той же причине `mv` между ФС — это не переименование, а копирование и удаление;
- нельзя на каталоги (кроме служебных `.` и `..`), чтобы не создавать циклы в дереве.

**Символическая ссылка** — отдельный файл со своим inode, содержащий путь к цели. Может указывать на другую ФС, на каталог, может быть «битой».

Следствие: `rm` на самом деле вызывает `unlink()` — удаляет имя, а не данные. Отсюда эффект «удалил лог, а место не освободилось».

## Q: Опишите процесс загрузки Linux.
level: middle
type: theory
freq: 2
tags: загрузка, systemd

1. **Прошивка**: BIOS (POST, читает MBR, 446 байт загрузчика) или UEFI (читает EFI System Partition, запускает `.efi`-загрузчик; поддерживает GPT, Secure Boot).
2. **Загрузчик** (GRUB2, systemd-boot): выбирает ядро, передаёт параметры командной строки, загружает ядро и **initramfs**.
3. **Ядро**: инициализирует оборудование, распаковывает initramfs во временный rootfs.
4. **initramfs**: загружает нужные модули (драйвер диска, LVM, RAID, LUKS), находит и монтирует настоящий root, делает `switch_root`.
5. **init (PID 1)** — обычно systemd: строит граф зависимостей юнитов, параллельно запускает сервисы до `default.target` (`multi-user.target` или `graphical.target`).

Отладка: `systemd-analyze blame`, `systemd-analyze critical-chain`, `journalctl -b`, параметры ядра `rd.break`, `systemd.unit=rescue.target`.

## Q: Что такое systemd unit? Как написать сервис и почему он может не стартовать?
level: middle
type: practice
freq: 3
tags: systemd

Unit — объект, которым управляет systemd: `.service`, `.socket`, `.timer`, `.mount`, `.target` и др. Пример:

```ini
[Unit]
Description=My API
After=network-online.target
Wants=network-online.target

[Service]
User=app
ExecStart=/opt/api/bin/api --port 8080
Restart=on-failure
RestartSec=5
EnvironmentFile=/etc/api/env
LimitNOFILE=65536
MemoryMax=1G

[Install]
WantedBy=multi-user.target
```

Затем `systemctl daemon-reload && systemctl enable --now api`.

Частые проблемы: забыли `daemon-reload`; неверный `Type=` (для форкающихся демонов нужен `forking`, иначе systemd считает сервис упавшим); нет прав у `User`; переменные окружения из shell не наследуются; лимит рестартов (`StartLimitBurst`). Диагностика: `systemctl status`, `journalctl -u api -e`, `systemd-analyze verify`.

Senior-уровень: `Requires` vs `Wants`, `After` (только порядок, не зависимость), sandboxing (`ProtectSystem`, `PrivateTmp`, `NoNewPrivileges`), timers вместо cron.

## Q: Сервер «тормозит». Как вы будете искать причину?
level: senior
type: scenario
freq: 3
tags: производительность, траблшутинг

Важен **структурированный подход**, а не случайные команды.

1. **Уточнить симптом**: что именно медленно (латентность API, SSH, конкретный запрос), с какого момента, что менялось (деплой, трафик, крон).
2. **Общая картина**: `uptime` (LA), `dmesg -T | tail` (OOM, ошибки диска), `top`.
3. **Метод USE для каждого ресурса**:
   - CPU: `mpstat -P ALL 1` (одно ядро на 100% — однопоточное узкое место), `%steal` (соседи по гипервизору), `pidstat`.
   - Память: `free -m`, `vmstat 1` (si/so — свопинг), OOM в dmesg.
   - Диск: `iostat -xz 1` — `await`, `%util`, очередь; `iotop`.
   - Сеть: `sar -n DEV,TCP,ETCP 1` — ретрансмиты, `ss -s`, `ss -tan state time-wait | wc -l`, ошибки на интерфейсе (`ip -s link`).
4. **Уровень процесса**: `strace -c -p PID` (где проводит время в syscall'ах), `perf top`, `lsof -p`, лимиты (`cat /proc/PID/limits`) — например, упёрлись в `nofile`.
5. **Внешние зависимости**: медленная БД/DNS — `curl -w` с таймингами, трейсинг.
6. Сопоставить с **метриками и графиками** в мониторинге: когда началось, что коррелирует.

Закончить стоит выводом: найденная причина, временная митигация и долгосрочное исправление (алерт, лимит, capacity).

## Q: Что такое namespaces и cgroups?
level: senior
type: theory
freq: 3
tags: контейнеры, ядро

Это два механизма ядра, на которых построены контейнеры.

**Namespaces** — изоляция того, **что процесс видит**:
- `pid` — своё дерево PID (внутри контейнера процесс — PID 1);
- `net` — свои интерфейсы, маршруты, iptables;
- `mnt` — своя таблица монтирований;
- `uts` — hostname;
- `ipc` — разделяемая память, очереди сообщений;
- `user` — маппинг UID (root внутри ≠ root снаружи — rootless-контейнеры);
- `cgroup`, `time`.

**Cgroups** — ограничение и учёт того, **сколько процесс потребляет**: CPU (`cpu.max` — квоты CFS, `cpu.weight`), память (`memory.max`), I/O, количество PID. cgroup v2 — единая иерархия, PSI-метрики, используется по умолчанию в современных дистрибутивах и Kubernetes ≥1.25.

Посмотреть: `lsns`, `nsenter -t PID -n ip a` (зайти в сетевой namespace контейнера для отладки), `systemd-cgls`, `/sys/fs/cgroup/`.

Плюс к ним: **capabilities** (дробление прав root), **seccomp** (фильтр системных вызовов), **LSM** (AppArmor/SELinux), **overlayfs** для слоёв образа.

## Q: Как найти, какой процесс держит порт или файл? Как посмотреть, что делает зависший процесс?
level: middle
type: practice
freq: 2
tags: траблшутинг

- Порт: `ss -tulpn | grep :8080` или `lsof -i :8080`, `fuser 8080/tcp`.
- Файл/каталог: `lsof /var/log/app.log`, `fuser -vm /mnt/data` (почему не размонтируется).
- Что делает процесс:
  - `cat /proc/PID/status` (состояние, потоки, память), `/proc/PID/stack` (стек ядра — где завис в D-состоянии);
  - `strace -f -tt -p PID` — системные вызовы в реальном времени (например, висит на `connect()` или `futex()`);
  - `ls -l /proc/PID/fd` — открытые файлы и сокеты;
  - для JVM — `jstack`, для Python — `py-spy dump`, для Go — pprof/`SIGQUIT`.
- Профилирование CPU: `perf top -p PID`, флеймграфы.

Внимание: `strace` сильно замедляет процесс — на проде с осторожностью; альтернатива с меньшим оверхедом — eBPF (`bpftrace`, `bcc`-tools: `opensnoop`, `execsnoop`, `biolatency`).

## Q: Объясните права доступа в Linux, включая SUID, SGID и sticky bit.
level: middle
type: theory
freq: 2
tags: безопасность, права

Базовые права `rwx` для владельца, группы и остальных (`chmod 750`). Для каталога: `r` — читать список, `w` — создавать/удалять файлы, `x` — входить и обращаться к файлам по имени.

Специальные биты:
- **SUID** (4000) на исполняемом файле — запускается с правами владельца (`/usr/bin/passwd`). Опасен: SUID-бинарники — классический вектор повышения привилегий. Аудит: `find / -perm -4000`.
- **SGID** (2000) на файле — с правами группы; на каталоге — новые файлы наследуют группу каталога (удобно для общих папок).
- **Sticky bit** (1000) на каталоге — удалять файл может только владелец (`/tmp`, `drwxrwxrwt`).

Дополнительно: `umask`, ACL (`getfacl/setfacl`), атрибуты (`chattr +i` — неизменяемый файл), capabilities вместо SUID (`setcap cap_net_bind_service=+ep` — слушать порт <1024 без root).

## Q: Что произойдёт, если закончатся файловые дескрипторы? Как это диагностировать?
level: senior
type: scenario
freq: 2
tags: лимиты, траблшутинг

Симптомы: ошибки `Too many open files` (EMFILE), сервис перестаёт принимать соединения, хотя CPU и память в норме.

Лимиты на нескольких уровнях:
- процесс: `ulimit -n`, `cat /proc/PID/limits` (soft/hard `Max open files`);
- systemd-сервис: `LimitNOFILE=` (настройки `limits.conf` на сервисы systemd **не действуют**);
- система: `fs.file-max`, `fs.nr_open`; текущее использование — `/proc/sys/fs/file-nr`;
- контейнер: лимиты рантайма (`--ulimit`).

Диагностика: `ls /proc/PID/fd | wc -l`, `lsof -p PID | awk '{print $5}' | sort | uniq -c` — что именно открыто. Если растёт бесконечно — **утечка** (не закрываются сокеты/файлы), поднятие лимита лишь отсрочит проблему. Много сокетов в `CLOSE_WAIT` (`ss -tan state close-wait`) — приложение не закрывает соединения со своей стороны.

## Q: Какие типы юнитов systemd бывают? Какие типы сервисов и как ограничить ресурсы сервиса?
level: senior
type: theory
freq: 2
tags: systemd, cgroups

**Типы юнитов** (по расширению файла):
| Тип | Назначение |
|---|---|
| `.service` | процесс/демон |
| `.socket` | сокет-активация: systemd слушает порт и запускает сервис при первом подключении |
| `.timer` | запуск по расписанию (замена cron: `OnCalendar=`, `Persistent=`, логи в journald) |
| `.target` | группа юнитов, точка синхронизации (`multi-user.target`) — аналог runlevel |
| `.mount` / `.automount` | точки монтирования (генерируются из `/etc/fstab`) |
| `.path` | запуск при изменении файла/каталога |
| `.device` | устройства из udev |
| `.slice` / `.scope` | узлы иерархии cgroups для группового ограничения ресурсов |
| `.swap` | раздел подкачки |

**`Type=` для `.service`** — как systemd понимает, что сервис запустился:
- `simple` (по умолчанию) — запущен сразу после `fork()`; ошибки запуска бинарника не видны как ошибка старта;
- `exec` — после успешного `exec()` — честнее, чем simple;
- `forking` — классический демон, который форкается и завершает родителя; нужен `PIDFile=`;
- `oneshot` — разовая задача, systemd ждёт завершения (часто с `RemainAfterExit=yes`);
- `notify` — сервис сам сообщает о готовности через `sd_notify()` (`READY=1`) — самый точный вариант;
- `dbus`, `idle`.

**Основные директивы:**
- `[Unit]`: `Description`, `Requires` (жёсткая зависимость), `Wants` (мягкая), `After`/`Before` (только порядок!), `Conflicts`, `ConditionPathExists`.
- `[Service]`: `ExecStart`, `ExecStartPre`, `ExecReload`, `ExecStop`, `User`/`Group`, `WorkingDirectory`, `Environment`/`EnvironmentFile`, `Restart=on-failure|always`, `RestartSec`, `TimeoutStopSec`, `KillSignal`.
- `[Install]`: `WantedBy=multi-user.target` — куда подключить юнит при `systemctl enable`.

**Ограничение ресурсов** (через cgroups v2):
```ini
[Service]
CPUQuota=150%        # не более 1.5 ядра
CPUWeight=50         # относительный вес при конкуренции
MemoryHigh=800M      # порог, после которого память активно отбирается (throttling)
MemoryMax=1G         # жёсткий лимит → OOM-kill внутри сервиса
TasksMax=512         # лимит процессов/потоков (защита от fork-бомбы)
IOWeight=100
IOReadBandwidthMax=/dev/sda 50M
LimitNOFILE=65536    # rlimit открытых файлов (ulimit -n)
LimitCORE=0
```
Применить к работающему сервису на лету: `systemctl set-property api.service MemoryMax=2G`. Посмотреть потребление: `systemd-cgtop`, `systemctl status` (Memory, Tasks, CPU).

**Изоляция и безопасность**: `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `ReadWritePaths=`, `CapabilityBoundingSet=`, `DynamicUser=yes`, `SystemCallFilter=`. Оценка: `systemd-analyze security api.service`.

Менять юниты пакетов правильно через **drop-in**: `systemctl edit api` → `/etc/systemd/system/api.service.d/override.conf`, затем `daemon-reload`.

## Q: Что такое системный вызов? Чем strace отличается от ltrace и как ими пользоваться?
level: senior
type: practice
freq: 2
tags: syscalls, strace, траблшутинг

**Системный вызов** (syscall) — единственный способ для пользовательского процесса попросить ядро что-то сделать: открыть файл, выделить память, создать процесс, отправить данные в сеть. Процессор переключается из **user space** (кольцо 3, ограниченные привилегии) в **kernel space** (кольцо 0), ядро выполняет работу и возвращает результат или код ошибки (`errno`: `ENOENT`, `EACCES`, `EAGAIN`...).

Обычно программы не вызывают syscall напрямую, а пользуются обёртками **libc** (`fopen()` → `openat()`, `malloc()` → `brk()`/`mmap()`, `printf()` → `write()`).

Основные группы:
- процессы: `fork`/`clone`, `execve`, `exit`, `wait4`, `kill`;
- файлы: `openat`, `read`, `write`, `close`, `stat`, `unlink`, `fsync`;
- память: `mmap`, `brk`, `munmap`;
- сеть: `socket`, `bind`, `listen`, `accept`, `connect`, `sendto`, `recvfrom`;
- ожидание событий: `poll`, `epoll_wait`, `futex`.

Переключение в ядро стоит дорого, поэтому частые мелкие вызовы (`read` по 1 байту) замедляют программы. Именно syscall'ы фильтрует **seccomp** в контейнерах.

**strace** — трассирует **системные вызовы** и сигналы (через ptrace):
```bash
strace -f -tt -T -p 1234          # подключиться к процессу, -f — потоки и дети, -T — время в вызове
strace -e trace=network curl ya.ru # только сетевые вызовы
strace -e trace=openat,stat -f ./app 2>&1 | grep ENOENT   # какие файлы ищет и не находит
strace -c -p 1234                 # сводная статистика: где тратится время
```
Типичные находки: приложение не может найти конфиг (`ENOENT`), нет прав (`EACCES`), висит на `connect()` к недоступному хосту, на `futex()` (блокировка между потоками), на `read()` из сокета (ждёт ответа от зависимости).

**ltrace** — трассирует вызовы **функций динамических библиотек** (libc, libssl и т.д.): `ltrace -p 1234`, `ltrace -e malloc+free ./app`. Не работает со статически собранными бинарниками (Go) и сильнее замедляет процесс.

Оба инструмента заметно замедляют процесс, поэтому в продакшене их стоит применять осторожно. Альтернативы с меньшим оверхедом — eBPF: `perf trace`, `bpftrace`, утилиты bcc (`opensnoop`, `execsnoop`, `tcpconnect`).

## Q: Почему файл не удаляется? Перечислите возможные причины.
level: senior
type: scenario
freq: 2
tags: файлы, права, траблшутинг

Удаление файла — это `unlink()`, то есть изменение **каталога**, а не самого файла. Отсюда главный нюанс: права на файл для удаления не важны.

Причины `Permission denied` / `Operation not permitted`:
1. **Нет права `w` (и `x`) на каталог**, в котором лежит файл. При этом права на сам файл не важны: файл с правами `000` можно удалить, если есть права на каталог.
2. **Sticky bit** на каталоге (`/tmp`, `drwxrwxrwt`): удалить может только владелец файла, владелец каталога или root.
3. **Атрибуты файла**: `chattr +i` (immutable — нельзя удалить, изменить, переименовать даже root'у) или `+a` (append-only, характерно для логов). Проверка: `lsattr file`, снятие: `chattr -i file`.
4. **Файловая система смонтирована read-only**: `Read-only file system`. Это бывает после ошибок диска (ext4 с `errors=remount-ro`, проверять `dmesg`), ISO и squashfs, нижние слои overlayfs, `readOnlyRootFilesystem` в контейнере.
5. **SELinux / AppArmor** запрещают операцию (`ausearch -m avc`, `dmesg`).
6. **Это точка монтирования**: `Device or resource busy`. Нужно сначала размонтировать (`findmnt`, `fuser -vm`).
7. **NFS/сетевые ФС**: удалённый, но открытый файл превращается в `.nfsXXXX` («silly rename»), пока процесс его держит; плюс проблемы прав root_squash.
8. Имя с **непечатаемыми символами**, пробелами или начинающееся с `-`: `rm -- -file`, `rm ./-file`, удаление по inode: `find . -inum 1234 -delete`.
9. Каталог не пуст (`rmdir`), нужен `rm -r`.

Отдельный случай: файл **удалился, но место не освободилось**. Процесс держит файл открытым, данные живут, пока счётчик ссылок и открытых дескрипторов не станет нулевым. Поиск: `lsof +L1`.

## Q: На проде лог-файл вырос до 5 ГБ и заполнил диск. Как безопасно освободить место?
level: middle
type: scenario
freq: 3
tags: логи, диск, logrotate

**Плохой вариант — `rm app.log`.** Процесс продолжает писать в удалённый файл через открытый дескриптор: место **не освободится**, а новых логов в файловой системе вы больше не увидите.

**Правильно — обнулить файл на месте** (truncate):
```bash
: > /var/log/app/app.log           # или
truncate -s 0 /var/log/app/app.log
# если файл уже удалён, но процесс его держит:
lsof +L1 | grep app                # PID и номер fd
: > /proc/<PID>/fd/<FD>
```
Если процесс открыл файл без флага `O_APPEND`, после обнуления он продолжит писать со старого смещения и получится **разреженный** (sparse) файл: `ls` покажет 5 ГБ, а `du` — реальный размер. Это не страшно, но может путать.

Если лог нужен для разбора, сначала сохраните хвост или сожмите копию **на другой раздел**: `tail -n 100000 app.log > /mnt/other/app.tail`.

**Чтобы не повторялось:**
- **logrotate** с ротацией по размеру и времени, сжатием и ограничением количества копий:
```
/var/log/app/*.log {
    daily
    maxsize 500M
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate        # если приложение не умеет переоткрывать файл
    # или вместо copytruncate: create + postrotate с отправкой SIGHUP/USR1
}
```
  `copytruncate` прост, но может потерять строки, записанные между копированием и обнулением. Надёжнее `create` + сигнал приложению переоткрыть лог (nginx: `USR1`).
- Писать логи в **stdout/journald** и отправлять в централизованную систему: journald сам ограничивает размер (`SystemMaxUse=` в `journald.conf`, разовая очистка — `journalctl --vacuum-size=1G`), Docker — через `log-opts max-size/max-file`.
- Понизить уровень логирования (debug в проде — частая причина).
- **Отдельный раздел** под `/var/log`, чтобы логи не заполнили корневую ФС.
- **Алерт** на заполнение диска, причём по прогнозу (`predict_linear(node_filesystem_avail_bytes[6h], 4*3600) < 0`), а не только по порогу.

## Q: Как управлять пользователями, группами и sudo в Linux?
level: middle
type: practice
freq: 2
tags: пользователи, sudo, права

**Где хранится информация:**
- `/etc/passwd` — пользователи: `имя:x:UID:GID:комментарий:домашний_каталог:shell`;
- `/etc/shadow` — хеши паролей и сроки действия (доступен только root);
- `/etc/group` — группы и их участники.

UID 0 — root. Системные пользователи для сервисов (UID < 1000) создаются без shell для входа (`/usr/sbin/nologin`).

**Основные команды:**
```bash
useradd -m -s /bin/bash -G docker,wheel alice   # создать с домашним каталогом и доп. группами
passwd alice
usermod -aG docker alice     # ДОБАВИТЬ в группу (без -a все остальные доп. группы будут удалены!)
id alice; groups alice
userdel -r alice             # удалить вместе с домашним каталогом
useradd -r -s /usr/sbin/nologin app   # системный пользователь для сервиса
chown -R app:app /opt/app
```
Новые группы применяются только к **новым** сессиям: перелогиниться или выполнить `newgrp docker`.

**sudo** — выполнение команд от имени другого пользователя (обычно root) с аудитом. Правила в `/etc/sudoers` и `/etc/sudoers.d/*`, редактировать **только через `visudo`** (проверяет синтаксис, ошибка может лишить вас sudo):
```
%wheel   ALL=(ALL:ALL) ALL                           # группа wheel (sudo в Debian/Ubuntu) — всё
deploy   ALL=(root) NOPASSWD: /bin/systemctl restart api   # только конкретная команда без пароля
```
Хорошие практики: вход root по SSH запрещён (`PermitRootLogin no`), персональные учётки + sudo, минимальные права (конкретные команды вместо ALL), логи sudo (`journalctl _COMM=sudo`, `/var/log/auth.log` или `/var/log/secure`). Осторожно с разрешёнными командами, через которые можно получить shell: `vim`, `less`, `find -exec`, `tar` — сайт GTFOBins.

`su -` — переключиться на другого пользователя (нужен его пароль), `sudo -i` — интерактивный root-shell через sudo (нужен свой пароль).

## Q: Как работает cron? Объясните формат расписания.
level: middle
type: practice
freq: 3
tags: cron, планировщик

**cron** — демон, запускающий команды по расписанию. Где задаются задания:
- `crontab -e` / `crontab -l` — задания пользователя (хранятся в `/var/spool/cron/`);
- `/etc/crontab` и `/etc/cron.d/*` — системные, с дополнительным полем **пользователя**;
- `/etc/cron.daily`, `cron.hourly`, `cron.weekly` — каталоги со скриптами (запуск через run-parts или anacron).

**Формат:** `минута час день_месяца месяц день_недели команда`
```
# ┌ минута (0-59)
# │ ┌ час (0-23)
# │ │ ┌ день месяца (1-31)
# │ │ │ ┌ месяц (1-12)
# │ │ │ │ ┌ день недели (0-7, 0 и 7 — воскресенье)
  */5 * * * *   /opt/scripts/check.sh            # каждые 5 минут
  0 3 * * *     /opt/backup.sh                   # каждый день в 03:00
  30 2 * * 1-5  /opt/report.sh                   # в 02:30 по будням
  0 0 1 * *     /opt/monthly.sh                  # 1-го числа каждого месяца
  0 */6 * * *   /opt/sync.sh                     # каждые 6 часов
  @reboot       /opt/on-boot.sh
```
Проверять выражения удобно на crontab.guru.

**Типичные проблемы («вручную работает, а в cron — нет»):**
- **минимальное окружение**: другой `PATH` (`/usr/bin:/bin`), нет переменных из `.bashrc` → указывать полные пути или задавать `PATH=` в crontab;
- shell по умолчанию — `/bin/sh`, а не bash;
- символ `%` в crontab означает перевод строки, его нужно экранировать (`date +\%F`);
- вывод уходит в почту или теряется → перенаправлять: `>> /var/log/job.log 2>&1`;
- **параллельные запуски**, если задача длится дольше интервала → `flock -n /tmp/job.lock cmd`;
- часовой пояс сервера.

Логи: `grep CRON /var/log/syslog` или `journalctl -u cron`.

**Альтернативы:** **systemd timers** (логи в journald, зависимости, `Persistent=true` — догнать пропущенный запуск, случайная задержка `RandomizedDelaySec`), Kubernetes **CronJob**, планировщики в CI.

## Q: Типовые задачи с find, grep и sed: найдите большие файлы, замените строку в конфигах, найдите ошибки в логах.
level: middle
type: practice
freq: 3
tags: find, grep, sed

```bash
# --- find ---
find /var -xdev -type f -size +500M -exec ls -lh {} \;       # файлы больше 500 МБ на этом разделе
du -xh / 2>/dev/null | sort -rh | head -20                    # самые большие каталоги
find /var/log/app -name '*.log' -mtime +7 -delete            # логи старше 7 дней
find /etc -type f -mmin -60                                   # изменённые за последний час
find . -type f -name '*.sh' ! -perm -u+x                      # скрипты без права на выполнение
find /data -type f -print0 | xargs -0 -P4 gzip                # безопасно с пробелами, параллельно

# --- grep ---
grep -rn 'ERROR' /var/log/app/                 # рекурсивно, с номерами строк
grep -ri --include='*.yaml' 'image:' .         # без учёта регистра, только yaml
grep -c 'timeout' app.log                      # количество строк
grep -v '^#' nginx.conf | grep -v '^$'         # конфиг без комментариев и пустых строк
grep -E 'ERROR|FATAL' app.log | tail -50       # расширенные регулярные выражения
grep -A5 -B2 'Exception' app.log               # контекст: 5 строк после и 2 до
zgrep 'ERROR' app.log.*.gz                     # в сжатых логах
grep -l 'old.example.com' -r /etc              # только имена файлов

# --- sed ---
sed -i 's/old.example.com/new.example.com/g' /etc/app/*.conf   # замена во всех файлах
sed -i.bak 's/^#\?MaxSessions.*/MaxSessions 10/' /etc/ssh/sshd_config  # с бэкапом .bak
sed -n '100,200p' big.log                       # вывести строки 100–200
sed '/^\s*#/d; /^\s*$/d' config                 # удалить комментарии и пустые строки
sed -n '/2026-10-05 14:00/,/2026-10-05 14:10/p' app.log   # интервал времени в логе
```
Чего ждут на собеседовании: уверенное владение комбинацией утилит через пайпы, понимание `-exec` и `xargs`, привычка делать бэкап перед `sed -i`. Для массовых изменений конфигураций на многих серверах правильнее Ansible. Современные альтернативы: `ripgrep` (rg), `fd`.

## Q: Как добавить диск или расширить раздел на сервере? Что такое LVM и fstab?
level: middle
type: practice
freq: 2
tags: диски, lvm, fstab

**Посмотреть диски и разделы:** `lsblk`, `df -h`, `blkid`, `fdisk -l`.

**Новый диск без LVM:**
```bash
parted /dev/sdb --script mklabel gpt mkpart primary ext4 0% 100%
mkfs.ext4 /dev/sdb1                    # или mkfs.xfs
mkdir /data && mount /dev/sdb1 /data
blkid /dev/sdb1                        # узнать UUID
echo 'UUID=xxxx /data ext4 defaults,nofail 0 2' >> /etc/fstab
mount -a                               # проверить fstab ДО перезагрузки
```
**/etc/fstab** — что монтировать при загрузке: `устройство точка ФС опции dump pass`. Указывать **UUID**, а не `/dev/sdb1` (имена устройств могут поменяться). Опция `nofail` — не останавливать загрузку, если диска нет. Ошибка в fstab может отправить сервер в emergency mode при перезагрузке, поэтому обязательно `mount -a` или `findmnt --verify`.

**LVM** (Logical Volume Manager) — слой абстракции над дисками:
- **PV** (physical volume) — диск или раздел, отданный LVM;
- **VG** (volume group) — пул из одного или нескольких PV;
- **LV** (logical volume) — «раздел» из пула, на нём создаётся ФС.

Плюсы: расширение томов на лету, объединение нескольких дисков, снапшоты, перенос данных между дисками (`pvmove`).

```bash
pvcreate /dev/sdc
vgextend vg_data /dev/sdc                  # добавить диск в пул
lvextend -r -L +50G /dev/vg_data/lv_app    # -r сразу расширяет файловую систему
# или по отдельности: resize2fs (ext4) / xfs_growfs /mount/point (xfs)
```

**Расширение диска в облаке** (увеличили volume в консоли): `growpart /dev/nvme0n1 1` (расширить раздел) → `resize2fs /dev/nvme0n1p1` или `xfs_growfs /`. Перезагрузка не нужна.

**Важно:** XFS можно только **увеличить**, уменьшить нельзя. Ext4 уменьшается только в размонтированном виде. Перед операциями с разделами делать снапшот или бэкап.

## Q: Где искать логи в Linux? Как пользоваться journalctl?
level: middle
type: practice
freq: 2
tags: логи, journald

**Классические текстовые логи** в `/var/log/`:
- `syslog` (Debian/Ubuntu) или `messages` (RHEL) — общий системный журнал;
- `auth.log` / `secure` — входы, sudo, SSH;
- `kern.log`, вывод `dmesg` — сообщения ядра (OOM killer, ошибки дисков, сети);
- логи приложений: `/var/log/nginx/`, `/var/log/postgresql/` и т.д.

Их пишет **rsyslog**, ротирует **logrotate**.

**journald** (systemd) — бинарный структурированный журнал всех сервисов, ядра и stdout/stderr юнитов:
```bash
journalctl -u nginx                       # логи конкретного сервиса
journalctl -u nginx -f                    # в реальном времени (как tail -f)
journalctl -u api --since "1 hour ago"    # или --since "2026-10-05 14:00" --until ...
journalctl -p err -b                      # только ошибки с момента текущей загрузки
journalctl -b -1                          # логи предыдущей загрузки (почему сервер перезагрузился)
journalctl -k                             # сообщения ядра
journalctl _PID=1234
journalctl -u api -o json-pretty          # структурированный вывод
journalctl --disk-usage
journalctl --vacuum-time=7d               # очистить старое
```
Чтобы журнал сохранялся между перезагрузками, нужен каталог `/var/log/journal` (`Storage=persistent` в `journald.conf`). Размер ограничивается `SystemMaxUse=`.

В контейнерах логи читают через `docker logs` / `kubectl logs`, в продакшене — из централизованной системы (ELK, Loki).

## Q: Что такое /proc и /sys? Какую полезную информацию оттуда можно получить?
level: middle
type: theory
freq: 2
tags: procfs, sysfs

Это **виртуальные файловые системы**: файлы не хранятся на диске, ядро генерирует их содержимое при чтении. Через них ядро показывает своё состояние, а часть параметров можно менять записью.

**/proc** — процессы и состояние ядра:
- `/proc/<PID>/` — всё о процессе: `cmdline` (аргументы, разделённые `\0`), `environ` (переменные окружения), `status` (состояние, память, потоки, UID), `limits` (ulimit), `fd/` (открытые файлы и сокеты), `cwd`, `exe`, `maps` / `smaps_rollup` (память), `io` (статистика ввода-вывода), `cgroup`, `ns/` (namespaces), `oom_score_adj`;
- `/proc/cpuinfo`, `/proc/meminfo`, `/proc/loadavg`, `/proc/uptime`, `/proc/mounts`, `/proc/net/tcp`, `/proc/pressure/{cpu,io,memory}` (PSI);
- `/proc/sys/` — **параметры ядра**, которыми управляет `sysctl`: `cat /proc/sys/net/ipv4/ip_forward` = `sysctl net.ipv4.ip_forward`.

Утилиты `ps`, `top`, `free`, `ss`, `lsof` фактически читают `/proc`.

**/sys** (sysfs) — устройства, драйверы и подсистемы ядра в виде дерева:
- `/sys/class/net/eth0/` — параметры сетевого интерфейса (`speed`, `mtu`, `statistics/rx_errors`);
- `/sys/block/sda/queue/scheduler` — планировщик ввода-вывода диска, `rotational` (SSD или HDD);
- **`/sys/fs/cgroup/`** — иерархия cgroups: лимиты и потребление ресурсов контейнеров и systemd-сервисов (`memory.current`, `memory.max`, `cpu.stat` с полями throttling);
- `/sys/kernel/mm/transparent_hugepage/enabled` — THP (часто отключают для БД и Redis).

**Полезные приёмы:**
```bash
tr '\0' ' ' < /proc/1234/cmdline              # полная команда процесса
tr '\0' '\n' < /proc/1234/environ | grep DB_   # переменные окружения процесса
ls -l /proc/1234/fd | wc -l                    # число открытых дескрипторов
cat /sys/fs/cgroup/system.slice/nginx.service/memory.current
cat /proc/1234/status | grep -E 'State|VmRSS|Threads'
```
Внимание: через `/proc/<PID>/environ` видны секреты из переменных окружения — читать его может владелец процесса и root. Это одна из причин не передавать секреты через переменные окружения на общих хостах.

## Q: Что такое swap? Нужно ли его отключать на серверах и в Kubernetes?
level: middle
type: theory
freq: 2
tags: swap, память

**Swap** — область на диске (раздел или файл), куда ядро выгружает редко используемые страницы **анонимной памяти** (heap процессов), освобождая RAM. Страницы файлового кеша в swap не выгружаются: их можно просто сбросить и перечитать с диска.

**Плюсы:** запас на пиковое потребление, выгрузка «холодной» памяти неактивных процессов, отсрочка OOM killer.
**Минусы:** диск в тысячи раз медленнее памяти. При активном свопинге (**thrashing**) сервер почти перестаёт отвечать, но и не падает — это хуже явного отказа: health-check'и проходят, а латентность огромная.

**Настройки:**
- `vm.swappiness` (0–200, по умолчанию 60) — насколько охотно ядро выгружает анонимную память по сравнению со сбросом файлового кеша. Для серверов с БД часто ставят 1–10;
- `free -m`, `swapon --show`, `vmstat 1` (столбцы `si`/`so` — чтение и запись в swap прямо сейчас: важна именно активность, а не занятый объём);
- **zram** — сжатый swap в памяти, популярен на десктопах и небольших ВМ.

**Kubernetes:** исторически kubelet **требовал отключить swap** (иначе не запускался): requests и limits памяти и вытеснение подов рассчитаны на отсутствие swap, а предсказуемость важнее. Сейчас поддержка swap стабилизирована (feature NodeSwap, режим `LimitedSwap` — использовать swap могут только поды класса Burstable в пределах рассчитанной доли), но включают её осознанно, по умолчанию многие кластеры по-прежнему работают без swap.

**Базы данных и кеши** (PostgreSQL, Redis, Elasticsearch, Kafka) обычно настраивают так, чтобы они не уходили в swap: минимальный swappiness, `bootstrap.memory_lock` в Elasticsearch, корректные лимиты памяти.

**Рекомендация на собеседовании:** «Зависит от нагрузки. На серверах приложений небольшой swap с низким swappiness даёт запас и время на реакцию, но мониторю активность свопинга (`si/so`, PSI memory) и алерчу на неё. В Kubernetes по умолчанию без swap, если нет отдельной причины включать».

## Q: Как настроить параметры ядра через sysctl для высоконагруженного сервера?
level: senior
type: practice
freq: 2
tags: sysctl, производительность

**sysctl** — чтение и изменение параметров ядра (`/proc/sys/`):
```bash
sysctl net.core.somaxconn                      # прочитать
sysctl -w net.core.somaxconn=65535             # изменить до перезагрузки
echo 'net.core.somaxconn = 65535' > /etc/sysctl.d/90-tuning.conf   # постоянно
sysctl --system                                # применить все файлы
```

**Часто настраиваемые параметры:**
| Параметр | Зачем |
|---|---|
| `net.core.somaxconn` | максимальная очередь принятых соединений (`listen` backlog); приложение тоже должно запросить большой backlog |
| `net.ipv4.tcp_max_syn_backlog` | очередь полуоткрытых соединений (SYN) |
| `net.ipv4.ip_local_port_range = 1024 65535` | больше эфемерных портов для исходящих соединений (прокси, клиенты БД) |
| `net.ipv4.tcp_tw_reuse = 1` | переиспользование сокетов в TIME_WAIT для исходящих соединений |
| `net.ipv4.tcp_fin_timeout` | сколько держать FIN_WAIT_2 |
| `net.core.netdev_max_backlog` | очередь входящих пакетов при высоком PPS |
| `net.core.rmem_max`, `wmem_max`, `net.ipv4.tcp_rmem`, `tcp_wmem` | буферы сокетов для быстрых каналов с большой задержкой |
| `net.netfilter.nf_conntrack_max` | размер таблицы conntrack (ошибка `table full, dropping packet`) |
| `fs.file-max`, `fs.nr_open` | системный лимит файловых дескрипторов |
| `fs.inotify.max_user_watches`, `max_user_instances` | много наблюдателей за файлами (IDE, сборщики логов, kubelet) |
| `vm.swappiness` | склонность к свопингу |
| `vm.max_map_count` | число областей памяти процесса — Elasticsearch и OpenSearch требуют `262144` |
| `vm.dirty_ratio`, `vm.dirty_background_ratio` | когда сбрасывать «грязные» страницы на диск |
| `net.ipv4.ip_forward = 1` | маршрутизация пакетов (нужна для Kubernetes-нод, VPN, NAT) |

**Принципы:**
- **Не копировать «магические» конфиги из интернета** — менять параметр, когда есть **симптом** и метрика: переполнение очереди (`nstat -az | grep -i listen`, `ss -lnt` — Recv-Q у слушающего сокета), дропы, ошибка conntrack, исчерпание портов.
- Опасный параметр — `net.ipv4.tcp_tw_recycle`: ломал соединения клиентов за NAT и **удалён из ядра** в версии 4.12.
- Менять через управление конфигурацией (Ansible), а не вручную; задокументировать причину.
- **В контейнерах** часть параметров — свои для каждого сетевого namespace (`net.*`). В Kubernetes их задают через `securityContext.sysctls` пода: безопасные разрешены по умолчанию, остальные — только если разрешены в kubelet (`--allowed-unsafe-sysctls`). Параметры `vm.*` и `fs.*` общие для всего узла.

## Q: Как работают пакетные менеджеры? Как зафиксировать версию пакета и подключить свой репозиторий?
level: middle
type: practice
freq: 2
tags: apt, dnf, пакеты

**Семейства:**
- **Debian / Ubuntu**: пакеты `.deb`, низкоуровневый `dpkg`, высокоуровневый **`apt`**; репозитории в `/etc/apt/sources.list` и `/etc/apt/sources.list.d/` (новый формат `.sources` — deb822);
- **RHEL / CentOS Stream / Rocky / AlmaLinux / Fedora**: `.rpm`, `rpm`, **`dnf`** (раньше `yum`); репозитории в `/etc/yum.repos.d/*.repo`;
- **Alpine**: `apk`; **openSUSE**: `zypper`.

**Типовые операции:**
```bash
apt update && apt install -y nginx            # dnf install -y nginx
apt list --installed | grep nginx             # rpm -qa | grep nginx
apt-cache policy nginx                        # доступные версии и откуда; dnf list --showduplicates nginx
apt install nginx=1.24.0-2ubuntu7             # dnf install nginx-1.24.0
dpkg -L nginx                                 # файлы пакета; rpm -ql nginx
dpkg -S /usr/sbin/nginx                       # какому пакету принадлежит файл; rpm -qf
apt-mark hold nginx                           # запретить обновление; dnf versionlock add nginx
apt autoremove                                # удалить ненужные зависимости
```

**Свой или сторонний репозиторий** (на примере Debian/Ubuntu):
```bash
curl -fsSL https://repo.example.com/key.gpg | gpg --dearmor -o /etc/apt/keyrings/example.gpg
echo "deb [signed-by=/etc/apt/keyrings/example.gpg] https://repo.example.com/apt stable main" \
  > /etc/apt/sources.list.d/example.list
apt update
```
Ключ привязывается к конкретному репозиторию через `signed-by`, а не добавляется в общий список доверенных (`apt-key` устарел).

**Практика DevOps:**
- **зеркала и прокси-репозитории** (Nexus, Artifactory, Aptly, Pulp) — стабильность сборок, работа в закрытом контуре, контроль того, что ставится на серверы;
- **фиксация версий** критичных пакетов (БД, Kubernetes-компоненты `kubelet`/`kubeadm` — обновлять их нужно осознанно, а не случайно при `apt upgrade`);
- **автоматические обновления безопасности** (`unattended-upgrades`, `dnf-automatic`) для базовой системы;
- в Dockerfile — фиксировать версии пакетов там, где важна воспроизводимость, и чистить кеши в том же слое;
- собственные пакеты (deb/rpm) для внутренних утилит собирают в CI (fpm, nfpm).

## Q: Что такое SELinux и AppArmor? Почему их не стоит просто отключать?
level: middle
type: theory
freq: 2
tags: selinux, apparmor, безопасность

Обычные права Linux (**DAC** — discretionary access control) основаны на владельце файла: процесс, работающий от root или от владельца, может делать с файлом что угодно. **MAC** (mandatory access control) добавляет **обязательную политику**, которую процесс не может обойти даже от root: «процессу nginx можно читать только `/var/www` и слушать 80/443».

Если веб-сервер взломан, MAC ограничивает, куда злоумышленник может добраться.

**SELinux** (RHEL, Fedora, Rocky, Android):
- каждому процессу и файлу присвоен **контекст** (метка): `system_u:object_r:httpd_sys_content_t:s0`;
- политика описывает, какие типы процессов к каким типам объектов имеют доступ;
- режимы: `enforcing` (запрещает), `permissive` (только логирует), `disabled`;
- команды: `getenforce`, `ls -Z`, `ps -eZ`, `restorecon -Rv /var/www` (восстановить правильные метки), `semanage fcontext -a -t httpd_sys_content_t '/data/www(/.*)?'`, `setsebool -P httpd_can_network_connect on` (разрешить nginx ходить к апстримам), `semanage port -a -t http_port_t -p tcp 8081`;
- диагностика: `ausearch -m avc -ts recent`, `audit2why`, `sealert`.

**AppArmor** (Ubuntu, Debian, SUSE):
- **профили по путям** к исполняемым файлам: какие файлы, возможности (capabilities) и сеть разрешены программе;
- режимы `enforce` и `complain`; `aa-status`, `aa-complain`, `aa-enforce`, логи в `dmesg` / journal;
- проще в освоении, чем SELinux.

**Типичная ситуация:** «положил сайт в `/data/www`, nginx отдаёт 403, права на файлы правильные» → у файлов неправильный SELinux-контекст. Решение — `semanage fcontext` + `restorecon`, а не `setenforce 0`.

**Почему не отключать:**
- это важный слой защиты от эксплуатации уязвимостей и побега из контейнера (контейнерные рантаймы используют SELinux и AppArmor-профили для изоляции контейнеров);
- требования стандартов безопасности (CIS, PCI DSS, ФСТЭК);
- правильный путь — перевести в `permissive`, собрать отказы, донастроить политику и вернуть `enforcing`.

**В Kubernetes:** `securityContext.seLinuxOptions`, `appArmorProfile` (поле в securityContext с версии 1.30), seccomp-профили — дополняющие механизмы.

## Q: Что такое PSI (pressure stall information) и чем cgroup v2 отличается от v1?
level: senior
type: theory
freq: 1
tags: cgroups, psi, производительность

**cgroup v1 vs v2:**
| | cgroup v1 | cgroup v2 |
|---|---|---|
| Иерархия | **отдельное дерево для каждого контроллера** (cpu, memory, blkio...) — процесс мог быть в разных группах в разных деревьях | **единая иерархия** для всех контроллеров |
| Память | лимит без учёта многих видов памяти ядра, плохо работающий swap-лимит | `memory.max`, **`memory.high`** (мягкий порог с замедлением), `memory.min`/`memory.low` (защита от вытеснения), учёт памяти ядра и сокетов |
| Ввод-вывод | лимиты работали только для прямого I/O | корректный учёт буферизованной записи (writeback), `io.max`, `io.weight` |
| PSI | нет | есть для каждой группы |
| Делегирование | небезопасно | безопасное делегирование поддерева непривилегированным пользователям (rootless-контейнеры) |

cgroup v2 используется по умолчанию в современных дистрибутивах (Ubuntu 21.10+, RHEL 9, Debian 11+). Kubernetes полностью поддерживает v2 (рекомендуется), а поддержка v1 переведена в режим сопровождения и будет удалена. Проверить: `stat -fc %T /sys/fs/cgroup` → `cgroup2fs`.

Для Java и других рантаймов важно: старые версии JVM не видят лимиты cgroup v2 и считают, что им доступна вся память ноды → OOMKilled. Нужны актуальные версии (JDK 15+, обновлённые 11 и 8u).

**PSI (Pressure Stall Information)** — метрика ядра (с 4.20), показывающая, **какую долю времени задачи простаивали из-за нехватки ресурса**. В отличие от утилизации и load average, PSI отвечает прямо на вопрос «страдает ли нагрузка»:
```
$ cat /proc/pressure/memory
some avg10=2.31 avg60=1.05 avg300=0.40 total=123456789
full avg10=0.50 avg60=0.20 avg300=0.05 total=23456789
```
- **some** — доля времени, когда **хотя бы одна** задача ждала ресурс (задержки);
- **full** — доля времени, когда **все** активные задачи ждали (полная остановка работы, для CPU на уровне системы не считается);
- `avg10/60/300` — средние за 10, 60 и 300 секунд.

Файлы: `/proc/pressure/{cpu,memory,io}` — для всей системы, `/sys/fs/cgroup/<группа>/{cpu,memory,io}.pressure` — для отдельного контейнера или сервиса.

**Применение:**
- **мониторинг**: node_exporter собирает PSI (`node_pressure_*`), cAdvisor — для контейнеров; рост memory pressure — ранний признак нехватки памяти задолго до OOM, CPU pressure для контейнера — признак троттлинга;
- **systemd-oomd** и **oomd** (Meta) убивают процессы по PSI ещё до наступления жёсткого OOM, когда система уже «залипла» в свопинге;
- Kubernetes добавляет метрики PSI в kubelet и может использовать их для решений о нагрузке на ноде.
