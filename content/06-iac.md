---
id: iac
title: Terraform и IaC
icon: 🏗️
order: 6
summary: State, модули, окружения, дрейф, тестирование и рефакторинг инфраструктуры
---

# Ключевые концепции

**Infrastructure as Code** — описание инфраструктуры в виде кода: версионирование, ревью, повторяемость, автоматизация, документация «бесплатно».

### Подходы
- **Декларативный** (Terraform/OpenTofu, CloudFormation, Pulumi в декларативном стиле, Kubernetes) — описываем желаемое состояние, инструмент вычисляет разницу.
- **Императивный** (скрипты, частично Ansible) — описываем шаги.
- **Mutable vs Immutable** инфраструктура: менять серверы на месте или заменять их новыми из образа (Packer + ASG).

### Жизненный цикл Terraform
```
terraform init      # провайдеры, модули, backend
terraform fmt / validate
terraform plan -out=tfplan   # граф зависимостей, diff state ↔ реальность ↔ код
terraform apply tfplan
```

### Ключевые темы senior-собеседования
- State: зачем нужен, remote backend, блокировки, разделение state.
- Модули и структура репозитория, окружения.
- Дрейф, импорт, рефакторинг (`moved`, `import` блоки, `removed`).
- Секреты, тестирование, CI для Terraform (Atlantis, Spacelift, TFC).
- OpenTofu — открытый форк Terraform после смены лицензии HashiCorp на BSL (2023).

## Q: Зачем Terraform нужен state? Как организовать работу с ним в команде?
level: middle
type: theory
freq: 3
tags: state

**State** — сопоставление ресурсов из кода с реальными объектами (ID в облаке) плюс атрибуты и зависимости. Без него Terraform не знает, какой реальный ресурс соответствует `aws_instance.web`, и не может вычислить изменения или удалить ресурс, исчезнувший из кода. Также state ускоряет plan (кеш атрибутов).

Работа в команде:
- **Remote backend**: S3 (+ блокировка через DynamoDB или нативную `use_lockfile` в новых версиях), GCS, Azure Blob, Terraform Cloud, GitLab-managed state.
- **Блокировка** (locking) — предотвращает одновременный apply и повреждение state.
- **Шифрование** и ограниченный доступ: state содержит **секреты в открытом виде** (пароли БД, ключи).
- **Версионирование** бакета — возможность откатиться к предыдущей версии state.
- **Разделение state** по окружениям и компонентам (сеть, кластер, приложения) — меньше радиус поражения, быстрее plan, независимые команды. Связь между ними — через `terraform_remote_state` или, лучше, data sources / SSM-параметры.
- Изменения — только через CI (plan в MR, apply после approve), а не с ноутбуков.

## Q: Что такое дрейф конфигурации и как с ним бороться?
level: senior
type: scenario
freq: 3
tags: drift

**Дрейф** — расхождение реальной инфраструктуры с кодом/state: кто-то поменял security group в консоли, автоскейлер изменил размер, хотфикс во время инцидента.

Обнаружение:
- регулярный `terraform plan -detailed-exitcode` по расписанию в CI (код 2 = есть изменения) с алертом;
- `terraform plan -refresh-only` — увидеть, что изменилось снаружи;
- встроенный drift detection в Terraform Cloud/Spacelift/env0; AWS Config.

Исправление:
- если ручное изменение ошибочно — `apply`, чтобы вернуть состояние из кода;
- если правильное — перенести в код;
- если атрибут легитимно управляется извне (desired_count, теги от другой системы) — `lifecycle { ignore_changes = [...] }`.

Профилактика: запрет ручных изменений через IAM (read-only доступ в консоль для людей), break-glass процедура для инцидентов с обязательной синхронизацией кода после, GitOps-подход.

## Q: Как структурировать Terraform-код для нескольких окружений?
level: senior
type: design
freq: 3
tags: структура, модули

Варианты:

1. **Каталоги на окружение** + общие модули:
```
modules/
  vpc/  eks/  rds/
live/
  dev/   network/ eks/ apps/
  stage/ network/ eks/ apps/
  prod/  network/ eks/ apps/
```
Каждый каталог — свой state и backend. Явно, безопасно, разные версии модулей на окружение (прод может отставать). Минус — дублирование, которое снимает **Terragrunt** (DRY backend/providers, зависимости между стеками) или Terraform **Stacks**.

2. **Workspaces** — один код, несколько state. Подходит для одинаковых окружений, но легко применить к не тому workspace, сложно иметь различия и разные доступы. HashiCorp не рекомендует CLI workspaces для изоляции окружений с разными правами.

3. **Отдельные репозитории/аккаунты** — для сильной изоляции (отдельные AWS-аккаунты на окружение — лучшая практика).

Принципы для модулей:
- модуль решает одну задачу и имеет понятный интерфейс (variables с `validation`, outputs);
- версионирование модулей (git tag, приватный registry) и закрепление версий;
- не делать «модуль-обёртку» над одним ресурсом без добавленной ценности;
- композиция модулей на уровне корневых стеков;
- закрепление версий провайдеров (`required_providers`, `.terraform.lock.hcl` в репозитории).

## Q: Чем count отличается от for_each? Какие проблемы с count?
level: middle
type: practice
freq: 2
tags: hcl

- **count** — создаёт N экземпляров с адресами по индексу: `aws_instance.web[0]`, `[1]`, `[2]`.
- **for_each** — по map или set строк, адреса по ключу: `aws_instance.web["api"]`.

Проблема count: если удалить элемент из середины списка, индексы сдвигаются → Terraform **пересоздаст** все последующие ресурсы. С for_each удаляется только нужный ключ.

```hcl
variable "users" { default = ["alice", "bob", "carol"] }

resource "aws_iam_user" "u" {
  for_each = toset(var.users)
  name     = each.key
}
```

Когда count всё же уместен: условное создание `count = var.enabled ? 1 : 0` или N одинаковых безымянных экземпляров. Ограничение: ключи for_each должны быть известны на этапе plan (нельзя использовать значения, вычисляемые после apply).

## Q: Как безопасно рефакторить Terraform: переименовать ресурс, вынести в модуль, импортировать существующий?
level: senior
type: practice
freq: 2
tags: рефакторинг, state

Цель — чтобы plan показывал **0 изменений** реальных ресурсов.

- **Переименование/перенос в модуль** — блок `moved` (Terraform ≥1.1), декларативно и проходит ревью:
```hcl
moved {
  from = aws_s3_bucket.logs
  to   = module.logging.aws_s3_bucket.this
}
```
Старый способ — `terraform state mv` (императивно, вне ревью, легко ошибиться).
- **Импорт существующего ресурса** — блок `import` (≥1.5) с возможностью генерации кода: `terraform plan -generate-config-out=generated.tf`. Раньше — `terraform import` CLI.
- **Перестать управлять, не удаляя** — блок `removed` с `lifecycle { destroy = false }` (≥1.7) или `terraform state rm`.
- **Разделение state** на несколько — `moved` не работает между state; нужен `state rm` + `import` или `terraform state mv -state-out`.

Процесс: бэкап state, изменения маленькими шагами, внимательный разбор plan (особенно строки `must be replaced` и `forces replacement`), защита критичных ресурсов через `lifecycle { prevent_destroy = true }`.

## Q: Как работать с секретами в Terraform?
level: senior
type: practice
freq: 3
tags: секреты, безопасность

Проблема: значения попадают в **state** и могут попасть в **plan/логи CI**.

Подходы:
- Не передавать секреты как переменные из репозитория. Брать из секрет-хранилища через data source: `aws_secretsmanager_secret_version`, `vault_generic_secret` (но значение всё равно окажется в state).
- Лучше — **генерировать секрет вне Terraform** или чтобы его генерировал сам сервис: RDS `manage_master_user_password = true` (пароль хранит и ротирует Secrets Manager, Terraform его не видит).
- **Ephemeral resources** и write-only аргументы (Terraform 1.10+/1.11+) — значения не сохраняются в state и plan.
- `sensitive = true` для переменных и outputs — скрывает из вывода, но **не из state**.
- Защита state: шифрованный бакет, строгий IAM, версионирование, доступ только у CI.
- Секреты в CI — через OIDC и Vault, а не статические ключи в переменных.
- SOPS для шифрованных файлов в репозитории (провайдер `carlpett/sops`).

## Q: Как тестировать и проверять Terraform-код?
level: senior
type: practice
freq: 2
tags: тестирование

Пирамида проверок:
1. **Статика** (на каждый коммит, секунды): `terraform fmt -check`, `validate`, **tflint** (ошибки провайдера, неиспользуемые переменные), **Checkov / Trivy (tfsec) / KICS** — безопасность (открытые SG, незашифрованные бакеты).
2. **Policy as Code**: OPA/Conftest или Sentinel по JSON-плану (`terraform show -json tfplan`) — запрет определённых типов инстансов, обязательные теги, лимиты стоимости.
3. **Plan-ревью** в MR: Atlantis / Terraform Cloud публикуют plan в комментарии; **Infracost** — изменение стоимости.
4. **Unit/контракт-тесты модулей**: встроенный `terraform test` (≥1.6) с моками провайдеров, `validation` и `precondition/postcondition` в коде.
5. **Интеграционные тесты**: Terratest (Go) или `terraform test` с реальным apply в песочнице и последующим destroy — дорого, запускать для модулей, а не для каждого изменения.
6. После apply — smoke-проверки и мониторинг дрейфа.

## Q: Terraform vs Ansible vs Pulumi vs Crossplane — когда что?
level: senior
type: theory
freq: 2
tags: инструменты

- **Terraform/OpenTofu** — провижининг инфраструктуры (облака, сети, DNS, SaaS), декларативный, state, огромная экосистема провайдеров.
- **Ansible** — конфигурирование ОС и приложений на серверах, оркестрация процедур (rolling-обновления, раскатка конфигов), без агента, без state. Может создавать облачные ресурсы, но слабее в управлении жизненным циклом и удалении.
- **Pulumi / CDKTF / AWS CDK** — IaC на языках общего назначения (TypeScript, Python, Go): циклы, абстракции, тесты, IDE. Риск — чрезмерная сложность и «программистская» инфраструктура, которую трудно ревьюить.
- **Crossplane** — инфраструктура как ресурсы Kubernetes, постоянное согласование (reconcile) вместо однократного apply, композиции для self-service платформ. Требует кластер управления и зрелости.
- **CloudFormation/Bicep** — нативные инструменты облака, без state-файла, но привязка к вендору.

Типичная связка: Terraform создаёт VPC, кластер и managed-сервисы → Ansible/cloud-init/Packer настраивают образы ВМ → ArgoCD деплоит приложения в кластер.

## Q: terraform apply упал посередине / state заблокирован. Что делать?
level: senior
type: scenario
freq: 2
tags: траблшутинг, state

**Apply упал посередине**: Terraform не транзакционен — часть ресурсов создана. State при этом обновляется по мере создания ресурсов, поэтому обычно достаточно:
1. разобраться с причиной (лимиты квот, права IAM, конфликт имён, таймаут API);
2. выполнить `plan` снова — он покажет, что осталось сделать;
3. если ресурс создан в облаке, но не попал в state (сбой записи) — `import`, иначе получите ошибку «already exists»;
4. ресурсы в состоянии **tainted** будут пересозданы.

**State заблокирован** (`Error acquiring the state lock`):
1. убедиться, что **никто не выполняет** apply сейчас (CI-джобы, коллеги) — блокировка часто легитимна;
2. если процесс умер (убили джобу), снять блокировку: `terraform force-unlock <LOCK_ID>`;
3. в будущем — `resource_group`/очереди в CI, чтобы apply не запускались параллельно.

**Повреждённый state**: восстановить предыдущую версию из версионированного бакета, `terraform state pull/push` с осторожностью, затем `plan -refresh-only` для сверки.

## Q: Из каких основных блоков состоит Terraform-конфигурация?
level: middle
type: theory
freq: 3
tags: hcl, основы

```hcl
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  backend "s3" {                         # где хранится state
    bucket       = "tf-state-prod"
    key          = "network/terraform.tfstate"
    region       = "eu-central-1"
    use_lockfile = true
  }
}

provider "aws" {                         # плагин для работы с API
  region = var.region
}

variable "region" {                      # входной параметр
  type    = string
  default = "eu-central-1"
}

locals {                                 # вычисляемые значения внутри модуля
  common_tags = { project = "shop", env = var.env }
}

data "aws_ami" "ubuntu" {                # ЧТЕНИЕ существующих объектов (не создаёт)
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
}

resource "aws_instance" "web" {          # СОЗДАНИЕ и управление объектом
  ami           = data.aws_ami.ubuntu.id # ссылка создаёт неявную зависимость
  instance_type = "t3.small"
  tags          = local.common_tags
}

module "vpc" {                           # переиспользуемый набор ресурсов
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"
  cidr    = "10.0.0.0/16"
}

output "web_ip" {                        # выходное значение
  value = aws_instance.web.public_ip
}
```

**Что спрашивают дальше:**
- **resource vs data source**: resource создаёт и управляет объектом, data source только читает существующий.
- **Зависимости**: неявные — через ссылки на атрибуты; явные — `depends_on`. По ним Terraform строит граф и создаёт независимые ресурсы параллельно.
- **Meta-аргументы**: `count`, `for_each`, `depends_on`, `provider`, `lifecycle` (`create_before_destroy`, `prevent_destroy`, `ignore_changes`).
- **Команды**: `init` → `fmt` → `validate` → `plan` → `apply`; `destroy`, `output`, `state list`, `console` (поэкспериментировать с выражениями).
- **`.terraform.lock.hcl`** фиксирует точные версии провайдеров, его коммитят в репозиторий.

## Q: Как передать значения переменных в Terraform? Какой у них приоритет?
level: middle
type: practice
freq: 2
tags: variables

**Способы** (от низшего приоритета к высшему, последнее значение побеждает):
1. `default` в блоке `variable`;
2. переменные окружения `TF_VAR_имя` (`export TF_VAR_region=eu-west-1`);
3. файл `terraform.tfvars` (подхватывается автоматически);
4. `terraform.tfvars.json`;
5. файлы `*.auto.tfvars` / `*.auto.tfvars.json` (в алфавитном порядке);
6. `-var-file=prod.tfvars` и `-var 'region=eu-west-1'` в командной строке (в порядке указания).

Если значение не задано нигде и нет default, Terraform спросит его интерактивно (в CI это ошибка, поэтому используют `-input=false`).

**Описание переменной:**
```hcl
variable "instance_count" {
  type        = number
  default     = 2
  description = "Количество инстансов"
  validation {
    condition     = var.instance_count > 0 && var.instance_count <= 10
    error_message = "От 1 до 10."
  }
}

variable "db_password" {
  type      = string
  sensitive = true          # скрыть из вывода plan/apply (в state всё равно попадёт!)
}

variable "subnets" {
  type = map(object({
    cidr = string
    az   = string
  }))
}
```
Типы: `string`, `number`, `bool`, `list(...)`, `set(...)`, `map(...)`, `object({...})`, `tuple([...])`, `any`.

**Разница между variable, locals и output:**
- `variable` — вход модуля (параметр, задаётся снаружи);
- `locals` — внутренние вычисления, чтобы не повторять выражения;
- `output` — выход модуля: значения для пользователя, для других модулей (`module.vpc.vpc_id`) или других state.

**Практика:** отдельный `.tfvars` на окружение (`dev.tfvars`, `prod.tfvars`), секреты не в tfvars в Git, а через `TF_VAR_` из секрет-хранилища CI или data source из Vault/Secrets Manager.
