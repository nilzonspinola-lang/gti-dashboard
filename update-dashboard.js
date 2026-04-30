// GTI Dashboard — Atualização automática de saldos
// Roda via GitHub Actions. Credenciais via variáveis de ambiente.

const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  console.log('▶ Iniciando atualização do GTI Dashboard...');

  // ── 1. LOGIN NO CONTROLLE ────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36'
  });
  const page = await context.newPage();

  console.log('→ Abrindo Controlle...');
  await page.goto('https://beta.controlle.com/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail" i]').first();
  await emailInput.fill(process.env.CONTROLLE_EMAIL);

  const passInput = page.locator('input[type="password"]').first();
  await passInput.fill(process.env.CONTROLLE_PASSWORD);

  const submitBtn = page.locator('button[type="submit"], button:has-text("Entrar"), button:has-text("Login")').first();
  await submitBtn.click();

  await page.waitForTimeout(5000);
  const urlAposLogin = page.url();
  console.log('→ URL após login:', urlAposLogin);

  if (urlAposLogin.includes('login')) {
    await browser.close();
    console.error('ERRO: Falha no login do Controlle. Verifique as credenciais nos Secrets do GitHub.');
    process.exit(1);
  }

  // ── 2. NAVEGAR PARA /contas ──────────────────────────────────────────────
  console.log('→ Navegando para /contas...');
  await page.goto('https://beta.controlle.com/contas', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(7000);

  const urlContas = page.url();
  if (urlContas.includes('login')) {
    await browser.close();
    console.error('ERRO: Redirecionado para login em /contas.');
    process.exit(1);
  }

  // ── 3. EXTRAIR SALDOS ────────────────────────────────────────────────────
  console.log('→ Extraindo saldos...');
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
    if (out.saldoGeral === null) out.saldoGeral = Math.round(sum*100)/100;
    return out;
  });

  await browser.close();
  console.log('→ Saldos extraídos:', JSON.stringify(saldos));

  // ── 4. VALIDAÇÃO ─────────────────────────────────────────────────────────
  const nulls = Object.entries(saldos).filter(([,v]) => v === null).map(([k]) => k);
  if (nulls.length > 0) { console.error('ERRO: Saldos nulos:', nulls.join(', ')); process.exit(1); }
  const soma = (saldos['Itaú']||0)+(saldos['BNB']||0)+(saldos['Caixa']||0)+(saldos['Sicoob']||0)+(saldos['Santander']||0);
  if (Math.abs(soma - saldos.saldoGeral) > 1) { console.error('ERRO: Integridade falhou'); process.exit(1); }
  console.log('✓ Integridade OK');

  // ── 5. TIMESTAMP BRASÍLIA (UTC-3) ─────────────────────────────────────────
  const brasilia = new Date(Date.now() - 3*60*60*1000);
  const dd  = String(brasilia.getUTCDate()).padStart(2,'0');
  const mm  = String(brasilia.getUTCMonth()+1).padStart(2,'0');
  const aaaa= brasilia.getUTCFullYear();
  const hh  = String(brasilia.getUTCHours()).padStart(2,'0');
  const min = String(brasilia.getUTCMinutes()).padStart(2,'0');
  const dt  = `${dd}/${mm}/${aaaa} às ${hh}:${min}`;

  // ── 6. data.json ─────────────────────────────────────────────────────────
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

  // ── 7. index.html ─────────────────────────────────────────────────────────
  let html = fs.readFileSync('index.html', 'utf8');
  const arr = [saldos['Itaú'],saldos['BNB'],saldos['Caixa'],saldos['Sicoob'],saldos['Santander']];
  const dataStr = 'data:[' + arr.map(v=>Number(v).toFixed(2)).join(',') + ']';
  const labelsKey = "labels:['Itaú','BNB','Caixa','Sicoob','Santander']";
  const idx = html.indexOf(labelsKey);
  if (idx===-1){ console.error('ERRO: labels não encontrados'); process.exit(1); }
  const dataStart = html.indexOf('data:[',idx);
  const dataEnd   = html.indexOf(']',dataStart)+1;
  console.log('✓ Chart:', html.substring(dataStart,dataEnd), '→', dataStr);
  html = html.substring(0,dataStart)+dataStr+html.substring(dataEnd);
  html = html.replace(/Atualizado \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/g, 'Atualizado '+dt);
  html = html.replace(/Posição: \d{2}\/\d{2}\/\d{4}(?: às \d{2}:\d{2})?/g, 'Posição: '+dt);
  fs.writeFileSync('index.html', html, 'utf8');
  console.log('✓ index.html atualizado');

  console.log('');
  console.log('════════════════════════════════════════');
  console.log('✅ GTI Dashboard atualizado —', dt);
  console.log('   Saldo Geral: R$', saldos.saldoGeral);
  console.log('   Itaú:', saldos['Itaú'], '| BNB:', saldos['BNB'], '| Caixa:', saldos['Caixa'], '| Sicoob:', saldos['Sicoob'], '| Santander:', saldos['Santander']);
  console.log('════════════════════════════════════════');
})();
