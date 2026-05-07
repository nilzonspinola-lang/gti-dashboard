/**
 * GTI Dashboard - Atualização diária via API REST do Controlle
 *
 * Fluxo confirmado (via análise do bundle JS do Controlle):
 * 1. POST /company/login  (Gateway) → {accessToken, refreshToken}
 * 2. GET  /auth/entities  (API)     → lista de entidades; usa .id da que tem current:true
 * 3. GET  /report/v1/dashboard/balances  (API + header id_entity) → saldo geral
 * 4. GET  /account/v1/accounts           (API + header id_entity) → contas por banco
 * 5. GET  /company/redirect/financial/report/dre (Gateway) → DRE anual
 * 6. Fallback DRE: managerDashboard/invoicing + profitability
 * 7. Atualiza index.html e data.json
 */

const https = require('https');
const fs    = require('fs').promises;
const path  = require('path');

// ── Configuração ──────────────────────────────────────────────────────────────
const CONTROLLE_API = 'https://controlle-api-prod.controlle.com';
const CONTROLLE_GW  = 'https://controlle-gateway-prod.controlle.com';

// ── Helpers de formatação BR ──────────────────────────────────────────────────
function parseBR(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/R\$\s*/, '').replace(/\./g, '').replace(',', '.').trim());
  return isNaN(n) ? null : n;
}

function fmtFull(v) {
  const sign = v < 0 ? '-' : '';
  const abs  = Math.abs(v).toFixed(2);
  const [ip, dec] = abs.split('.');
  return sign + 'R$ ' + ip.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + dec;
}

function fmtInt(v) {
  const sign = v < 0 ? '-' : '';
  return sign + 'R$ ' + Math.round(Math.abs(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function fmtMargem(res, rec) {
  if (!rec || rec === 0) return null;
  return (Math.abs(res) / rec * 100).toFixed(1).replace('.', ',') + '%';
}

function nowBrazil() {
  const a    = new Date();
  const dd   = String(a.getDate()).padStart(2, '0');
  const mm   = String(a.getMonth() + 1).padStart(2, '0');
  const aaaa = a.getFullYear();
  const hh   = String(a.getHours()).padStart(2, '0');
  const min  = String(a.getMinutes()).padStart(2, '0');
  return {
    storage: `${dd}/${mm}/${aaaa} as ${hh}:${min}`,
    display: `${dd}/${mm}/${aaaa} às ${hh}:${min}`,
    dd, mm, aaaa
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed;
        try   { parsed = JSON.parse(data); }
        catch { parsed = data; }
        if (res.statusCode >= 400) {
          const msg = (parsed && parsed.message)
            ? parsed.message
            : JSON.stringify(parsed).substring(0, 300);
          reject(new Error(`HTTP ${res.statusCode}: ${msg}`));
        } else {
          resolve(parsed);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function apiPost(baseUrl, endpoint, token, body) {
  const url     = new URL(baseUrl + '/' + endpoint.replace(/^\//, ''));
  const bodyStr = JSON.stringify(body);
  return httpRequest({
    hostname: url.hostname,
    path:     url.pathname,
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Accept':         'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  }, bodyStr);
}

/**
 * apiGet — passa idEntity como header id_entity (padrão do app Controlle)
 * e aceita params adicionais como query string.
 */
function apiGet(baseUrl, endpoint, token, idEntity, params = {}) {
  const url = new URL(baseUrl + '/' + endpoint.replace(/^\//, ''));
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return httpRequest({
    hostname: url.hostname,
    path:     url.pathname + url.search,
    method:   'GET',
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      Authorization:  `Bearer ${token}`,
      ...(idEntity ? { id_entity: String(idEntity) } : {})
    }
  });
}

// ── 1. Login + busca idEntity ─────────────────────────────────────────────────
async function loginControlle(email, password) {
  console.log('→ Autenticando no Controlle Gateway...');

  // 1a. POST /company/login → {accessToken, refreshToken}
  let loginResp;
  try {
    loginResp = await apiPost(CONTROLLE_GW, 'company/login', null, { email, password });
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('401') || msg.toLowerCase().includes('incorreto') || msg.toLowerCase().includes('invalid')) {
      throw new Error(
        'Credenciais inválidas — verifique CONTROLLE_EMAIL e CONTROLLE_PASSWORD nos Secrets do GitHub.\n' +
        `Detalhe: ${msg}`
      );
    }
    throw new Error(`Login Controlle falhou: ${msg}`);
  }

  const accessToken = loginResp?.accessToken || loginResp?.access_token ||
                      loginResp?.token       || loginResp?.idToken;
  if (!accessToken) {
    throw new Error('Login OK mas sem accessToken. Campos: ' + Object.keys(loginResp || {}).join(', '));
  }
  console.log('  ✓ accessToken obtido');

  // 1b. GET /auth/entities (CONTROLLE_API) → { id, name, current, ... }[]
  console.log('→ Buscando entidades...');
  let entitiesResp;
  try {
    entitiesResp = await apiGet(CONTROLLE_API, 'auth/entities', accessToken, null);
  } catch (err) {
    throw new Error(`Falha ao buscar entidades (auth/entities): ${err.message}`);
  }

  console.log('  auth/entities snippet:', JSON.stringify(entitiesResp).substring(0, 300));

  // Normaliza para array
  const lista = entitiesResp?.entities ?? entitiesResp?.data ?? entitiesResp;
  const arr   = Array.isArray(lista) ? lista : (lista ? [lista] : []);

  if (arr.length === 0) {
    throw new Error('Nenhuma entidade retornada. Campos: ' + Object.keys(entitiesResp || {}).join(', '));
  }

  // Prefere a marcada como current; senão pega a primeira
  const entidade = arr.find(e => e.current === true) || arr[0];
  const idEntity = entidade?.id || entidade?.idEntity || entidade?.entityId || entidade?.companyId;

  if (!idEntity) {
    throw new Error('Entidade sem campo id. Campos: ' + Object.keys(entidade || {}).join(', '));
  }

  console.log(`✓ Login OK — idEntity: ${idEntity} (${entidade?.name || entidade?.fantasyName || 'sem nome'})`);
  return { accessToken, idEntity };
}

// ── 2. Buscar saldos ──────────────────────────────────────────────────────────
async function buscarSaldos(token, idEntity) {
  console.log('→ Buscando saldos...');

  const bankMap = {
    'Itaú':      ['itau', 'itaú', 'unibanco'],
    'Santander': ['santander'],
    'BNB':       ['nordeste', 'bnb', 'banco do nordeste'],
    'Caixa':     ['caixa', 'cef'],
    'Sicoob':    ['sicoob', 'sicredi']
  };

  const saldos = {
    'Itaú': null, 'Santander': null, 'BNB': null,
    'Caixa': null, 'Sicoob': null, saldoGeral: null
  };

  function classificarBanco(nomeRaw, valor) {
    const nome = (nomeRaw || '').toLowerCase();
    for (const [banco, kws] of Object.entries(bankMap)) {
      if (kws.some(k => nome.includes(k))) {
        if (saldos[banco] === null) saldos[banco] = valor;
        return true;
      }
    }
    return false;
  }

  function extrairNumero(item, ...campos) {
    for (const c of campos) {
      if (typeof item[c] === 'number') return item[c];
    }
    for (const c of campos) {
      if (item[c] != null) {
        const n = parseBR(String(item[c]));
        if (n !== null) return n;
      }
    }
    return 0;
  }

  // ── A. Saldo geral: report/v1/dashboard/balances ──────────────────────────
  // Resposta confirmada: { status:200, results:{ balances:{ generalBalance:N, ... } } }
  try {
    const r = await apiGet(CONTROLLE_API, 'report/v1/dashboard/balances', token, idEntity);
    console.log('  [dashboard/balances]', JSON.stringify(r).substring(0, 400));

    const gb = r?.results?.balances?.generalBalance
            ?? r?.results?.balances?.generalBalanceNew
            ?? r?.balances?.generalBalance
            ?? r?.generalBalance;

    if (typeof gb === 'number') {
      saldos.saldoGeral = gb;
      console.log(`  ✓ saldoGeral via dashboard/balances: R$ ${gb.toLocaleString('pt-BR')}`);
    } else {
      console.log('  ⚠ generalBalance não encontrado na resposta');
    }

    // Tenta extrair saldos por conta do balanceOfTheMonth se disponível
    const bom = r?.results?.balanceOfTheMonth;
    if (bom) {
      console.log('  balanceOfTheMonth:', JSON.stringify(bom).substring(0, 200));
    }
  } catch (e) {
    console.log(`  ⚠ dashboard/balances: ${e.message.substring(0, 200)}`);
  }

  // ── B. Saldos por conta: account/v1/accounts ─────────────────────────────
  // Resposta: { results: [ { dsAccount, actualBalance, status, ... } ] }
  try {
    const r = await apiGet(CONTROLLE_API, 'account/v1/accounts', token, idEntity);
    console.log('  [account/v1/accounts]', JSON.stringify(r).substring(0, 600));

    const lista = r?.results ?? r?.data ?? r;
    const arr   = Array.isArray(lista) ? lista : [];
    console.log(`  → ${arr.length} conta(s) retornada(s)`);

    for (const item of arr) {
      const ativo = item.status === 1 || item.status === true || item.status === undefined;
      const nome  = item.dsAccount || item.ds_account || item.name || item.nome || item.description || '';
      const valor = extrairNumero(item, 'actualBalance', 'actual_balance', 'balance', 'saldo');
      console.log(`    conta: "${nome}" status=${item.status} ativo=${ativo} valor=${valor}`);
      if (ativo) classificarBanco(nome, valor);
    }
  } catch (e) {
    console.log(`  ⚠ account/v1/accounts: ${e.message.substring(0, 200)}`);
  }

  // ── C. Fallback: managerDashboard/generalBalance ──────────────────────────
  if (saldos.saldoGeral === null) {
    try {
      const r = await apiGet(CONTROLLE_API, 'report/v1/managerDashboard/generalBalance',
                             token, idEntity, { startDate: `${new Date().getFullYear()}-01-01`,
                                                endDate:   `${new Date().getFullYear()}-12-31` });
      console.log('  [managerDashboard/generalBalance]', JSON.stringify(r).substring(0, 300));
      const gb = r?.balances?.generalBalance ?? r?.generalBalance ?? r?.result;
      if (typeof gb === 'number') {
        saldos.saldoGeral = gb;
        console.log(`  ✓ saldoGeral via managerDashboard: ${gb}`);
      }
    } catch (e) {
      console.log(`  ⚠ managerDashboard/generalBalance: ${e.message.substring(0, 150)}`);
    }
  }

  // Garante valores padrão
  for (const banco of ['Itaú', 'Santander', 'BNB', 'Caixa', 'Sicoob']) {
    if (saldos[banco] === null) {
      saldos[banco] = 0;
      console.log(`  ⚠ ${banco} não encontrado nas contas — usando 0`);
    }
  }
  if (saldos.saldoGeral === null) {
    saldos.saldoGeral = Object.entries(saldos)
      .filter(([k]) => k !== 'saldoGeral')
      .reduce((s, [, v]) => s + (v || 0), 0);
    console.log(`  saldoGeral calculado: ${saldos.saldoGeral}`);
  }

  console.log('✓ Saldos finais:', JSON.stringify(saldos));
  return saldos;
}

// ── 3. Buscar DRE ─────────────────────────────────────────────────────────────
async function buscarDRE(token, idEntity) {
  console.log('→ Buscando DRE...');
  const ano       = new Date().getFullYear();
  const startDate = `${ano}-01-01`;
  const endDate   = `${ano}-12-31`;

  // Tentativa A: DRE redirect no gateway
  try {
    const r = await apiGet(CONTROLLE_GW, 'company/redirect/financial/report/dre',
                           token, idEntity, { startDate, endDate });
    console.log('  [dre gateway]', JSON.stringify(r).substring(0, 500));
    const dre = extrairDREDaResposta(r);
    if (dre.receita && dre.receita > 0) {
      console.log('✓ DRE (gateway):', JSON.stringify(dre));
      return dre;
    }
  } catch (e) {
    console.log(`  ⚠ dre gateway: ${e.message.substring(0, 150)}`);
  }

  // Tentativa B: managerDashboard/invoicing (receita) + profitability (resultado)
  let receita = null, resultado = null;

  try {
    const r = await apiGet(CONTROLLE_API, 'report/v1/managerDashboard/invoicing',
                           token, idEntity, { startDate, endDate });
    console.log('  [invoicing]', JSON.stringify(r).substring(0, 300));
    const d = r?.result ?? r?.results ?? r?.data ?? r;
    receita = extrairNumeroObjeto(d, ['totalRevenue','revenue','value','total','invoicing','faturamento']) ??
              (Array.isArray(d) ? somarArray(d, ['totalRevenue','revenue','value']) : null);
  } catch (e) {
    console.log(`  ⚠ invoicing: ${e.message.substring(0, 150)}`);
  }

  try {
    const r = await apiGet(CONTROLLE_API, 'report/v1/managerDashboard/profitability',
                           token, idEntity, { startDate, endDate });
    console.log('  [profitability]', JSON.stringify(r).substring(0, 300));
    const d = r?.result ?? r?.results ?? r?.data ?? r;
    resultado = extrairNumeroObjeto(d, ['result','profit','netProfit','net_profit','lucro','operationalResult','value']) ??
                (Array.isArray(d) ? somarArray(d, ['result','profit','value']) : null);
  } catch (e) {
    console.log(`  ⚠ profitability: ${e.message.substring(0, 150)}`);
  }

  if (receita && receita > 0) {
    console.log('✓ DRE (managerDashboard):', { receita, resultado });
    return { receita, resultado };
  }

  // Tentativa C: managerDashboard/ebitda
  try {
    const r = await apiGet(CONTROLLE_API, 'report/v1/managerDashboard/ebitda',
                           token, idEntity, { startDate, endDate });
    console.log('  [ebitda]', JSON.stringify(r).substring(0, 300));
    const d = r?.result ?? r?.results ?? r?.data ?? r;
    if (d) {
      receita   = extrairNumeroObjeto(d, ['totalRevenue','revenue','grossRevenue']) ?? receita;
      resultado = extrairNumeroObjeto(d, ['ebitda','result','profit'])              ?? resultado;
      if (receita && receita > 0) {
        console.log('✓ DRE (ebitda):', { receita, resultado });
        return { receita, resultado };
      }
    }
  } catch (e) {
    console.log(`  ⚠ ebitda: ${e.message.substring(0, 150)}`);
  }

  console.log('  ⚠ DRE não disponível — continuando sem receita/resultado.');
  return { receita: null, resultado: null };
}

function extrairNumeroObjeto(obj, campos) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  for (const c of campos) {
    if (typeof obj[c] === 'number') return obj[c];
    if (obj[c] != null) {
      const n = parseBR(String(obj[c]));
      if (n !== null) return n;
    }
  }
  return null;
}

function somarArray(arr, campos) {
  let total = 0;
  for (const item of arr) {
    for (const c of campos) {
      if (typeof item[c] === 'number') { total += item[c]; break; }
    }
  }
  return total > 0 ? total : null;
}

function extrairDREDaResposta(result) {
  const dre = { receita: null, resultado: null };
  if (!result) return dre;

  const items = result?.results ?? result?.data ?? result;

  if (typeof items === 'object' && items !== null && !Array.isArray(items)) {
    dre.receita   = extrairNumeroObjeto(items, ['receita','revenue','grossRevenue','totalRevenue','total_revenue','gross_revenue','faturamento']);
    dre.resultado = extrairNumeroObjeto(items, ['resultado','result','profit','netProfit','net_profit','lucro','operationalResult','ebitda']);
    return dre;
  }

  if (Array.isArray(items)) {
    for (const item of items) {
      const nome  = (item.name || item.nome || item.description || item.ds_name || '').toLowerCase();
      const valor = item.value ?? item.total ?? item.amount ?? item.balance ?? item.vl_total;
      const v     = typeof valor === 'number' ? valor : parseBR(String(valor ?? ''));
      if (!dre.receita   && (nome.includes('receita') || nome.includes('revenue') || nome.includes('faturamento'))) dre.receita   = v;
      if (!dre.resultado && (nome.includes('resultado') || nome.includes('lucro')  || nome.includes('profit')))     dre.resultado = v;
    }
  }
  return dre;
}

// ── 4. Atualizar HTML + JSON ──────────────────────────────────────────────────
async function aplicarAtualizacoes(repoRoot, saldos, dre) {
  const htmlPath = path.join(repoRoot, 'index.html');
  const jsonPath = path.join(repoRoot, 'data.json');

  let html = await fs.readFile(htmlPath, 'utf-8');
  let dj   = {};
  try { dj = JSON.parse(await fs.readFile(jsonPath, 'utf-8')); } catch (_) {}

  const ts = nowBrazil();

  // ---- data.json ----
  dj.data_coleta = ts.storage;
  dj.saldo_geral = saldos.saldoGeral;
  if (dre.receita   != null) dj.receita_ytd   = dre.receita;
  if (dre.resultado != null) dj.resultado_ytd = dre.resultado;
  dj.contas = [
    { nome: 'Itaú Unibanco',           saldo: saldos['Itaú']      },
    { nome: 'Santander',               saldo: saldos['Santander'] },
    { nome: 'Banco do Nordeste',       saldo: saldos['BNB']       },
    { nome: 'Caixa Econômica Federal', saldo: saldos['Caixa']     },
    { nome: 'Sicoob',                  saldo: saldos['Sicoob']    }
  ];

  // ---- index.html — chart barras ----
  const labelsKey = "labels:['Itaú','BNB','Caixa','Sicoob','Santander']";
  const idx = html.indexOf(labelsKey);
  if (idx !== -1) {
    const arr      = [saldos['Itaú'], saldos['BNB'], saldos['Caixa'], saldos['Sicoob'], saldos['Santander']];
    const dataStr  = 'data:[' + arr.map(v => Number(v).toFixed(2)).join(',') + ']';
    const dsStart  = html.indexOf('data:[', idx);
    const dsEnd    = html.indexOf(']', dsStart) + 1;
    if (dsStart !== -1 && dsEnd > 0) html = html.substring(0, dsStart) + dataStr + html.substring(dsEnd);
  }

  // ---- KPI Saldo ----
  html = html.replace(/(kpi-label[^>]*>Saldo Atual \(Realizado\)<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g, '$1' + fmtFull(saldos.saldoGeral));
  html = html.replace(/(kpi-label[^>]*>Saldo Realizado<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g,          '$1' + fmtFull(saldos.saldoGeral));

  // ---- KPI Receita ----
  if (dre.receita) {
    html = html.replace(/(kpi-label[^>]*>Receita 2026[^<]*<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g, '$1' + fmtInt(dre.receita));
    html = html.replace(/(kpi-label[^>]*>Receita Bruta[^<]*<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g, '$1' + fmtInt(dre.receita));
  }

  // ---- KPI Resultado + Margem ----
  if (dre.resultado) {
    html = html.replace(/(kpi-label[^>]*>Resultado 2026[^<]*<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g, '$1' + fmtInt(dre.resultado));
    const m = fmtMargem(dre.resultado, dre.receita);
    if (m) html = html.replace(/Margem: [\d,]+%/g, 'Margem: ' + m);
  }

  // ---- Timestamps ----
  html = html.replace(/Atualizado \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/g, 'Atualizado ' + ts.display);
  html = html.replace(/Posição: \d{2}\/\d{2}\/\d{4}(?: às \d{2}:\d{2})?/g, 'Posição: '   + ts.display);

  await fs.writeFile(htmlPath, html, 'utf-8');
  await fs.writeFile(jsonPath, JSON.stringify(dj, null, 2), 'utf-8');

  return {
    timestamp:  ts.display,
    saldoGeral: fmtFull(saldos.saldoGeral),
    receita:    dre.receita   ? fmtInt(dre.receita)   : 'N/A',
    resultado:  dre.resultado ? fmtInt(dre.resultado) : 'N/A',
    margem:     fmtMargem(dre.resultado, dre.receita) || 'N/A'
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const email    = process.env.CONTROLLE_EMAIL;
  const password = process.env.CONTROLLE_PASSWORD;
  if (!email || !password) {
    console.error('FATAL: defina CONTROLLE_EMAIL e CONTROLLE_PASSWORD como GitHub Secrets.');
    process.exit(1);
  }

  const repoRoot = path.resolve(__dirname, '..');
  console.log('Repo root:', repoRoot);
  console.log('Iniciando integração via API REST do Controlle...\n');

  try {
    const { accessToken, idEntity } = await loginControlle(email, password);
    const saldos  = await buscarSaldos(accessToken, idEntity);
    const dre     = await buscarDRE(accessToken, idEntity);
    const summary = await aplicarAtualizacoes(repoRoot, saldos, dre);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✓ Dashboard atualizado com sucesso!');
    console.log('  Timestamp:  ', summary.timestamp);
    console.log('  Saldo geral:', summary.saldoGeral);
    console.log('  Receita:    ', summary.receita);
    console.log('  Resultado:  ', summary.resultado);
    console.log('  Margem:     ', summary.margem);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } catch (err) {
    console.error('\n✗ FALHOU:', err.message);
    process.exit(1);
  }
})();
