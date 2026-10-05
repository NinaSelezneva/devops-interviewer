---
id: ansible
title: Ansible и Config Management
icon: ⚙️
order: 7
summary: Идемпотентность, роли, inventory, Vault, производительность
---

# Ключевые концепции

**Configuration management** — приведение серверов к описанному состоянию: пакеты, файлы, сервисы, пользователи. Инструменты: Ansible (push, agentless), Puppet и Chef (pull, агенты), SaltStack.

### Ansible в двух словах
- Подключение по **SSH** (WinRM для Windows), на целевом хосте нужен только Python.
- **Inventory** — список хостов и групп (статический INI/YAML или динамический из облака).
- **Playbook** → **plays** → **tasks** → **modules**.
- **Roles** — переиспользуемые блоки (tasks, handlers, templates, defaults, vars).
- **Handlers** — выполняются один раз в конце play при наличии изменений (`notify`).
- **Jinja2** — шаблоны и выражения.
- **Collections** — дистрибуция модулей и ролей (Ansible Galaxy).

### Приоритет переменных (упрощённо, от низкого к высокому)
role defaults → inventory group_vars → host_vars → play vars → role vars → set_fact/register → extra vars (`-e`, наивысший).

## Q: Что такое идемпотентность и как её обеспечить в Ansible?
level: middle
type: theory
freq: 3
tags: идемпотентность

**Идемпотентность** — повторный запуск даёт тот же результат и **не вносит изменений**, если система уже в нужном состоянии. Второй прогон playbook должен показывать `changed=0`.

Модули Ansible (`apt`, `copy`, `template`, `service`, `user`, `lineinfile`) идемпотентны: они сначала проверяют текущее состояние.

Идемпотентность ломают модули **`command` / `shell`** — они всегда «changed». Решения:
- использовать специализированный модуль вместо shell;
- `creates:` / `removes:` — пропустить, если файл существует;
- `changed_when:` и `failed_when:` с условием по выводу;
- предварительная проверка с `register` и `when`.

```yaml
- name: Initialize DB once
  ansible.builtin.command: /opt/app/bin/init-db
  args:
    creates: /var/lib/app/.initialized
```

Проверка: прогон дважды в CI (Molecule делает это автоматически — idempotence test), режим `--check --diff`.

## Q: Как организовать большой Ansible-проект? Роли, inventory, переменные.
level: senior
type: design
freq: 2
tags: структура

```
inventories/
  prod/  hosts.yml  group_vars/  host_vars/
  stage/ hosts.yml  group_vars/
roles/
  common/  nginx/  postgres/
playbooks/
  site.yml  webservers.yml
collections/requirements.yml
ansible.cfg
```

Принципы:
- **Роли** маленькие и параметризуемые, значения по умолчанию в `defaults/` (легко переопределить), `vars/` — только внутренние константы.
- Окружения разделены inventory, а не условиями в коде.
- **Динамический inventory** для облака (плагины `aws_ec2`, `gcp_compute`) с группировкой по тегам.
- Внешние роли и коллекции закреплены по версиям в `requirements.yml`.
- Секреты — в **Ansible Vault** или из внешнего хранилища (lookup `hashi_vault`, `aws_secret`).
- Тестирование ролей — **Molecule** (docker/podman/vagrant драйверы) + ansible-lint в CI.
- Теги для частичного запуска, `--limit` для подмножества хостов.

## Q: Как обновить приложение на 100 серверах без даунтайма с помощью Ansible?
level: senior
type: scenario
freq: 2
tags: rolling-update

Rolling update с батчами и выводом из балансировщика:

```yaml
- hosts: web
  serial: "20%"            # батчи; можно [1, 5, "25%"] — сначала канарейка
  max_fail_percentage: 0   # остановиться при первой ошибке
  pre_tasks:
    - name: Remove from LB
      community.general.haproxy:
        state: disabled
        host: "{{ inventory_hostname }}"
      delegate_to: "{{ item }}"
      loop: "{{ groups['lb'] }}"
  roles:
    - app
  post_tasks:
    - name: Wait for health
      ansible.builtin.uri:
        url: "http://{{ inventory_hostname }}:8080/health"
      register: h
      until: h.status == 200
      retries: 30
      delay: 2
    - name: Return to LB
      community.general.haproxy:
        state: enabled
        host: "{{ inventory_hostname }}"
      delegate_to: "{{ item }}"
      loop: "{{ groups['lb'] }}"
```

Ключевые элементы: `serial`, `max_fail_percentage`, `delegate_to`, health-check с ретраями, `any_errors_fatal`. Для отката — версия как переменная и повторный прогон с предыдущей версией, либо symlink-переключение релизов (`current → releases/v2`).

## Q: Как ускорить выполнение Ansible на большом количестве хостов?
level: senior
type: practice
freq: 1
tags: производительность

- **forks** (по умолчанию 5!) — количество параллельных хостов, поднять до 50–100.
- **pipelining = True** — меньше SSH-операций на задачу (требует отключения `requiretty` в sudoers).
- **SSH ControlPersist** — переиспользование соединений.
- **Сбор фактов**: `gather_facts: false`, где не нужны; `gather_subset`; кеширование фактов (`fact_caching = jsonfile/redis`).
- **strategy: free** — хосты не ждут друг друга на каждой задаче.
- Асинхронные задачи (`async` + `poll: 0`) для долгих операций.
- Меньше задач: циклы в модулях пакетов (`apt: name: [a, b, c]` вместо loop), объединение операций.
- Профилирование: callback `profile_tasks`.
- Mitogen для Ansible (сторонний плагин стратегии; проверить совместимость с вашей версией).

На тысячах хостов стоит задуматься: может, лучше **immutable-образы** (Packer) и замена серверов вместо конфигурирования на месте.

## Q: Mutable vs immutable инфраструктура. Что выбрать?
level: senior
type: theory
freq: 2
tags: подходы

**Mutable**: серверы живут долго, изменения применяются на месте (Ansible/Puppet). Плюсы — быстрые точечные изменения, привычно. Минусы — **дрейф конфигурации** и «снежинки» (каждый сервер уникален из-за истории изменений), трудно воспроизвести, сложный откат.

**Immutable**: сервер/контейнер не меняется после создания. Для изменения собирается **новый образ** (Docker, AMI через Packer) и заменяются экземпляры. Плюсы — воспроизводимость, одинаковость окружений, простой откат (предыдущий образ), безопасность. Минусы — время сборки и деплоя, нужна автоматизация, stateful-данные выносятся отдельно.

На практике — гибрид: базовые образы собираются Packer + Ansible, запуск через ASG/Kubernetes, минимальная конфигурация при старте через cloud-init/переменные окружения. Ansible остаётся для legacy, баз данных, сетевого оборудования, bare metal.
