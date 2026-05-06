/**
 * GTI Dashboard - Atualização diária via API REST do Controlle
 *
 * Fluxo:
 * 1. Autentica no Firebase REST API com CONTROLLE_EMAIL / CONTROLLE_PASSWORD
 * 2. Usa o idToken Firebase para chamar a API do Controlle
 * 3. POST /company/login → obtém idEntity e tokens da empresa
 * 4. GET report/v1/dashboard/balances → saldos das contas bancárias
 * 5. GET transaction/v1/accounts → saldos individuais por conta
 * 6. DRE via report/v1/dre ou plan-account/v1/dreGroups → receita e resultado
 * 7. Atualiza index.html e data.json
 */

const https = require('https');
const fs    = require('fs').promises;
const path  = require('path');

// ── Configuração ─────────────────────────────────────────────────────────────

const FIREBASE_API_KEY = 'AIzaSyA32FVG1UBmebN6ukQiSartUY-iCyJ-Nfw';
const CONTROLLE_API    = 'https://controlle-api-prod.controlle.com';
const CONTROLLE_GW     = 'https://controlle-gateway-prod.controlle.com';

// ── Helpers de formatação BR ─────────────────────────────────────────────────

function parseBR(s) {
  if (!s) return null;
  return parseFloat(String(s).replace(/R\$\s*/, '').replace(/\./g, '').replace(',', '.').trim());
}

function fmtFull(v) {
  const abs = Math.abs(v).toFixed(2);
  const [ip, dec] = abs.split('.');
  const sign = v < 0 ? '-' : '';
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
  const a = new Date();
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
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 500)}`));
          } else {
            resolve(data);
          }
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function apiGet(baseUrl, path, token, idEntity, params = {}) {
  const url = new URL(baseUrl + '/' + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(idEntity ? { 'id_entity': String(idEntity) } : {})
    }
  };
  return httpRequest(options);
}

function apiPost(baseUrl, path, token, body, extraHeaders = {}) {
  const url = new URL(baseUrl + '/' + path);
  const bodyStr = JSON.stringify(body);
  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...extraHeaders
    }
  };
  return httpRequest(options, bodyStr);
}

// ── 1. Autenticação Firebase ──────────────────────────────────────────────────

async function autenticarFirebase(email, password) {
  console.log('→ Autenticando no Firebase...');
  const url  = new URL(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`);
  const body = JSON.stringify({ email, password, returnSecureToken: true });
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  let result;
  try {
    result = await httpRequest(options, body);
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('INVALID_PASSWORD') || msg.includes('EMAIL_NOT_FOUND')) {
      throw new Error('Credenciais inválidas — verifique CONTROLLE_EMAIL e CONTROLLE_PASSWORD nos Secrets do GitHub.');
    }
    if (msg.includes('TOO_MANY_ATTEMPTS')) {
      throw new Error('Muitas tentativas de login — conta temporariamente bloqueada. Aguarde e tente novamente.');
    }
    throw new Error(`Falha no login Firebase: ${msg}`);
  }

  if (!result.idToken) {
    throw new Error('Firebase não retornou idToken. Resposta: ' + JSON.stringify(result).substring(0, 300));
  }

  console.log('✓ Firebase OK — uid:', result.localId);
  return { idToken: result.idToken, refreshToken: result.refreshToken };
}

// ── 2. Login no Controlle (obtém idEntity) ────────────────────────────────────

async function loginControlle(idToken) {
  console.log('→ Fazendo login no Controlle...');

  let result;
  try {
    result = await apiPost(CONTROLLE_GW, 'company/login', idToken, {});
  } catch (err) {
    throw new Error(`Login Controlle falhou: ${err.message}`);
  }

  // A resposta pode ser objeto direto ou array de empresas
  let entity;
  if (Array.isArray(result)) {
    entity = result[0];
  } else if (result && result.data) {
    entity = Array.isArray(result.data) ? result.data[0] : result.data;
  } else {
    entity = result;
  }

  const idEntity = entity?.id || entity?.idEntity || entity?.id_entity;
  if (!idEntity) {
    throw new Error('Não foi possível obter idEntity. Resposta: ' + JSON.stringify(result).substring(0, 500));
  }

  console.log('✓ Controlle OK — idEntity:', idEntity);
  return { idEntity, token: entity?.accessToken || idToken };
}

// ── 3. Buscar saldos das contas ───────────────────────────────────────────────

async function buscarSaldos(token, idEntity) {
  console.log('→ Buscando saldos em report/v1/dashboard/balances...');

  let result;
  try {
    result = await apiGet(CONTROLLE_API, 'report/v1/dashboard/balances', token, idEntity);
  } catch (err) {
    throw new Error(`Falha ao buscar saldos: ${err.message}`);
  }

  console.log('  Resposta balances (preview):', JSON.stringify(result).substring(0, 400));

  // A resposta pode ter results[] ou ser um array direto
  const items = result?.results || result?.data || result;
  if (!Array.isArray(items) && typeof items !== 'object') {
    throw new Error('Formato inesperado de saldos: ' + JSON.stringify(result).substring(0, 300));
  }

  const bankMap = {
    'Itaú':      ['itau', 'itaú', 'unibanco'],
    'Santander': ['santander'],
    'BNB':       ['nordeste', 'bnb'],
    'Caixa':     ['caixa'],
    'Sicoob':    ['sicoob', 'sicredi']
  };

  const saldos = { 'Itaú': null, 'Santander': null, 'BNB': null, 'Caixa': null, 'Sicoob': null, saldoGeral: null };

  const arr = Array.isArray(items) ? items : Object.values(items);
  let totalCalculado = 0;

  for (const item of arr) {
    const nome = (item.name || item.nome || item.description || item.ds_name || '').toLowerCase();
    const saldo = typeof item.balance === 'number' ? item.balance
                : typeof item.saldo  === 'number' ? item.saldo
                : parseBR(item.balance || item.saldo || '0') || 0;

    if (nome.includes('geral') || item.type === 'TOTAL') {
      saldos.saldoGeral = saldo;
      continue;
    }

    for (const [banco, keywords] of Object.entries(bankMap)) {
      if (keywords.some(k => nome.includes(k))) {
        saldos[banco] = saldo;
        totalCalculado += saldo;
        break;
      }
    }
  }

  if (saldos.saldoGeral === null) {
    saldos.saldoGeral = Math.round(totalCalculado * 100) / 100;
  }

  // Fallback: se algum banco não foi encontrado nos balances, tenta /transaction/v1/accounts
  const banksMissing = Object.entries(saldos).filter(([k, v]) => k !== 'saldoGeral' && v === null);
  if (banksMissing.length > 0) {
    console.log('  ⚠ Alguns bancos não encontrados em balances, tentando /transaction/v1/accounts...');
    try {
      const acctResult = await apiGet(CONTROLLE_API, 'transaction/v1/accounts', token, idEntity, { limit: 100 });
      const accts = acctResult?.results || acctResult?.data || acctResult || [];
      for (const item of (Array.isArray(accts) ? accts : [])) {
        const nome = (item.name || item.nome || item.description || '').toLowerCase();
        const saldo = typeof item.balance === 'number' ? item.balance
                    : parseBR(item.balance || item.saldo || '0') || 0;
        for (const [banco, keywords] of Object.entries(bankMap)) {
          if (saldos[banco] === null && keywords.some(k => nome.includes(k))) {
            saldos[banco] = saldo;
            break;
          }
        }
      }
    } catch (e) {
      console.log('  ⚠ Falha em /transaction/v1/accounts:', e.message);
    }
  }

  // Preenche zeros para bancos ainda não encontrados
  for (const banco of Object.keys(bankMap)) {
    if (saldos[banco] === null) saldos[banco] = 0;
  }

  console.log('✓ Saldos:', saldos);
  return saldos;
}

// ── 4. Buscar DRE ─────────────────────────────────────────────────────────────

async function buscarDRE(token, idEntity) {
  console.log('→ Buscando DRE...');

  const ano = new Date().getFullYear();
  const startDate = `${ano}-01-01`;
  const endDate   = `${ano}-12-31`;

  // Tenta endpoint do DRE
  const endpoints = [
    { base: CONTROLLE_API, path: 'report/v1/dre',                  params: { startDate, endDate } },
    { base: CONTROLLE_API, path: 'report/v1/dashboard/dre',         params: { startDate, endDate } },
    { base: CONTROLLE_API, path: 'plan-account/v1/dreGroups',        params: { availableDRE: 'true' } },
    { base: CONTROLLE_API, path: 'report/v1/cashflow',              params: { startDate, endDate } },
  ];

  for (const { base, path: ep, params } of endpoints) {
    try {
      const result = await apiGet(base, ep, token, idEntity, params);
      console.log(`  Endpoint ${ep} respondeu:`, JSON.stringify(result).substring(0, 400));

      // Tenta extrair receita e resultado da resposta
      const dre = extrairDREDaResposta(result);
      if (dre.receita && dre.receita > 0) {
        console.log('✓ DRE:', dre);
        return dre;
      }
    } catch (e) {
      console.log(`  ⚠ ${ep}: ${e.message.substring(0, 100)}`);
    }
  }

  console.log('  ⚠ DRE indisponível — retornando valores em branco.');
  return { receita: null, resultado: null };
}

function extrairDREDaResposta(result) {
  const dre = { receita: null, resultado: null };
  if (!result) return dre;

  // Tenta acesso direto nos campos
  const items = result?.results || result?.data || result;

  function buscarValor(obj, keys) {
    if (!obj) return null;
    for (const k of keys) {
      if (typeof obj[k] === 'number') return obj[k];
      if (typeof obj[k] === 'string' && obj[k].includes(',')) return parseBR(obj[k]);
    }
    return null;
  }

  if (typeof items === 'object' && !Array.isArray(items)) {
    dre.receita   = buscarValor(items, ['receita', 'revenue', 'totalRevenue', 'grossRevenue', 'total_revenue']);
    dre.resultado = buscarValor(items, ['resultado', 'result', 'profit', 'netProfit', 'net_profit', 'lucro']);
    return dre;
  }

  if (Array.isArray(items)) {
    for (const item of items) {
      const nome = (item.name || item.nome || item.description || item.ds_name || '').toLowerCase();
      const valor = item.value || item.total || item.amount || item.balance;
      if (!dre.receita && (nome.includes('receita') || nome.includes('revenue') || nome.includes('faturamento'))) {
        dre.receita = typeof valor === 'number' ? valor : parseBR(String(valor || '0'));
      }
      if (!dre.resultado && (nome.includes('resultado') || nome.includes('lucro') || nome.includes('profit'))) {
        dre.resultado = typeof valor === 'number' ? valor : parseBR(String(valor || '0'));
      }
    }
  }

  return dre;
}

// ── 5. Aplicar atualizações no HTML e JSON ────────────────────────────────────

async function aplicarAtualizacoes(repoRoot, saldos, dre) {
  const htmlPath = path.join(repoRoot, 'index.html');
  const jsonPath = path.join(repoRoot, 'data.json');

  let html = await fs.readFile(htmlPath, 'utf-8');
  let dj = {};
  try {
    dj = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
  } catch (_) {}

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

  // ---- index.html ----
  // 1. Chart de barras bancárias
  const labelsKey = "labels:['Itaú','BNB','Caixa','Sicoob','Santander']";
  const idx = html.indexOf(labelsKey);
  if (idx !== -1) {
    const arr = [saldos['Itaú'], saldos['BNB'], saldos['Caixa'], saldos['Sicoob'], saldos['Santander']];
    const dataStr = 'data:[' + arr.map(v => Number(v).toFixed(2)).join(',') + ']';
    const dataStart = html.indexOf('data:[', idx);
    const dataEnd   = html.indexOf(']', dataStart) + 1;
    if (dataStart !== -1 && dataEnd > 0) {
      html = html.substring(0, dataStart) + dataStr + html.substring(dataEnd);
    }
  }

  // 2. KPI Saldo
  html = html.replace(
    /(kpi-label[^>]*>Saldo Atual \(Realizado\)<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g,
    '$1' + fmtFull(saldos.saldoGeral)
  );
  html = html.replace(
    /(kpi-label[^>]*>Saldo Realizado<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g,
    '$1' + fmtFull(saldos.saldoGeral)
  );

  // 3. KPI Receita
  if (dre.receita) {
    html = html.replace(
      /(kpi-label[^>]*>Receita 2026[^<]*<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g,
      '$1' + fmtInt(dre.receita)
    );
    html = html.replace(
      /(kpi-label[^>]*>Receita Bruta[^<]*<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g,
      '$1' + fmtInt(dre.receita)
    );
  }

  // 4. KPI Resultado + Margem
  if (dre.resultado) {
    html = html.replace(
      /(kpi-label[^>]*>Resultado 2026[^<]*<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g,
      '$1' + fmtInt(dre.resultado)
    );
    const novaMargem = fmtMargem(dre.resultado, dre.receita);
    if (novaMargem) {
      html = html.replace(/Margem: [\d,]+%/g, 'Margem: ' + novaMargem);
    }
  }

  // 5. Timestamps
  html = html.replace(/Atualizado \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/g, 'Atualizado ' + ts.display);
  html = html.replace(/Posição: \d{2}\/\d{2}\/\d{4}(?: às \d{2}:\d{2})?/g, 'Posição: ' + ts.display);

  await fs.writeFile(htmlPath, html, 'utf-8');
  await fs.writeFile(jsonPath, JSON.stringify(dj, null, 2), 'utf-8');

  return {
    timestamp: ts.display,
    saldoGeral: fmtFull(saldos.saldoGeral),
    receita: dre.receita   ? fmtInt(dre.receita)   : 'N/A',
    resultado: dre.resultado ? fmtInt(dre.resultado) : 'N/A',
    margem: fmtMargem(dre.resultado, dre.receita) || 'N/A'
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
  console.log('Iniciando integração via API REST do Controlle...');

  try {
    // 1. Firebase Auth
    const { idToken } = await autenticarFirebase(email, password);

    // 2. Login Controlle → idEntity
    const { idEntity, token } = await loginControlle(idToken);

    // 3. Saldos
    const saldos = await buscarSaldos(token, idEntity);

    // 4. DRE
    const dre = await buscarDRE(token, idEntity);

    // 5. Atualiza arquivos
    const summary = await aplicarAtualizacoes(repoRoot, saldos, dre);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✓ Dashboard atualizado com sucesso!');
    console.log('  Timestamp:  ', summary.timestamp);
    console.log('  Saldo geral:', summary.saldoGeral);
    console.log('  Receita:    ', summary.receita);
    console.log('  Resultado:  ', summary.resultado);
    console.log('  Margem:     ', summary.margem);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } catch (err) {
    console.error('✗ FALHOU:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
