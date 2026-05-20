/**
 * GTI Dashboard - Atualização diária via API REST do Controlle
 *
 * Fluxo confirmado (via logs reais de produção — 20/05/2026):
 * 1. POST /company/login  (Gateway) → {accessToken, refreshToken}
 * 2. GET  /auth/entities  (API)     → idEntity = 105337 (Green Tech Innovation)
 * 3. GET  /report/v1/dashboard/balances  (API + id_entity) →
 *         results.balances.generalBalance (centavos)
 *         results.balanceOfTheMonth: { revenuesPreview, expensesPreview, revenuesDone, expensesDone }
 *         results.balanceByPeriod: [{ month, balance }] (12 meses, centavos)
 * 4. GET  /account/v1/accounts  (API + id_entity) →
 *         lista de contas; fallback usa actualBalance (centavos) direto da listagem
 *         (endpoint balances/{id} retorna HTTP 400 com startDate/endDate — usar fallback)
 * 5. GET  /company/redirect/financial/report/dre (Gateway) →
 *         requer parâmetro dtInit/dtEnd (Date) OU /financial/entries para NFs
 * 6. Fallback DRE: usar revenuesPreview do balanceOfTheMonth
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

  console.log('→ Buscando entidades...');
  let entitiesResp;
  try {
    entitiesResp = await apiGet(CONTROLLE_API, 'auth/entities', accessToken, null);
  } catch (err) {
    throw new Error(`Falha ao buscar entidades (auth/entities): ${err.message}`);
  }

  console.log('  auth/entities snippet:', JSON.stringify(entitiesResp).substring(0, 300));

  const lista = entitiesResp?.entities ?? entitiesResp?.data ?? entitiesResp;
  const arr   = Array.isArray(lista) ? lista : (lista ? [lista] : []);

  if (arr.length === 0) {
    throw new Error('Nenhuma entidade retornada. Campos: ' + Object.keys(entitiesResp || {}).join(', '));
  }

  const entidade = arr.find(e => e.current === true) || arr[0];
  const idEntity = entidade?.id || entidade?.idEntity || entidade?.entityId || entidade?.companyId;

  if (!idEntity) {
    throw new Error('Entidade sem campo id. Campos: ' + Object.keys(entidade || {}).join(', '));
  }

  console.log(`✓ Login OK — idEntity: ${idEntity} (${entidade?.name || entidade?.fantasyName || 'sem nome'})`);
  return { accessToken, idEntity };
}

// ── 2. Buscar saldos + dados derivados do dashboard/balances ──────────────────
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
    'Caixa': null, 'Sicoob': null, saldoGeral: null,
    // Dados derivados de balanceOfTheMonth (receita/despesa do mês corrente)
    receitaMesPrevisao: null,
    despesaMesPrevisao: null,
    receitaMesRealizada: null,
    despesaMesRealizada: null,
    // balanceByPeriod: saldo acumulado mês a mês (12 valores, centavos ÷ 100)
    saldoPorMes: null
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

  // ── A. dashboard/balances — fonte primária de saldo + fluxo por mês ─────────
  // Resposta confirmada: {
  //   results: {
  //     balances: { generalBalance: 1366432 },          ← centavos
  //     balanceOfTheMonth: {
  //       revenuesDone: "0", revenuesPreview: "7568882",
  //       expensesDone: 0,   expensesPreview: 0
  //     },
  //     balanceByPeriod: [{ month:1, balance:13910953 }, ...]  ← centavos
  //   }
  // }
  try {
    const r = await apiGet(CONTROLLE_API, 'report/v1/dashboard/balances', token, idEntity);
    console.log('  [dashboard/balances]', JSON.stringify(r).substring(0, 600));

    // Saldo geral
    const gbRaw = r?.results?.balances?.generalBalance
               ?? r?.results?.balances?.generalBalanceNew
               ?? r?.balances?.generalBalance
               ?? r?.generalBalance;

    if (typeof gbRaw === 'number') {
      saldos.saldoGeral = gbRaw / 100;
      console.log(`  ✓ saldoGeral: ${gbRaw} centavos = R$ ${saldos.saldoGeral.toFixed(2)}`);
    } else {
      console.log('  ⚠ generalBalance não encontrado');
    }

    // balanceOfTheMonth — receita/despesa do mês corrente (em centavos como string ou número)
    const bom = r?.results?.balanceOfTheMonth;
    if (bom) {
      console.log('  balanceOfTheMonth:', JSON.stringify(bom));
      const toNum = v => typeof v === 'number' ? v : parseBR(String(v ?? '')) ?? 0;
      saldos.receitaMesPrevisao  = toNum(bom.revenuesPreview)  / 100;
      saldos.despesaMesPrevisao  = toNum(bom.expensesPreview)  / 100;
      saldos.receitaMesRealizada = toNum(bom.revenuesDone)     / 100;
      saldos.despesaMesRealizada = toNum(bom.expensesDone)     / 100;
      console.log(`  ✓ receita mês (prev): R$ ${saldos.receitaMesPrevisao.toFixed(2)}`);
      console.log(`  ✓ despesa mês (prev): R$ ${saldos.despesaMesPrevisao.toFixed(2)}`);
    }

    // balanceByPeriod — saldo por mês (12 itens, index 0 = Jan)
    const bbp = r?.results?.balanceByPeriod;
    if (Array.isArray(bbp) && bbp.length > 0) {
      saldos.saldoPorMes = bbp.map(item => ({
        mes:   item.month,
        saldo: typeof item.balance === 'number' ? item.balance / 100 : 0
      }));
      console.log('  ✓ balanceByPeriod:', saldos.saldoPorMes.slice(0,3).map(x=>`M${x.mes}=R$${x.saldo.toFixed(0)}`).join(', ') + '...');
    }
  } catch (e) {
    console.log(`  ⚠ dashboard/balances: ${e.message.substring(0, 200)}`);
  }

  // ── B. Saldos por conta — usa fallback direto da listagem (actualBalance) ───
  // NOTA: account/v1/accounts/balances/{id} retorna HTTP 400 "Data inicial inválida"
  //       independente do formato usado. O fallback da listagem já tem actualBalance em centavos.
  try {
    const r = await apiGet(CONTROLLE_API, 'account/v1/accounts', token, idEntity);
    const lista = r?.results ?? r?.data ?? r;
    const arr   = Array.isArray(lista) ? lista : [];
    console.log(`  → ${arr.length} conta(s) em account/v1/accounts`);

    for (const item of arr) {
      const nome = item.description_account || item.dsAccount || item.ds_account ||
                   item.name || item.nome || item.description || '';
      // actualBalance em centavos ÷ 100; aceita também campos alternativos
      const valorCents = extrairNumero(item, 'actualBalance', 'actual_balance', 'bank_balance', 'balance');
      const valor      = valorCents / 100;
      if (valor !== 0 || nome) {
        console.log(`    conta "${nome}": ${valorCents} centavos = R$ ${valor.toFixed(2)}`);
        classificarBanco(nome, valor);
      }
    }
  } catch (e) {
    console.log(`  ⚠ account/v1/accounts: ${e.message.substring(0, 200)}`);
  }

  // Garante valores padrão
  for (const banco of ['Itaú', 'Santander', 'BNB', 'Caixa', 'Sicoob']) {
    if (saldos[banco] === null) {
      saldos[banco] = 0;
      console.log(`  ⚠ ${banco} não encontrado — usando 0`);
    }
  }
  if (saldos.saldoGeral === null) {
    saldos.saldoGeral = Object.entries(saldos)
      .filter(([k]) => ['Itaú','Santander','BNB','Caixa','Sicoob'].includes(k))
      .reduce((s, [, v]) => s + (v || 0), 0);
    console.log(`  saldoGeral calculado: ${saldos.saldoGeral}`);
  }

  console.log('✓ Saldos finais:', JSON.stringify({
    Itaú: saldos['Itaú'], Santander: saldos['Santander'],
    BNB: saldos['BNB'], Caixa: saldos['Caixa'], Sicoob: saldos['Sicoob'],
    saldoGeral: saldos.saldoGeral,
    receitaMesPrevisao: saldos.receitaMesPrevisao,
    despesaMesPrevisao: saldos.despesaMesPrevisao
  }));
  return saldos;
}

// ── 3. Buscar DRE ─────────────────────────────────────────────────────────────
async function buscarDRE(token, idEntity) {
  console.log('→ Buscando DRE...');
  const ano = new Date().getFullYear();

  // ── Tentativa A: DRE gateway com parâmetros alternativos ────────────────────
  // Erro confirmado: "dtInit must be a Date instance"
  // Tentar: dtInit/dtEnd como ISO string, ou inicio/fim, ou year only
  const formatos = [
    { dtInit: `${ano}-01-01T00:00:00.000Z`, dtEnd: `${ano}-12-31T23:59:59.999Z` },
    { dtInit: `${ano}-01-01`,               dtEnd: `${ano}-12-31` },
    { inicio: `${ano}-01-01`,               fim:   `${ano}-12-31` },
    { year: ano },
    { ano }
  ];

  for (const params of formatos) {
    try {
      const r = await apiGet(CONTROLLE_GW, 'company/redirect/financial/report/dre',
                             token, idEntity, params);
      console.log(`  [dre gateway params=${JSON.stringify(params)}]`, JSON.stringify(r).substring(0, 600));
      const dre = extrairDREDaResposta(r);
      if (dre.receita && dre.receita > 0) {
        console.log('✓ DRE (gateway):', JSON.stringify(dre));
        return dre;
      }
    } catch (e) {
      console.log(`  ⚠ dre gateway (${JSON.stringify(params)}): ${e.message.substring(0, 100)}`);
    }
  }

  // ── Tentativa B: financial/entries (NFs emitidas) → soma receita ─────────────
  // Endpoint real do Controlle para NFs/lançamentos financeiros
  const startDate = `${ano}-01-01`;
  const endDate   = `${ano}-12-31`;

  try {
    const r = await apiGet(CONTROLLE_GW, 'company/redirect/financial/entries',
                           token, idEntity, { startDate, endDate, type: 'revenue' });
    console.log('  [financial/entries revenue]', JSON.stringify(r).substring(0, 400));
    const dre = extrairDREDaResposta(r);
    if (dre.receita && dre.receita > 0) {
      console.log('✓ DRE (entries):', JSON.stringify(dre));
      return dre;
    }
  } catch (e) {
    console.log(`  ⚠ financial/entries: ${e.message.substring(0, 100)}`);
  }

  // ── Tentativa C: report/v1/managerDashboard endpoints ───────────────────────
  let receita = null, resultado = null;

  for (const ep of ['invoicing','profitability','ebitda']) {
    try {
      const r = await apiGet(CONTROLLE_API, `report/v1/managerDashboard/${ep}`,
                             token, idEntity, { startDate, endDate });
      console.log(`  [${ep}]`, JSON.stringify(r).substring(0, 300));
      const d = r?.result ?? r?.results ?? r?.data ?? r;
      if (ep === 'invoicing') {
        receita = extrairNumeroObjeto(d, ['totalRevenue','revenue','value','total','invoicing','faturamento'])
               ?? (Array.isArray(d) ? somarArray(d, ['totalRevenue','revenue','value']) : null);
      } else if (ep === 'profitability') {
        resultado = extrairNumeroObjeto(d, ['result','profit','netProfit','net_profit','lucro','operationalResult','value'])
                 ?? (Array.isArray(d) ? somarArray(d, ['result','profit','value']) : null);
      } else if (ep === 'ebitda' && !receita) {
        receita   = extrairNumeroObjeto(d, ['totalRevenue','revenue','grossRevenue']) ?? receita;
        resultado = extrairNumeroObjeto(d, ['ebitda','result','profit'])              ?? resultado;
      }
    } catch (e) {
      console.log(`  ⚠ ${ep}: ${e.message.substring(0, 100)}`);
    }
  }

  if (receita && receita > 0) {
    console.log('✓ DRE (managerDashboard):', { receita, resultado });
    return { receita, resultado };
  }

  console.log('  ⚠ DRE não disponível — continuando sem receita/resultado.');
  return { receita: null, resultado: null };
}

// ── 4. Buscar faturamento por cliente (NFs emitidas) ─────────────────────────
async function buscarFaturamento(token, idEntity) {
  console.log('→ Buscando faturamento por cliente...');
  const ano       = new Date().getFullYear();
  const mesAtual  = new Date().getMonth() + 1;
  const mesFmt    = String(mesAtual).padStart(2, '0');
  const ultimoDia = new Date(ano, mesAtual, 0).getDate();

  // Dados de faturamento do mês atual e acumulado
  const resultado = {
    receitaMes:       null,
    maiorCliente:     null,
    maiorClienteNome: null,
    ticketMedio:      null,
    nfsEmitidas:      null,
    clientesFaturados: null,
    topClientes:      []   // [{ nome, valor }] top 8
  };

  // Tentar endpoint de NFs/receitas do Controlle
  const endpoints = [
    // Gateway: redirect para financial/invoices ou receitas
    { base: CONTROLLE_GW, path: 'company/redirect/financial/invoices',
      params: { startDate: `${ano}-${mesFmt}-01`, endDate: `${ano}-${mesFmt}-${ultimoDia}` } },
    { base: CONTROLLE_GW, path: 'company/redirect/financial/revenue',
      params: { startDate: `${ano}-${mesFmt}-01`, endDate: `${ano}-${mesFmt}-${ultimoDia}` } },
    // API direta
    { base: CONTROLLE_API, path: 'financial/v1/invoices',
      params: { startDate: `${ano}-${mesFmt}-01`, endDate: `${ano}-${mesFmt}-${ultimoDia}` } },
    { base: CONTROLLE_API, path: 'financial/v1/entries',
      params: { startDate: `${ano}-${mesFmt}-01`, endDate: `${ano}-${mesFmt}-${ultimoDia}`, type: 'revenue' } },
    { base: CONTROLLE_API, path: 'report/v1/revenue/byClient',
      params: { startDate: `${ano}-01-01`, endDate: `${ano}-12-31` } },
    { base: CONTROLLE_API, path: 'report/v1/financial/revenue',
      params: { startDate: `${ano}-${mesFmt}-01`, endDate: `${ano}-${mesFmt}-${ultimoDia}` } }
  ];

  for (const ep of endpoints) {
    try {
      const r = await apiGet(ep.base, ep.path, token, idEntity, ep.params);
      console.log(`  [${ep.path}]`, JSON.stringify(r).substring(0, 400));

      const lista = r?.results ?? r?.data ?? r?.items ?? r;
      const arr   = Array.isArray(lista) ? lista : null;

      if (arr && arr.length > 0) {
        console.log(`  → ${arr.length} registros em ${ep.path}`);

        // Tenta extrair dados de faturamento por cliente
        const porCliente = {};
        let totalNFs = 0;

        for (const item of arr) {
          const nome  = item.client || item.customer || item.clientName ||
                        item.nome || item.name || item.description || 'Desconhecido';
          const valor = typeof item.value === 'number' ? item.value
                      : typeof item.amount === 'number' ? item.amount
                      : parseBR(String(item.value ?? item.amount ?? item.total ?? 0)) ?? 0;

          if (valor > 0) {
            porCliente[nome] = (porCliente[nome] || 0) + valor;
            totalNFs++;
          }
        }

        if (Object.keys(porCliente).length > 0) {
          const entries = Object.entries(porCliente).sort(([,a],[,b]) => b - a);
          resultado.receitaMes        = entries.reduce((s,[,v]) => s + v, 0);
          resultado.maiorClienteNome  = entries[0][0];
          resultado.maiorCliente      = entries[0][1];
          resultado.nfsEmitidas       = totalNFs;
          resultado.clientesFaturados = entries.length;
          resultado.ticketMedio       = resultado.receitaMes / entries.length;
          resultado.topClientes       = entries.slice(0, 8).map(([nome, valor]) => ({ nome, valor }));
          console.log(`  ✓ faturamento: total=R$${resultado.receitaMes.toFixed(0)} clientes=${resultado.clientesFaturados} nfs=${resultado.nfsEmitidas}`);
          break;
        }
      }
    } catch (e) {
      console.log(`  ⚠ ${ep.path}: ${e.message.substring(0, 80)}`);
    }
  }

  if (!resultado.receitaMes) {
    console.log('  ⚠ Faturamento por cliente não disponível nesta conta.');
  }

  return resultado;
}

// ── Helpers DRE ───────────────────────────────────────────────────────────────
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

// ── 5. Atualizar HTML + JSON ──────────────────────────────────────────────────
async function aplicarAtualizacoes(repoRoot, saldos, dre, fat) {
  const htmlPath = path.join(repoRoot, 'index.html');
  const jsonPath = path.join(repoRoot, 'data.json');

  let html = await fs.readFile(htmlPath, 'utf-8');
  let dj   = {};
  try { dj = JSON.parse(await fs.readFile(jsonPath, 'utf-8')); } catch (_) {}

  const ts = nowBrazil();

  // ── data.json — todos os dados disponíveis ──────────────────────────────────
  dj.data_coleta = ts.storage;
  dj.saldo_geral = saldos.saldoGeral;
  if (dre.receita   != null) dj.receita_ytd   = dre.receita;
  if (dre.resultado != null) dj.resultado_ytd = dre.resultado;

  // Dados do mês corrente (balanceOfTheMonth)
  if (saldos.receitaMesPrevisao  != null) dj.receita_mes_previsao  = saldos.receitaMesPrevisao;
  if (saldos.despesaMesPrevisao  != null) dj.despesa_mes_previsao  = saldos.despesaMesPrevisao;
  if (saldos.receitaMesRealizada != null) dj.receita_mes_realizada = saldos.receitaMesRealizada;
  if (saldos.despesaMesRealizada != null) dj.despesa_mes_realizada = saldos.despesaMesRealizada;

  // Saldo por mês (balanceByPeriod)
  if (saldos.saldoPorMes) dj.saldo_por_mes = saldos.saldoPorMes;

  // Faturamento por cliente
  if (fat.receitaMes        != null) dj.faturamento_mes        = fat.receitaMes;
  if (fat.maiorCliente      != null) dj.maior_cliente_valor    = fat.maiorCliente;
  if (fat.maiorClienteNome  != null) dj.maior_cliente_nome     = fat.maiorClienteNome;
  if (fat.ticketMedio       != null) dj.ticket_medio           = fat.ticketMedio;
  if (fat.nfsEmitidas       != null) dj.nfs_emitidas           = fat.nfsEmitidas;
  if (fat.clientesFaturados != null) dj.clientes_faturados     = fat.clientesFaturados;
  if (fat.topClientes && fat.topClientes.length > 0) dj.top_clientes = fat.topClientes;

  dj.contas = [
    { nome: 'Itaú Unibanco',           saldo: saldos['Itaú']      },
    { nome: 'Santander',               saldo: saldos['Santander'] },
    { nome: 'Banco do Nordeste',       saldo: saldos['BNB']       },
    { nome: 'Caixa Econômica Federal', saldo: saldos['Caixa']     },
    { nome: 'Sicoob',                  saldo: saldos['Sicoob']    }
  ];

  // ── index.html — chart barras bancos ───────────────────────────────────────
  const labelsKey = "labels:['Itaú','BNB','Caixa','Sicoob','Santander']";
  const idx = html.indexOf(labelsKey);
  if (idx !== -1) {
    const arr     = [saldos['Itaú'], saldos['BNB'], saldos['Caixa'], saldos['Sicoob'], saldos['Santander']];
    const dataStr = 'data:[' + arr.map(v => Number(v).toFixed(2)).join(',') + ']';
    const dsStart = html.indexOf('data:[', idx);
    const dsEnd   = html.indexOf(']', dsStart) + 1;
    if (dsStart !== -1 && dsEnd > 0) html = html.substring(0, dsStart) + dataStr + html.substring(dsEnd);
  }

  // ── KPI Saldo Geral ─────────────────────────────────────────────────────────
  html = html.replace(/(kpi-label[^>]*>Saldo Atual \(Realizado\)<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g, '$1' + fmtFull(saldos.saldoGeral));
  html = html.replace(/(kpi-label[^>]*>Saldo Realizado<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g,          '$1' + fmtFull(saldos.saldoGeral));

  // ── KPI "Saldo Atual" (aba Fluxo — label sem "(Realizado)") ────────────────
  html = html.replace(
    /(kpi-label[^>]*>Saldo Atual<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g,
    '$1' + fmtFull(saldos.saldoGeral)
  );

  // ── KPI Receita ─────────────────────────────────────────────────────────────
  if (dre.receita) {
    html = html.replace(/(kpi-label[^>]*>Receita 2026[^<]*<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g, '$1' + fmtInt(dre.receita));
    html = html.replace(/(kpi-label[^>]*>Receita Bruta[^<]*<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g, '$1' + fmtInt(dre.receita));
  }

  // ── KPI Resultado + Margem ──────────────────────────────────────────────────
  if (dre.resultado) {
    html = html.replace(/(kpi-label[^>]*>Resultado 2026[^<]*<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g, '$1' + fmtInt(dre.resultado));
    const m = fmtMargem(dre.resultado, dre.receita);
    if (m) html = html.replace(/Margem: [\d,]+%/g, 'Margem: ' + m);
  }

  // ── Mês de referência dinâmico ──────────────────────────────────────────────
  const nomeMeses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                     'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const mesAtualNome = nomeMeses[parseInt(ts.mm, 10) - 1];
  html = html.replace(
    /Resumo executivo de [A-Za-záéíóúâêîôûãõÇç]+\/\d{4}/g,
    `Resumo executivo de ${mesAtualNome}/${ts.aaaa}`
  );

  // ── KPI Santander — valor real + cor dinâmica ───────────────────────────────
  const saldoSantander = saldos['Santander'];
  const corSantander   = saldoSantander >= 0 ? 'var(--gti-green)' : 'var(--red)';
  const trendSantander = saldoSantander >= 0 ? 'up">▲ Saldo positivo' : 'down">▼ Atenção necessária';
  html = html.replace(
    /(kpi-label[^>]*>Santander \(Negativo\)<\/div>\s*<div class="kpi-value" style="color:)[^"]*(">[^<]*)/g,
    `$1${corSantander}$2`
  );
  html = html.replace(
    /(kpi-label[^>]*>Santander \(Negativo\)<\/div>\s*<div class="kpi-value"[^>]*>)[^<]*/g,
    '$1' + fmtFull(saldoSantander)
  );
  html = html.replace(
    /(kpi-label[^>]*>Santander \(Negativo\)<\/div>\s*<div class="kpi-value"[^>]*>[^<]*<\/div>\s*<div class="kpi-trend )[^>]*(>[^<]*<\/div>)/g,
    `$1${trendSantander}</div>`
  );

  // ── Timestamps ──────────────────────────────────────────────────────────────
  html = html.replace(/Atualizado \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/g, 'Atualizado ' + ts.display);
  html = html.replace(/Posição: \d{2}\/\d{2}\/\d{4}(?: às \d{2}:\d{2})?/g, 'Posição: '   + ts.display);

  await fs.writeFile(htmlPath, html, 'utf-8');
  await fs.writeFile(jsonPath, JSON.stringify(dj, null, 2), 'utf-8');

  return {
    timestamp:  ts.display,
    saldoGeral: fmtFull(saldos.saldoGeral),
    receita:    dre.receita   ? fmtInt(dre.receita)   : 'N/A',
    resultado:  dre.resultado ? fmtInt(dre.resultado) : 'N/A',
    margem:     fmtMargem(dre.resultado, dre.receita) || 'N/A',
    receitaMesPrev: saldos.receitaMesPrevisao ? fmtInt(saldos.receitaMesPrevisao) : 'N/A',
    faturamento:    fat.receitaMes ? fmtInt(fat.receitaMes) : 'N/A'
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
    const fat     = await buscarFaturamento(accessToken, idEntity);
    const summary = await aplicarAtualizacoes(repoRoot, saldos, dre, fat);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✓ Dashboard atualizado com sucesso!');
    console.log('  Timestamp:       ', summary.timestamp);
    console.log('  Saldo geral:     ', summary.saldoGeral);
    console.log('  Receita YTD:     ', summary.receita);
    console.log('  Resultado YTD:   ', summary.resultado);
    console.log('  Margem:          ', summary.margem);
    console.log('  Receita mês prev:', summary.receitaMesPrev);
    console.log('  Faturamento NFs: ', summary.faturamento);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } catch (err) {
    console.error('\n✗ FALHOU:', err.message);
    process.exit(1);
  }
})();
