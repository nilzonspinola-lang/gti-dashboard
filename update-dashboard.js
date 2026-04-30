// GTI Dashboard — Atualização automática de saldos v9
// Fix: submete login via Enter (SPA do Controlle não usa button[type=submit])

const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  console.log('▶ Iniciando atualização do GTI Dashboard...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36'
  });
  const page = await context.newPage();

  // ── 1. LOGIN ──────────────────────────────────────────────────────────────
  console.log('→ Abrindo Controlle login...');
  await page.goto('https://beta.controlle.com/login', { waitUntil: 'networkidle', timeout: 45000 });

  console.log('→ Aguardando campo de e-mail aparecer...');
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 });
  console.log('→ Formulário encontrado, preenchendo credenciais...');

  await page.locator('input[type="email"], input[name="email"]').first().fill(process.env.CONTROLLE_EMAIL);
  await page.locator('input[type="password"]').first().fill(process.env.CONTROLLE_PASSWORD);

  // Submete via Enter — o SPA do Controlle não possui button[type=submit] padrão
  console.log('→ Submetendo via Enter...');
  await page.locator('input[type="password"]').first().press('Enter');

  // Aguarda o redirect pós-login (até 20s)
  try {
    await page.waitForURL(url => !url.includes('login'), { timeout: 20000 });
  } catch(e) {
    console.log('→ Timeout esperando redirect, URL atual:', page.url());
  }
  await page.waitForTimeout(8000);

  const urlAposLogin = page.url();
  console.log('→ URL após login:', urlAposLogin.replace(/accessToken=[^&\s]+/, 'accessToken=***'));

  if (urlAposLogin.includes('login')) {
    await browser.close();
    console.error('ERRO: Falha no login. Credenciais incorretas?');
    process.exit(1);
  }

  // ── 2. VERIFICAR AUTENTICAÇÃO NO STORAGE ──────────────────────────────────
  const baseUrl = new URL(urlAposLogin).origin;
  console.log('→ Domínio autenticado:', baseUrl);

  const storageInfo = await page.evaluate(() => {
    const keys = Object.keys(localStorage);
    const tokenKeys = keys.filter(k => k.toLowerCase().includes('token') || k.toLowerCase().includes('auth') || k.toLowerCase().includes('user'));
    return { totalKeys: keys.length, tokenKeys: tokenKeys.slice(0,5) };
  });
  console.log('→ localStorage:', JSON.stringify(storageInfo));

  // ── 3. NAVEGAR PARA /contas ───────────────────────────────────────────────
  const contasUrl = baseUrl + '/contas';
  console.log('→ Navegando para:', contasUrl);

  await page.goto(contasUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(10000);

  const urlContas = page.url();
  console.log('→ URL final:', urlContas);

  if (urlContas.includes('login')) {
    const bodySnippet = await page.evaluate(() => document.body.innerText.substring(0, 300));
    console.log('→ Conteúdo da página:', bodySnippet);
    await browser.close();
    console.error('ERRO: Redirecionado para login em /contas.');
    process.exit(1);
  }

  // ── 4. EXTRAIR SALDOS ─────────────────────────────────────────────────────
  console.log('→ Extraindo saldos...');

  const bodyPreview = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('→ Prévia da página /contas:', bodyPreview.replace(/\n/g, ' | '));

  const saldos = await page.evaluate(() => {
    function parseBR(s) { return parseFloat(s.replace(/\./g, '').replace(',', '.')); }
    const text = document.body.innerText;
    const banks = {
      'Itaú':      /Itaú\s*Unibanco[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/,
      'BNB':       /Banco\s*do\s*Nordeste[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/,
      'Caixa':     /Caixa\s*Econômica\s*Federal[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/,
      'Sicoob':    /Sicoob[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/,
      'Santander': /Santander[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/
    };
    const sgM = text.match(/Saldo\s*geral[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/);
    const out = { saldoGeral: sgM ? parseBR(sgM[1]) : null };
    for (const [k, re] of Object.entries(banks)) {
      const m = text.match(re);
      out[k] = m ? parseBR(m[1]) : null;
    }
    const sum = (out['Itaú']||0)+(out['BNB']||0)+(out['Caixa']||0)+(out['Sicoob']||0)+(out['Santander']||0);
    if (out.saldoGeral === null) out.saldoGeral = Math.round(sum * 100) / 100;
    return out;
  });

  await browser.close();
  console.log('→ Saldos extraídos:', JSON.stringify(saldos));

  // ── 5. VALIDAÇÃO ──────────────────────────────────────────────────────────
  const nulls = Object.entries(saldos).filter(([, v]) => v === null).map(([k]) => k);
  if (nulls.length > 0) {
    console.error('ERRO: Saldos nulos para:', nulls.join(', '));
    process.exit(1);
  }
  const soma = (saldos['Itaú']||0)+(saldos['BNB']||0)+(saldos['Caixa']||0)+(saldos['Sicoob']||0)+(saldos['Santander']||0);
  if (Math.abs(soma - saldos.saldoGeral) > 1) {
    console.error(`ERRO: Integridade falhou. Soma=${soma.toFixed(2)}, SaldoGeral=${saldos.saldoGeral}`);
    process.exit(1);
  }
  console.log('✓ Integridade OK — diferença R$', Math.abs(soma - saldos.saldoGeral).toFixed(2));

  // ── 6. TIMESTAMP BRASÍLIA (UTC-3) ─────────────────────────────────────────
  const brasilia = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const dd   = String(brasilia.getUTCDate()).padStart(2, '0');
  const mm   = String(brasilia.getUTCMonth() + 1).padStart(2, '0');
  const aaaa = brasilia.getUTCFullYear();
  const hh   = String(brasilia.getUTCHours()).padStart(2, '0');
  const min  = String(brasilia.getUTCMinutes()).padStart(2, '0');
  const dt   = `${dd}/${mm}/${aaaa} às ${hh}:${min}`;

  // ── 7. data.json ──────────────────────────────────────────────────────────
  const dataJson = JSON.stringify({
    data_coleta: dt, saldo_geral: saldos.saldoGeral, receita_ytd: null,
    contas: [
      { nome: 'Itaú Unibanco',           saldo: saldos['Itaú']      },
      { nome: 'Santander',               saldo: saldos['Santander'] },
      { nome: 'Banco do Nordeste',       saldo: saldos['BNB']       },
      { nome: 'Caixa Econômica Federal', saldo: saldos['Caixa']     },
      { nome: 'Sicoob',                  saldo: saldos['Sicoob']    }
    ]
  }, null, 2);
  fs.writeFileSync('data.json', dataJson, 'utf8');
  console.log('✓ data.json atualizado');

  // ── 8. index.html ─────────────────────────────────────────────────────────
  let html = fs.readFileSync('index.html', 'utf8');
  const arr = [saldos['Itaú'], saldos['BNB'], saldos['Caixa'], saldos['Sicoob'], saldos['Santander']];
  const dataStr = 'data:[' + arr.map(v => Number(v).toFixed(2)).join(',') + ']';
  const labelsKey = "labels:['Itaú','BNB','Caixa','Sicoob','Santander']";
  const idx = html.indexOf(labelsKey);
  if (idx === -1) { console.error('ERRO: labels do gráfico não encontrados'); process.exit(1); }
  const dataStart = html.indexOf('data:[', idx);
  const dataEnd   = html.indexOf(']', dataStart) + 1;
  console.log('✓ Chart:', html.substring(dataStart, dataEnd), '→', dataStr);
  html = html.substring(0, dataStart) + dataStr + html.substring(dataEnd);
  html = html.replace(/Atualizado \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/g, `Atualizado ${dt}`);
  html = html.replace(/Posição: \d{2}\/\d{2}\/\d{4}(?: às \d{2}:\d{2})?/g, `Posição: ${dt}`);
  fs.writeFileSync('index.html', html, 'utf8');
  console.log('✓ index.html atualizado');

  console.log('');
  console.log('════════════════════════════════════════');
  console.log(`✅ GTI Dashboard atualizado — ${dt}`);
  console.log(`   Saldo Geral : R$ ${saldos.saldoGeral}`);
  console.log(`   Itaú: ${saldos['Itaú']} | BNB: ${saldos['BNB']} | Caixa: ${saldos['Caixa']} | Sicoob: ${saldos['Sicoob']} | Santander: ${saldos['Santander']}`);
  console.log('════════════════════════════════════════');
})();
