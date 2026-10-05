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

## Q: Что такое inventory и ad-hoc команды в Ansible?
level: middle
type: practice
freq: 2
tags: inventory, ad-hoc

**Inventory** — список управляемых хостов и групп с переменными.
```ini
# inventory.ini
[web]
web1.example.com
web2.example.com ansible_host=10.0.1.12

[db]
db1.example.com ansible_user=admin ansible_port=2222

[prod:children]
web
db

[web:vars]
nginx_worker_processes=4
```
То же в YAML (`hosts.yml`) или **динамически** из облака (плагины `aws_ec2`, `gcp_compute`, `yandex` и др. по тегам). Переменные групп и хостов удобнее держать в каталогах `group_vars/web.yml` и `host_vars/web1.example.com.yml`. Специальные группы: `all`, `ungrouped`.

Проверить inventory: `ansible-inventory -i inventory.ini --graph`.

**Ad-hoc команды** — разовый вызов модуля без playbook:
```bash
ansible all -i inventory.ini -m ping                       # проверить доступность (SSH + Python)
ansible web -m shell -a 'uptime'
ansible web -m apt -a 'name=htop state=present' --become   # --become = sudo
ansible db -m service -a 'name=postgresql state=restarted' -b
ansible all -m setup -a 'filter=ansible_distribution*'     # собрать факты
ansible web -m copy -a 'src=./motd dest=/etc/motd' -b
ansible all -m shell -a 'df -h /' --limit 'web1*'          # ограничить хосты
```
Ad-hoc удобен для быстрых проверок и разовых действий. Всё повторяемое должно жить в playbook'ах в Git.

**Подключение:** по умолчанию SSH-ключи текущего пользователя, параметры `ansible_user`, `ansible_ssh_private_key_file`, `ansible_become`. Общие настройки — в `ansible.cfg` (inventory по умолчанию, `forks`, `host_key_checking`, `remote_user`).

## Q: Что такое handlers, facts и шаблоны Jinja2 в Ansible?
level: middle
type: practice
freq: 3
tags: handlers, jinja2, facts

```yaml
- hosts: web
  become: true
  vars:
    nginx_port: 80
  tasks:
    - name: Install nginx
      ansible.builtin.apt:
        name: nginx
        state: present
        update_cache: true

    - name: Deploy config
      ansible.builtin.template:
        src: templates/site.conf.j2
        dest: /etc/nginx/sites-enabled/site.conf
        validate: nginx -t -c %s      # проверить файл перед заменой
      notify: Reload nginx            # вызвать handler, только если файл изменился

    - name: Show OS
      ansible.builtin.debug:
        msg: "{{ inventory_hostname }} runs {{ ansible_facts['distribution'] }} {{ ansible_facts['distribution_version'] }}"

  handlers:
    - name: Reload nginx
      ansible.builtin.service:
        name: nginx
        state: reloaded
```

**Handlers** — задачи, которые выполняются **только при наличии изменений** (`changed`) в задачах, их вызвавших через `notify`, и **один раз в конце play**, даже если их уведомили несколько задач. Типичный случай — перезапуск сервиса после изменения конфигурации. Принудительно выполнить раньше — `meta: flush_handlers`. Если play упал до конца, handlers не выполнятся (помогает `--force-handlers`).

**Facts** — сведения о хосте, которые Ansible собирает модулем `setup` в начале play: ОС, IP-адреса, память, CPU, диски (`ansible_facts['default_ipv4']['address']`). Отключить сбор для ускорения — `gather_facts: false`. Свои вычисленные значения — `set_fact`, результат задачи — `register`.

**Шаблоны Jinja2** (`templates/site.conf.j2`):
```jinja
server {
    listen {{ nginx_port }};
    server_name {{ inventory_hostname }};
{% for backend in backends %}
    # backend {{ loop.index }}: {{ backend.host }}:{{ backend.port | default(8080) }}
{% endfor %}
{% if enable_ssl | bool %}
    listen 443 ssl;
{% endif %}
}
```
Фильтры: `default`, `upper`, `join`, `to_nice_yaml`, `regex_replace`, `ipaddr`. Переменные других хостов: `hostvars['db1']['ansible_host']`, группы: `groups['db']`.

**Модуль `template` vs `copy`:** `template` рендерит Jinja2 на управляющей машине и копирует результат, `copy` копирует файл как есть.

## Q: Как хранить секреты в Ansible? Как работает Ansible Vault?
level: middle
type: practice
freq: 3
tags: ansible-vault, секреты

**Ansible Vault** шифрует файлы или отдельные значения (AES-256), чтобы секреты можно было хранить в Git рядом с плейбуками.

**Шифрование файлов целиком:**
```bash
ansible-vault create group_vars/prod/vault.yml
ansible-vault edit group_vars/prod/vault.yml
ansible-vault encrypt secrets.yml / decrypt / view
ansible-vault rekey group_vars/prod/vault.yml      # сменить пароль
```

**Шифрование отдельной переменной:**
```bash
ansible-vault encrypt_string 'S3cr3t!' --name 'db_password'
```
```yaml
db_password: !vault |
  $ANSIBLE_VAULT;1.1;AES256
  6231...
```

**Рекомендуемая структура** — открытый файл ссылается на зашифрованный, чтобы было видно, **какие** переменные существуют, без раскрытия **значений**:
```yaml
# group_vars/prod/vars.yml
db_password: "{{ vault_db_password }}"
# group_vars/prod/vault.yml (зашифрован)
vault_db_password: "S3cr3t!"
```

**Запуск:**
```bash
ansible-playbook site.yml --ask-vault-pass
ansible-playbook site.yml --vault-password-file ~/.vault_pass      # файл НЕ в репозитории
ansible-playbook site.yml --vault-id prod@~/.vault_pass_prod --vault-id dev@prompt
```
**Vault ID** позволяют иметь разные пароли для разных окружений (разработчики знают пароль dev, но не prod). В CI пароль передаётся через защищённую переменную или скрипт, который получает его из секрет-хранилища (`--vault-password-file` может быть исполняемым скриптом).

**Не допускать утечек в логи:** `no_log: true` для задач, работающих с секретами (иначе значения попадут в вывод при ошибке или в режиме `-v`).

**Ограничения Ansible Vault:** один общий пароль на окружение, нет аудита доступа, ротация секрета требует правки файла и нового коммита, всё расшифровывается на машине, где запускается Ansible.

**Альтернатива для зрелой инфраструктуры** — брать секреты из внешнего хранилища во время выполнения:
```yaml
db_password: "{{ lookup('community.hashi_vault.hashi_vault', 'secret=secret/data/shop/db:password') }}"
```
или lookup-плагины для AWS Secrets Manager, Yandex Lockbox и др. Тогда в Git вообще нет секретов, даже зашифрованных.

## Q: Как тестировать Ansible-роли? Что такое Molecule?
level: senior
type: practice
freq: 2
tags: molecule, тестирование

**Уровни проверки:**
1. **Статические**: `ansible-lint` (лучшие практики: полные имена модулей, `changed_when` у `command`, отсутствие `latest`), `yamllint`, `ansible-playbook --syntax-check`.
2. **Dry-run на реальных хостах**: `--check --diff` — что изменится (не все модули корректно поддерживают check mode).
3. **Тестирование роли в изолированном окружении — Molecule.**
4. Интеграционное тестирование всего плейбука на staging.

**Molecule** — фреймворк для тестирования ролей: поднимает временные экземпляры (Docker/Podman-контейнеры, ВМ через Vagrant или облако), применяет роль и проверяет результат.

```
roles/nginx/
  molecule/default/
    molecule.yml      # драйвер и платформы (например, ubuntu 24.04 и rocky 9)
    converge.yml      # плейбук, применяющий роль
    verify.yml        # проверки результата
```
```yaml
# molecule.yml
driver: { name: podman }
platforms:
  - name: ubuntu
    image: docker.io/geerlingguy/docker-ubuntu2404-ansible
    pre_build_image: true
  - name: rocky
    image: docker.io/geerlingguy/docker-rockylinux9-ansible
    pre_build_image: true
provisioner: { name: ansible }
verifier: { name: ansible }
```
```yaml
# verify.yml
- hosts: all
  tasks:
    - name: Nginx is listening on 80
      ansible.builtin.wait_for: { port: 80, timeout: 10 }
    - name: Config is valid
      ansible.builtin.command: nginx -t
      changed_when: false
```

**`molecule test`** выполняет полный цикл: lint → создание экземпляров → **converge** (применение роли) → **idempotence** (повторный запуск, ожидается `changed=0` — если что-то изменилось, тест падает) → **verify** → удаление экземпляров. Для разработки удобны отдельные шаги: `molecule converge`, `molecule login`, `molecule verify`.

**Особенности:** контейнеры — не полноценные ВМ (systemd, ядро, сеть отличаются), поэтому используют специальные образы с systemd или драйверы ВМ для ролей, работающих с ядром и сетью. Проверки можно писать на **Testinfra** (Python) вместо verify.yml.

**В CI:** запускать Molecule на каждый MR в репозиторий ролей, матрица по поддерживаемым ОС; роли публиковать с версиями (теги, коллекции) и закреплять версии в проектах.
