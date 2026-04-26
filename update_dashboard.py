#!/usr/bin/env python3
"""
GTI Dashboard — Atualização automática via API Controlle
Roda via GitHub Actions todo dia às 07:00 BRT
"""
import os, re, json, base64, requests
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

BRT = ZoneInfo("America/Bahia")
now = datetime.now(BRT)
hoje = now.strftime("%d/%m/%Y")
hora = "07:52"
dt_str = f"{hoje} às {hora}"

CONTROLLE_TOKEN = os.environ["CONTROLLE_TOKEN"]
GITHUB_TOKEN    = os.environ.get("GITHUB_TOKEN", "")
REPO            = "nilzonspinola-lang/gti-dashboard"

headers_ctrl = {"Authorization": f"Bearer {CONTROLLE_TOKEN}", "Content-Type": "application/json"}
headers_gh   = {"Authorization": f"token {GITHUB_TOKEN}", "Accept": "application/vnd.github.v3+json"}

# ── 1. Contas bancárias ──────────────────────────────────────
print("Buscando contas bancárias...")
r = requests.get("https://api-v1.controlle.com/account/v1/accounts/",
                 params={"status": 1}, headers=headers_ctrl, timeout=20)
r.raise_for_status()
accounts_raw = r.json()

# Normaliza resposta (pode ser lista ou {data: [...]})
accounts = accounts_raw if isinstance(accounts_raw, list) else accounts_raw.get("data", accounts_raw.get("accounts", []))

contas = []
saldo_total = 0.0
for acc in accounts:
    nome  = acc.get("ds_account") or acc.get("name", "Conta")
    saldo = float(acc.get("vl_balance") or acc.get("balance") or acc.get("saldo") or 0)
    contas.append({"nome": nome, "saldo": round(saldo, 2)})
    saldo_total += saldo

saldo_total = round(saldo_total, 2)
print(f"Saldo total: R$ {saldo_total:,.2f} | {len(contas)} contas")

# ── 2. Receitas do mês atual ─────────────────────────────────
print("Buscando lançamentos do mês...")
start_date = now.replace(day=1).strftime("%Y-%m-%d")
end_date   = now.strftime("%Y-%m-%d")

r2 = requests.get("https://api-v1.controlle.com/transaction/v1/transactions/",
                  params={"start_date": start_date, "end_date": end_date,
                          "activity_type": "1", "situation": "[1]"},
                  headers=headers_ctrl, timeout=20)
r2.raise_for_status()
tx_raw = r2.json()
transactions = tx_raw if isinstance(tx_raw, list) else tx_raw.get("data", tx_raw.get("transactions", []))

receita_mes = round(sum(float(t.get("vl_transaction") or t.get("value") or 0) for t in transactions), 2)
print(f"Receita {start_date[:7]}: R$ {receita_mes:,.2f}")

# ── 3. Atualiza data.json ────────────────────────────────────
print("Atualizando data.json...")
data_json = {
    "data_coleta": dt_str,
    "saldo_geral": saldo_total,
    "saldo_previsto": saldo_total,
    "receita_mes": receita_mes,
    "contas": contas
}

r3 = requests.get(f"https://api.github.com/repos/{REPO}/contents/data.json", headers=headers_gh)
sha_data = r3.json().get("sha", "")
content_b64 = base64.b64encode(json.dumps(data_json, ensure_ascii=False, indent=2).encode()).decode()
requests.put(f"https://api.github.com/repos/{REPO}/contents/data.json",
             headers=headers_gh, json={"message": f"data: coleta {hoje}", "content": content_b64, "sha": sha_data, "branch": "main"})

# ── 4. Atualiza index.html ───────────────────────────────────
print("Atualizando index.html...")
r4 = requests.get(f"https://api.github.com/repos/{REPO}/contents/index.html", headers=headers_gh)
r4.raise_for_status()
file_data  = r4.json()
sha_html   = file_data["sha"]
html_bytes = base64.b64decode(file_data["content"].replace("\n",""))
html       = html_bytes.decode("utf-8")

# Atualiza timestamp
html = re.sub(r"Atualizado \d{2}/\d{2}/\d{4} às \d{2}:\d{2}", f"Atualizado {dt_str}", html)

# Atualiza datas do fluxo diário (últimos 7 dias)
days_labels = [(now - timedelta(days=6-i)).strftime("%d/%b").lower() for i in range(7)]
# ex: ['19/abr', '20/abr', ..., '25/abr'] em pt
MESES = {"jan":"jan","feb":"fev","mar":"mar","apr":"abr","may":"mai","jun":"jun",
         "jul":"jul","aug":"ago","sep":"set","oct":"out","nov":"nov","dec":"dez"}
days_labels = [re.sub(r"[a-z]{3}$", lambda m: MESES.get(m.group(), m.group()), d) for d in days_labels]

old_labels_pat = r"(labels:\[)('[\d/a-z]+'(?:,'[\d/a-z]+')*)(])"
def replace_labels(m):
    return m.group(1) + ",".join(f"'{d}'" for d in days_labels) + m.group(3)

# Substitui labels nos charts de fluxo diário
for chart_id in ["chartContasFluxo", "chartFluxoDiario"]:
    # Find the chart block and replace its labels
    idx = html.find(f"'{chart_id}'")
    if idx > 0:
        block_start = html.rfind("new Chart", 0, idx)
        block_end   = html.find(");", idx) + 2
        block       = html[block_start:block_end]
        new_block   = re.sub(r"labels:\[([^\]]+)\]", 
                             "labels:[" + ",".join(f"'{d}'" for d in days_labels) + "]", block)
        html        = html[:block_start] + new_block + html[block_end:]

# Atualiza saldo nos charts de fluxo (substitui dados com valor atual)
html = re.sub(r"(chartContasFluxo|chartFluxoDiario)[\s\S]{1,800}?data:\[([\d.,]+(?:,[\d.,]+)*)\]",
              lambda m: m.group(0).replace(
                  "data:[" + m.group(2) + "]",
                  "data:[" + ",".join([str(saldo_total)]*7) + "]"
              ), html, count=2)

new_content = base64.b64encode(html.encode("utf-8")).decode()
resp = requests.put(f"https://api.github.com/repos/{REPO}/contents/index.html",
                    headers=headers_gh,
                    json={"message": f"chore: dados {hoje} {hora}", "content": new_content, "sha": sha_html, "branch": "main"})
resp.raise_for_status()
print(f"✅ Dashboard atualizado: {dt_str} | saldo R$ {saldo_total:,.2f} | receita R$ {receita_mes:,.2f}")
