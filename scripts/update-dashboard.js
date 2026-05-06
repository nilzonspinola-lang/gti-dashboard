/**
 * GTI Dashboard - Atualização diária via API REST do Controlle
 *
 * Fluxo:
 * 1. POST /company/login no Gateway → email + senha → retorna accessToken + idEntity
 * 2. GET report/v1/dashboard/balances → saldos das contas bancárias
 * 3. GET transaction/v1/accounts → fallback individual por conta
 * 4. DRE via múltiplos endpoints → receita e resultado YTD
 * 5. Atualiza index.html e data.json
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
  return parseFloat(String(s).replace(/R\$\s*/, '').replace(/\./g, '').replace(',', '.').trim());
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
          const msg = (parsed && parsed.message) ? parsed.message : JSON.stringify(parsed).substring(0, 300);
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

function apiPost(baseUrl, endpoint, token, body, extraHeaders = {}) {
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
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders
    }
  }, bodyStr);
}

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

// ── 1. Login direto no Controlle Gateway ──────────────────────────────────────
async function loginControlle(email, password) {
  console.log('→ Autenticando no Controlle Gateway...');

  let result;
  try {
    result = await apiPost(CONTROLLE_GW, 'company/login', null, { email, password });
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

  console.log('  Resposta login (preview):', JSON.stringify(result).substring(0, 300));

  // Resposta pode ser array de empresas ou objeto único
  const empresas = Array.isArray(result) ? result : (result.data ? (Array.isArray(result.data) ? result.data : [result.data]) : [result]);
  const empresa  = empresas[0];

  const accessToken = empresa?.accessToken || empresa?.access_token || empresa?.token || empresa?.idToken;
  const idEntity    = empresa?.id          || empresa?.idEntity     || empresa?.id_entity;

  if (!accessToken) throw new Error('Login OK mas sem accessToken. Resposta: ' + JSON.stringify(result).substring(0, 400));
  if (!idEntity)    throw new Error('Login OK mas sem idEntity. Resposta: '    + JSON.stringify(result).substring(0, 400));

  console.log(`✓ Login OK — idEntity: ${idEntity}`);
  return { accessToken, idEntity };
}

// ── 2. Buscar saldos ──────────────────────────────────────────────────────────
async function buscarSaldos(token, idEntity) {
  console.log('→ Buscando saldos...');

  const bankMap = {
    'Itaú':      ['itau', 'itaú', 'unibanco'],
    'Santander': ['santander'],
    'BNB':       ['nordeste', 'bnb'],
    'Caixa':     ['caixa'],
    'Sicoob':    ['sicoob', 'sicredi']
  };

  const saldos = { 'Itaú': null, 'Santander': null, 'BNB': null, 'Caixa': null, 'Sicoob': null, saldoGeral: null };

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

  // Tenta endpoint de balances
  for (const ep of ['report/v1/dashboard/balances', 'report/v1/managerDashboard/balances']) {
    try {
      const result = await apiGet(CONTROLLE_API, ep, token, idEntity);
      console.log(`  ${ep} →`, JSON.stringify(result).substring(0, 300));
      const items = result?.results ?? result?.data ?? result;
      const arr   = Array.isArray(items) ? items : Object.values(typeof items === 'object' && items !== null ? items : {});
      for (const item of arr) {
        const nome   = item.name || item.nome || item.description || item.ds_name || '';
        const saldo  = typeof item.balance === 'number' ? item.balance
                     : typeof item.saldo   === 'number' ? item.saldo
                     : parseBR(item.balance ?? item.saldo ?? '') ?? 0;
        if (nome.toLowerCase().includes('geral') || item.type === 'TOTAL') {
          if (saldos.saldoGeral === null) saldos.saldoGeral = saldo;
        } else {
          classificarBanco(nome, saldo);
        }
      }
      if (Object.values(saldos).some(v => v !== null)) break;
    } catch (e) {
      console.log(`  ⚠ ${ep}: ${e.message.substring(0, 120)}`);
    }
  }

  // Fallback: busca contas individuais
  const faltando = Object.entries(saldos).filter(([k, v]) => k !== 'saldoGeral' && v === null);
  if (faltando.length > 0) {
    console.log('  Tentando fallback em transaction/v1/accounts...');
    try {
      const r    = await apiGet(CONTROLLE_API, 'transaction/v1/accounts', token, idEntity, { limit: 100, status: 1 });
      const arr  = r?.results ?? r?.data ?? r ?? [];
      for (const item of (Array.isArray(arr) ? arr : [])) {
        const nome  = item.name || item.nome || item.description || '';
        const saldo = typeof item.balance === 'number' ? item.balance : parseBR(String(item.balance ?? '')) ?? 0;
        classificarBanco(nome, saldo);
      }
    } catch (e) {
      console.log(`  ⚠ fallback accounts: ${e.message.substring(0, 120)}`);
    }
  }

  // Garante que nenhum banco fique null
  for (const banco of Object.keys(bankMap)) {
    if (saldos[banco] === null) { saldos[banco] = 0; console.log(`  ⚠ ${banco} não encontrado — usando 0`); }
  }
  if (saldos.saldoGeral === null) {
    saldos.saldoGeral = Object.entries(saldos).filter(([k]) => k !== 'saldoGeral').reduce((s, [, v]) => s + v, 0);
  }

  console.log('✓ Saldos:', JSON.stringify(saldos));
  return saldos;
}

// ── 3. Buscar DRE ─────────────────────────────────────────────────────────────
async function buscarDRE(token, idEntity) {
  console.log('→ Buscando DRE...');
  const ano       = new Date().getFullYear();
  const startDate = `${ano}-01-01`;
  const endDate   = `${ano}-12-31`;

  const endpoints = [
    { base: CONTROLLE_API, ep: 'report/v1/dre',               params: { startDate, endDate } },
    { base: CONTROLLE_API, ep: 'report/v1/dashboard/dre',      params: { startDate, endDate } },
    { base: CONTROLLE_GW,  ep: 'report/v1/dre',               params: { startDate, endDate } },
    { base: CONTROLLE_API, ep: 'report/v1/cashflow/summary',  params: { startDate, endDate } },
  ];

  for (const { base, ep, params } of endpoints) {
    try {
      const result = await apiGet(base, ep, token, idEntity, params);
      console.log(`  ${ep} →`, JSON.stringify(result).substring(0, 300));
      const dre = extrairDREDaResposta(result);
      if (dre.receita && dre.receita > 0) {
        console.log('✓ DRE:', JSON.stringify(dre));
        return dre;
      }
    } catch (e) {
      console.log(`  ⚠ ${ep}: ${e.message.substring(0, 120)}`);
    }
  }

  console.log('  ⚠ DRE não disponível — continuando sem atualizar receita/resultado.');
  return { receita: null, resultado: null };
}

function extrairDREDaResposta(result) {
  const dre = { receita: null, resultado: null };
  if (!result) return dre;
  const items = result?.results ?? result?.data ?? result;

  function num(obj, keys) {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && (v.includes(',') || v.includes('.'))) { const n = parseBR(v); if (n != null) return n; }
    }
    return null;
  }

  if (typeof items === 'object' && items !== null && !Array.isArray(items)) {
    dre.receita   = num(items, ['receita', 'revenue', 'grossRevenue', 'totalRevenue', 'total_revenue', 'gross_revenue']);
    dre.resultado = num(items, ['resultado', 'result', 'profit', 'netProfit', 'net_profit', 'lucro', 'operationalResult']);
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
  if (dre.receita)   dj.receita_ytd   = dre.receita;
  if (dre.resultado) dj.resultado_ytd = dre.resultado;
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
    // 1. Login direto no gateway
    const { accessToken, idEntity } = await loginControlle(email, password);

    // 2. Saldos
    const saldos = await buscarSaldos(accessToken, idEntity);

    // 3. DRE
    const dre = await buscarDRE(accessToken, idEntity);

    // 4. Aplica no HTML + JSON
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
