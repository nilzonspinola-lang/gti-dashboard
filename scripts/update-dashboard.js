/**
 * GTI Dashboard - Atualização diária (GitHub Actions)
 *
 * Equivalente ao SKILL.md `gti-dashboard-diario` do Cowork, mas headless via Playwright.
 *
 * 1. Loga no Controlle (https://app.controlle.com/login) com CONTROLLE_EMAIL / CONTROLLE_PASSWORD
 * 2. Extrai saldos das 5 contas + saldo geral em /contas
 * 3. Extrai DRE (Receita / Resultado) em /relatorios/dre (clica "Gerar relatório")
 * 4. Atualiza index.html e data.json no checkout local
 * 5. O step seguinte do workflow faz git commit & push
 */

const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');

// ---------------- Helpers de formatação BR ----------------

function parseBR(s) {
  if (!s) return null;
  return parseFloat(s.replace(/R\$\s*/, '').replace(/\./g, '').replace(',', '.').trim());
}

function fmtFull(v) {
  const abs = Math.abs(v).toFixed(2);
  const [ip, dec] = abs.split('.');
  return 'R$ ' + ip.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + dec;
}

function fmtInt(v) {
  return 'R$ ' + Math.round(Math.abs(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function fmtMargem(res, rec) {
  if (!rec || rec === 0) return null;
  return (Math.abs(res) / rec * 100).toFixed(1).replace('.', ',') + '%';
}

// Carimbo de data no fuso de Brasília (workflow já roda com TZ=America/Sao_Paulo)
function nowBrazil() {
  const a = new Date();
  const dd   = String(a.getDate()).padStart(2, '0');
  const mm   = String(a.getMonth() + 1).padStart(2, '0');
  const aaaa = a.getFullYear();
  const hh   = String(a.getHours()).padStart(2, '0');
  const min  = String(a.getMinutes()).padStart(2, '0');
  return {
    storage: `${dd}/${mm}/${aaaa} as ${hh}:${min}`,    // gravado no JSON (sem acento)
    display: `${dd}/${mm}/${aaaa} às ${hh}:${min}`,    // exibido no HTML
    dd, mm, aaaa
  };
}

// ---------------- Login no Controlle ----------------

async function loginControlle(page, email, password) {
  console.log('→ Abrindo página de login...');
  await page.goto('https://app.controlle.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000); // SPA precisa renderizar

  // Aguarda algum input do tipo email/text aparecer
  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[placeholder*="mail" i]',
    'input[placeholder*="usuário" i]',
    'input[placeholder*="usuario" i]',
    'form input[type="text"]'
  ];
  const passSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]',
    'input[placeholder*="senha" i]'
  ];

  let emailHandle = null;
  for (const sel of emailSelectors) {
    try {
      emailHandle = await page.waitForSelector(sel, { state: 'visible', timeout: 3000 });
      if (emailHandle) { console.log(`  • email selector: ${sel}`); break; }
    } catch (_) { /* tenta o próximo */ }
  }
  if (!emailHandle) {
    await page.screenshot({ path: 'debug-login-no-email.png', fullPage: true }).catch(() => {});
    throw new Error('Não encontrei o campo de email na tela de login.');
  }

  let passHandle = null;
  for (const sel of passSelectors) {
    try {
      passHandle = await page.$(sel);
      if (passHandle) { console.log(`  • password selector: ${sel}`); break; }
    } catch (_) { /* */ }
  }
  if (!passHandle) {
    await page.screenshot({ path: 'debug-login-no-pass.png', fullPage: true }).catch(() => {});
    throw new Error('Não encontrei o campo de senha na tela de login.');
  }

  await emailHandle.fill(email);
  await passHandle.fill(password);

  // Botão de submit — múltiplos fallbacks
  const submitCandidates = [
    'button[type="submit"]',
    'form button:not([type="button"])',
    'button:has-text("Entrar")',
    'button:has-text("ENTRAR")',
    'button:has-text("Login")',
    'button:has-text("Acessar")',
    'input[type="submit"]'
  ];
  let clicked = false;
  for (const sel of submitCandidates) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        console.log(`  • submit selector: ${sel}`);
        await Promise.race([
          page.waitForURL(u => !u.toString().includes('/login'), { timeout: 30000 }),
          (async () => { await btn.click(); await page.waitForTimeout(8000); })()
        ]).catch(() => {});
        await btn.click().catch(() => {});
        clicked = true;
        break;
      }
    } catch (_) { /* */ }
  }
  if (!clicked) {
    // Último fallback: pressionar Enter no campo de senha
    await passHandle.press('Enter').catch(() => {});
  }

  // Aguarda sair da tela de login
  try {
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 30000 });
  } catch (e) {
    await page.screenshot({ path: 'debug-login-failed.png', fullPage: true }).catch(() => {});
    throw new Error(`Login falhou — ainda em ${page.url()}. Verifique CONTROLLE_EMAIL/CONTROLLE_PASSWORD.`);
  }
  console.log('✓ Login OK. URL atual:', page.url());
}

// ---------------- Extrair saldos ----------------

async function extrairSaldos(page) {
  console.log('→ Extraindo saldos em /contas...');
  await page.goto('https://app.controlle.com/contas', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);

  const saldos = await page.evaluate(() => {
    function parseBR(s) { return parseFloat(s.replace(/\./g, '').replace(',', '.')); }
    const text = document.body.innerText;
    const banks = {
      Itau:      /Itaú\s*Unibanco[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/,
      BNB:       /Banco\s*do\s*Nordeste[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/,
      Caixa:     /Caixa\s*Econômica\s*Federal[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/,
      Sicoob:    /Sicoob[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/,
      Santander: /Santander[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/
    };
    const sgM = text.match(/Saldo\s*geral[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/);
    const out = { saldoGeral: sgM ? parseBR(sgM[1]) : null };
    for (const [k, re] of Object.entries(banks)) {
      const m = text.match(re);
      out[k] = m ? parseBR(m[1]) : null;
    }
    const sum = (out.Itau || 0) + (out.BNB || 0) + (out.Caixa || 0) + (out.Sicoob || 0) + (out.Santander || 0);
    if (out.saldoGeral === null) out.saldoGeral = Math.round(sum * 100) / 100;
    return {
      'Itaú':      out.Itau,
      'BNB':       out.BNB,
      'Caixa':     out.Caixa,
      'Sicoob':    out.Sicoob,
      'Santander': out.Santander,
      saldoGeral:  out.saldoGeral
    };
  });

  // Validação
  const banks = ['Itaú', 'BNB', 'Caixa', 'Sicoob', 'Santander'];
  for (const b of banks) {
    if (typeof saldos[b] !== 'number' || Number.isNaN(saldos[b])) {
      await page.screenshot({ path: 'debug-saldos.png', fullPage: true }).catch(() => {});
      throw new Error(`Saldo ${b} não numérico: ${saldos[b]}`);
    }
  }
  if (typeof saldos.saldoGeral !== 'number' || Number.isNaN(saldos.saldoGeral)) {
    await page.screenshot({ path: 'debug-saldos.png', fullPage: true }).catch(() => {});
    throw new Error('Saldo geral não numérico');
  }
  const sum = banks.reduce((a, b) => a + saldos[b], 0);
  if (Math.abs(sum - saldos.saldoGeral) > 1) {
    throw new Error(`Integridade falhou: soma=${sum.toFixed(2)} vs saldoGeral=${saldos.saldoGeral.toFixed(2)}`);
  }

  console.log('✓ Saldos:', saldos);
  return saldos;
}

// ---------------- Extrair DRE ----------------

async function extrairDRE(page) {
  console.log('→ Extraindo DRE em /relatorios/dre...');
  await page.goto('https://app.controlle.com/relatorios/dre', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  // Clica em "Gerar relatório"
  try {
    const btn = await page.waitForSelector('button:has-text("Gerar relatório")', { timeout: 15000 });
    await btn.click();
  } catch (e) {
    console.log('  ⚠ Botão "Gerar relatório" não encontrado — DRE talvez já carregado.');
  }
  await page.waitForTimeout(10000);

  const dre = await page.evaluate(() => {
    function parseBR(s) {
      if (!s) return null;
      return parseFloat(s.replace(/R\$\s*/, '').replace(/\./g, '').replace(',', '.').trim());
    }
    const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean);
    function findTotal(startIdx) {
      for (let i = startIdx + 1; i < Math.min(startIdx + 8, lines.length); i++) {
        const m = lines[i].match(/R\$\s*-?[\d.]+,\d{2}/g);
        if (m && m.length >= 3) return parseBR(m[m.length - 1]);
      }
      return null;
    }
    const dreData = {};
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l === 'Receitas operacionais')        dreData.receita        = findTotal(i);
      if (l === 'Lucro / prejuízo operacional') dreData.resultado      = findTotal(i);
      if (l === 'Resultado final')              dreData.resultadoFinal = findTotal(i);
    }
    if (dreData.resultadoFinal !== null && dreData.resultadoFinal !== undefined) {
      dreData.resultado = dreData.resultadoFinal;
    }
    return dreData;
  });

  if (typeof dre.receita !== 'number' || dre.receita <= 0) {
    console.log('  ⚠ DRE indisponível (receita ausente). Vou continuar sem atualizar receita/resultado/margem.');
  }
  console.log('✓ DRE:', dre);
  return dre;
}

// ---------------- Atualizar HTML + JSON ----------------

async function aplicarAtualizacoes(repoRoot, saldos, dre) {
  const htmlPath = path.join(repoRoot, 'index.html');
  const jsonPath = path.join(repoRoot, 'data.json');

  let html = await fs.readFile(htmlPath, 'utf-8');
  let dataJsonCurrent = '{}';
  try { dataJsonCurrent = await fs.readFile(jsonPath, 'utf-8'); } catch (_) {}

  const ts = nowBrazil();

  // ---- data.json ----
  let dj;
  try { dj = JSON.parse(dataJsonCurrent); } catch (_) { dj = {}; }
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
  const newDataJson = JSON.stringify(dj, null, 2);

  // ---- index.html ----
  // 1. chartContasBancos
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
  await fs.writeFile(jsonPath, newDataJson, 'utf-8');

  return {
    timestamp: ts.display,
    saldoGeral: fmtFull(saldos.saldoGeral),
    receita: dre.receita ? fmtInt(dre.receita) : 'N/A',
    resultado: dre.resultado ? fmtInt(dre.resultado) : 'N/A',
    margem: fmtMargem(dre.resultado, dre.receita) || 'N/A'
  };
}

// ---------------- Main ----------------

(async () => {
  const email    = process.env.CONTROLLE_EMAIL;
  const password = process.env.CONTROLLE_PASSWORD;
  if (!email || !password) {
    console.error('FATAL: defina CONTROLLE_EMAIL e CONTROLLE_PASSWORD como GitHub Secrets.');
    process.exit(1);
  }

  // O checkout do GitHub Actions deixa o repo em $GITHUB_WORKSPACE.
  // scripts/ está dentro do repo, então o root é o parent.
  const repoRoot = path.resolve(__dirname, '..');
  console.log('Repo root:', repoRoot);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1366, height: 800 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    await loginControlle(page, email, password);
    const saldos = await extrairSaldos(page);
    const dre    = await extrairDRE(page);
    const summary = await aplicarAtualizacoes(repoRoot, saldos, dre);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✓ Dashboard atualizado');
    console.log('  Timestamp:  ', summary.timestamp);
    console.log('  Saldo geral:', summary.saldoGeral);
    console.log('  Receita:    ', summary.receita);
    console.log('  Resultado:  ', summary.resultado);
    console.log('  Margem:     ', summary.margem);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } catch (err) {
    console.error('✗ FALHOU:', err.message);
    console.error(err.stack);
    try { await page.screenshot({ path: 'debug-final.png', fullPage: true }); } catch (_) {}
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
