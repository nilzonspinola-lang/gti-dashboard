# GTI Dashboard — Painel Executivo Financeiro

Dashboard financeiro estático da Green Tech Innovation, atualizado automaticamente
todos os dias via GitHub Actions + monitorado por um Agente Robô no Cloudflare Workers.

🌐 **Acesso:** [dashboard.gti-g.com](https://dashboard.gti-g.com)

---

## Arquitetura do Sistema

```
┌─────────────────────────────────────────────────────────────────┐
│                         FLUXO AUTOMÁTICO                        │
│                                                                 │
│  07:00–10:00 BRT  ──►  GitHub Actions (daily-update.yml)        │
│     4 tentativas        └─► Busca dados no Controlle API        │
│     + retry 3×              └─► Atualiza index.html + data.json │
│                                 └─► Commit + Push → main        │
│                                                                 │
│  11:00 + 13:00 BRT ──► Watchdog (watchdog.yml)                  │
│  GitHub Actions         └─► Verifica se foi atualizado hoje     │
│                             └─► Se NÃO → dispara emergencial    │
│                                 └─► Envia e-mail de alerta      │
│                                                                 │
│  10:00–16:00 UTC  ──►  Cloudflare Worker (gti-dashboard-robo)   │
│  (a cada hora)          └─► Fiscaliza data.json no GitHub raw   │
│                             └─► Se desatualizado → dispara API  │
│                                 └─► Envia alerta via Resend     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Estrutura de Arquivos

```
gti-dashboard/
├── index.html                      ← Dashboard estático (frontend)
├── data.json                       ← Dados financeiros (atualizado pelo bot)
├── CNAME                           ← Domínio personalizado Cloudflare Pages
├── wrangler.jsonc                  ← Config Cloudflare Pages (site estático)
│
├── cloudflare-worker/              ← Agente Robô autônomo
│   ├── worker.js                   ← Lógica do Worker (fiscaliza + age)
│   ├── wrangler.toml               ← Config do Worker (crons, env vars)
│   └── .dev.vars.example           ← Template de variáveis para dev local
│
├── scripts/                        ← Automação de coleta de dados
│   └── update-dashboard.js         ← Scraper/API Controlle → data.json
│
└── .github/workflows/
    ├── daily-update.yml            ← Atualização diária principal (07–10h BRT)
    ├── watchdog.yml                ← Watchdog GitHub Actions (11h + 13h BRT)
    ├── deploy-worker.yml           ← CI/CD deploy do Cloudflare Worker
    └── atualiza-dashboard.yml      ← Legado (manual apenas)
```

---

## Secrets Necessários

### GitHub Secrets
Configure em: **Settings → Secrets and variables → Actions → New repository secret**

| Secret | Descrição | Exemplo |
|---|---|---|
| `CONTROLLE_EMAIL` | E-mail de login na plataforma Controlle | `user@gti-g.com` |
| `CONTROLLE_PASSWORD` | Senha de login na plataforma Controlle | `SenhaSegura123` |
| `WATCHDOG_TOKEN` | PAT GitHub com permissões `repo` + `workflow` | `ghp_abc...` |
| `ALERT_EMAIL_USER` | Gmail usado para enviar alertas | `robo@gti-g.com` |
| `ALERT_EMAIL_PASS` | Senha de app do Gmail (não a senha normal) | `abcd efgh ijkl mnop` |
| `ALERT_EMAIL_TO` | E-mail que recebe os alertas críticos | `nilzon@gti-g.com` |
| `CLOUDFLARE_API_TOKEN` | Token API Cloudflare para deploy do Worker | `abc123...` |
| `CLOUDFLARE_ACCOUNT_ID` | ID da conta Cloudflare | `a1b2c3...` |

> **Como criar senha de app Gmail:**
> Conta Google → Segurança → Verificação em 2 etapas → Senhas de app

> **Como criar CLOUDFLARE_API_TOKEN:**
> Cloudflare Dashboard → My Profile → API Tokens → Create Token
> → Template "Edit Cloudflare Workers" → confirmar Account e Zone

---

## Cloudflare Worker — Setup Completo

### 1. Pré-requisitos
```bash
npm install -g wrangler
wrangler login        # abre browser para autenticar
```

### 2. Deploy inicial do Worker
```bash
cd cloudflare-worker
wrangler deploy
```

### 3. Configurar Secrets no Worker
Execute **um a um** (o CLI vai pedir o valor):
```bash
wrangler secret put GITHUB_TOKEN
# Cole o PAT com permissões repo + workflow:write

wrangler secret put RESEND_API_KEY
# Cole a chave da API Resend (https://resend.com/api-keys)

wrangler secret put ALERT_EMAIL_TO
# Cole o e-mail destino dos alertas críticos
```

### 4. Verificar o Worker online
```bash
# Status sem agir:
curl https://gti-dashboard-robo.nilzonspinola-lang.workers.dev/status

# Forçar execução do agente:
curl -X POST https://gti-dashboard-robo.nilzonspinola-lang.workers.dev/force
```

### 5. Desenvolvimento local
```bash
cd cloudflare-worker
cp .dev.vars.example .dev.vars
# Edite .dev.vars com os valores reais
wrangler dev
```

---

## Endpoints do Worker

| Método | Path | Descrição |
|---|---|---|
| `GET` | `/` | Página HTML com status do dashboard |
| `GET` | `/status` | JSON com status atual (sem agir) |
| `POST` | `/force` | Força execução completa do agente |

---

## Configuração dos Cron Triggers

O Worker roda automaticamente entre **10:00–16:00 UTC** (07:00–13:00 Brasília):

| UTC | Brasília | Ação |
|---|---|---|
| 10:00 | 07:00 | Verifica dashboard; age se desatualizado |
| 11:00 | 08:00 | Re-verifica e age se necessário |
| 12:00 | 09:00 | Re-verifica e age se necessário |
| 13:00 | 10:00 | Re-verifica e age se necessário |
| 14:00 | 11:00 | Re-verifica e age se necessário |
| 15:00 | 12:00 | Re-verifica e age se necessário |
| 16:00 | 13:00 | Última verificação do dia |

---

## Deploy Automático do Worker (CI/CD)

O workflow `.github/workflows/deploy-worker.yml` faz deploy automático do Worker
toda vez que um arquivo em `cloudflare-worker/` é modificado no branch `main`.

**Secrets necessários para o CI/CD:**
- `CLOUDFLARE_API_TOKEN` — token com permissão "Edit Cloudflare Workers"
- `CLOUDFLARE_ACCOUNT_ID` — ID da sua conta Cloudflare

---

## Monitoramento

| Sistema | Frequência | O que faz |
|---|---|---|
| GitHub Actions `daily-update.yml` | 07h–10h BRT (4×) | Atualiza dados do Controlle |
| GitHub Actions `watchdog.yml` | 11h + 13h BRT | Fiscaliza; dispara emergencial |
| Cloudflare Worker | 07h–13h BRT (7×/hora) | Fiscaliza; dispara via API GitHub |

---

## Tecnologias

- **Frontend:** HTML5 estático + CSS custom (sem frameworks)
- **Hospedagem:** Cloudflare Pages (custom domain `dashboard.gti-g.com`)
- **Automação:** GitHub Actions + Node.js 22
- **Worker:** Cloudflare Workers (JavaScript ES2022)
- **E-mail:** Resend API (Worker) + Gmail SMTP (Watchdog)
- **Dados:** API REST Controlle (plataforma financeira)
