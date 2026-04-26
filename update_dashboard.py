#!/usr/bin/env python3
"""
GTI Dashboard - Atualização Automática
Executa via GitHub Actions: busca dados da API Controlle,
atualiza data.json e index.html no repositório.

Variáveis de ambiente necessárias:
  CONTROLLE_TOKEN  - Token Bearer da API Controlle
  GITHUB_TOKEN     - Token do GitHub (provido automaticamente pelo Actions)
  GITHUB_REPOSITORY - owner/repo (provido automaticamente, ex: nilzonspinola-lang/gti-dashboard)
"""

import os
import json
import re
import base64
import requests
from datetime import datetime, timezone, timedelta

# ── Configuração ──────────────────────────────────────────────────────────────
CONTROLLE_BASE  = "https://api-v1.controlle.com"
CONTROLLE_TOKEN = os.environ["CONTROLLE_TOKEN"]
GITHUB_TOKEN    = os.environ["GITHUB_TOKEN"]
GITHUB_REPO     = os.environ.get("GITHUB_REPOSITORY", "nilzonspinola-lang/gti-dashboard")
GITHUB_API      = f"https://api.github.com/repos/{GITHUB_REPO}/contents"

CONTROLLE_HEADERS = {
    "Authorization": f"Bearer {CONTROLLE_TOKEN}",
    "Content-Type": "application/json",
    "Accept": "application/json",
}
GITHUB_HEADERS = {
    "Authorization": f"token {GITHUB_TOKEN}",
    "Accept": "application/vnd.github.v3+json",
}

BRT = timezone(timedelta(hours=-3))


# ── Helpers ───────────────────────────────────────────────────────────────────
def gh_get(path):
    """Busca um arquivo do repositório GitHub, retorna (content_str, sha)."""
    url = f"{GITHUB_API}/{path}"
    r = requests.get(url, headers=GITHUB_HEADERS, timeout=30)
    r.raise_for_status()
    data = r.json()
    content = base64.b64decode(data["content"]).decode("utf-8")
    return content, data["sha"]


def gh_put(path, content_str, sha, message):
    """Atualiza um arquivo no repositório GitHub."""
    url = f"{GITHUB_API}/{path}"
    encoded = base64.b64encode(content_str.encode("utf-8")).decode("ascii")
    payload = {
        "message": message,
        "content": encoded,
        "sha": sha,
    }
    r = requests.put(url, headers=GITHUB_HEADERS, json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def normalize_list(data):
    """Normaliza resposta da API Controlle: aceita lista direta ou {data:[...]}."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("data", "results", "items", "accounts", "transactions"):
            if key in data and isinstance(data[key], list):
                return data[key]
    return []


# ── Etapa 1: Buscar saldos das contas ─────────────────────────────────────────
def fetch_accounts():
    print("→ Buscando contas bancárias...")
    url = f"{CONTROLLE_BASE}/account/v1/accounts/?status=1"
    r = requests.get(url, headers=CONTROLLE_HEADERS, timeout=30)
    r.raise_for_status()
    accounts = normalize_list(r.json())

    contas = []
    saldo_geral = 0.0
    for acc in accounts:
        # Campos possíveis: name/nome, balance/saldo/current_balance
        nome = acc.get("name") or acc.get("nome") or acc.get("description") or "Conta"
        saldo = float(
            acc.get("balance") or acc.get("saldo") or
            acc.get("current_balance") or acc.get("currentBalance") or 0
        )
        contas.append({"nome": nome, "saldo": round(saldo, 2)})
        saldo_geral += saldo

    print(f"  Contas encontradas: {len(contas)} | Saldo geral: R${saldo_geral:,.2f}")
    return contas, round(saldo_geral, 2)


# ── Etapa 2: Buscar receitas do mês atual ────────────────────────────────────
def fetch_receitas():
    print("→ Buscando receitas do mês...")
    now = datetime.now(BRT)
    start = now.replace(day=1).strftime("%Y-%m-%d")
    end   = now.strftime("%Y-%m-%d")

    # activity_type=1 = receita; situation=[1] = recebido/confirmado
    url = (
        f"{CONTROLLE_BASE}/transaction/v1/transactions/"
        f"?start_date={start}&end_date={end}&activity_type=1&situation=1"
    )
    r = requests.get(url, headers=CONTROLLE_HEADERS, timeout=30)
    r.raise_for_status()
    transactions = normalize_list(r.json())

    total_receita = 0.0
    for t in transactions:
        valor = float(
            t.get("amount") or t.get("value") or
            t.get("valor") or t.get("total") or 0
        )
        total_receita += abs(valor)

    print(f"  Transações: {len(transactions)} | Receita total: R${total_receita:,.2f}")
    return round(total_receita, 2), len(transactions)


# ── Etapa 3: Atualizar data.json ──────────────────────────────────────────────
def update_data_json(contas, saldo_geral):
    print("→ Atualizando data.json...")
    _, sha = gh_get("data.json")
    now_str = datetime.now(BRT).strftime("%d/%m/%Y %H:%M")
    payload = {
        "data_coleta": now_str,
        "saldo_geral": saldo_geral,
        "saldo_previsto": saldo_geral,
        "contas": contas,
    }
    content = json.dumps(payload, ensure_ascii=False, indent=2)
    gh_put("data.json", content, sha, f"chore: atualiza data.json {now_str}")
    print(f"  data.json atualizado — {now_str}")
    return now_str


# ── Etapa 4: Atualizar index.html ─────────────────────────────────────────────
def update_index_html(contas, saldo_geral, now_str):
    print("→ Atualizando index.html...")
    html, sha = gh_get("index.html")

    # 4a. Timestamp "Atualizado DD/MM/YYYY às HH:MM"
    html = re.sub(
        r'Atualizado\s+\d{2}/\d{2}/\d{4}\s+às\s+\d{2}:\d{2}',
        f'Atualizado {now_str}',
        html
    )

    # 4b. Saldo geral no card — procura padrões como R$48.051,34 próximo a "saldo" ou "caixa"
    saldo_fmt = f"R${saldo_geral:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    # Substitui o valor no card de Saldo Geral / Posição de Caixa
    html = re.sub(
        r'(id=["\'](?:saldoGeral|saldo-geral|posicaoCaixa)["\'][^>]*>)[^<]*',
        rf'\g<1>{saldo_fmt}',
        html
    )

    # 4c. Cards individuais de conta (ex: Itaú, Santander)
    for conta in contas:
        nome = re.escape(conta["nome"])
        valor_fmt = f"R${conta['saldo']:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
        # Procura pelo nome da conta seguido de um valor monetário em até 200 chars
        html = re.sub(
            rf'({nome}.*?R\$)\s*[\d.,]+',
            rf'\g<1> {conta["saldo"]:,.2f}'.replace(",", "X").replace(".", ",").replace("X", "."),
            html,
            count=1,
            flags=re.DOTALL
        )

    gh_put("index.html", html, sha, f"chore: atualiza dashboard {now_str}")
    print(f"  index.html atualizado — {now_str}")


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("=" * 60)
    print(f"GTI Dashboard — Atualização Automática")
    print(f"Horário BRT: {datetime.now(BRT).strftime('%d/%m/%Y %H:%M')}")
    print("=" * 60)

    try:
        contas, saldo_geral = fetch_accounts()
    except Exception as e:
        print(f"⚠ Erro ao buscar contas: {e}")
        print("  Usando valores do data.json atual como fallback...")
        contas, saldo_geral = [], 0.0

    try:
        receita_total, num_nfs = fetch_receitas()
        print(f"  Receita do mês: R${receita_total:,.2f} ({num_nfs} NFs)")
    except Exception as e:
        print(f"⚠ Erro ao buscar receitas: {e} (não crítico, continuando...)")

    if contas:
        now_str = update_data_json(contas, saldo_geral)
        update_index_html(contas, saldo_geral, now_str)
    else:
        print("⚠ Nenhuma conta retornada pela API — abortando atualização.")

    print("=" * 60)
    print("✓ Dashboard atualizado com sucesso!")


if __name__ == "__main__":
    main()
