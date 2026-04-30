// GTI Dashboard v4 — navegação SPA via clique no menu
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  console.log('▶ Iniciando GTI Dashboard v4...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' });
  const page = await context.newPage();

  // LOGIN
  console.log('→ Login...');
  await page.goto('https://beta.controlle.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.locator('input[type="email"], input[name="email"]').first().fill(process.env.CONTROLLE_EMAIL);
  await page.locator('input[type="password"]').first().fill(process.env.CONTROLLE_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  try { await page.waitForURL(u => !u.includes('login'), { timeout: 20000 }); } catch(e) {}
  await page.waitForTimeout(8000);

  const urlDash = page.url();
  console.log('→ URL dashboard:', urlDash.replace(/accessToken=[^&\s]+/,'***'));
  if (urlDash.includes('login')) { await browser.close(); console.error('ERRO: falha no login'); process.exit(1); }

  const baseUrl = new URL(urlDash).origin;
  console.log('→ Base URL:', baseUrl);

  // Verificar localStorage
  const ls = await page.evaluate(() => {
    const keys = Object.keys(localStorage);
    const tokens = keys.filter(k => /token|auth|access|user/i.test(k));
    const sample = {};
    tokens.slice(0,3).forEach(k => { sample[k] = localStorage.getItem(k)?.substring(0,30); });
    return { total: keys.length, tokenKeys: tokens, sample };
  });
  console.log('→ localStorage:', JSON.stringify(ls));

  // Tentar navegação SPA: clicar em link "Contas" no menu
  console.log('→ Tentando clique no menu Contas...');
  const menuLink = page.locator('a[href*="contas"], a[href*="Contas"], nav a, aside a, [class*="menu"] a, [class*="nav"] a').filter({ hasText: /conta/i }).first();
  const menuVisible = await menuLink.isVisible().catch(() => false);
  console.log('→ Link contas no menu:', menuVisible);

  if (menuVisible) {
    await menuLink.click();
    await page.waitForTimeout(8000);
    console.log('→ URL após clique:', page.url());
  } else {
    // Fallback: goto direto
    console.log('→ Fallback: goto ' + baseUrl + '/contas');
    await page.goto(baseUrl + '/contas', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(10000);
    console.log('→ URL após goto:', page.url());
  }

  const urlContas = page.url();
  if (urlContas.includes('login')) {
    const snippet = await page.evaluate(() => document.body.innerText.substring(0, 400));
    console.log('→ Conteúdo página:', snippet.replace(/\n/g,'|'));
    await browser.close(); console.error('ERRO: redirecionado para login'); process.exit(1);
  }

  // Preview da página
  const preview = await page.evaluate(() => document.body.innerText.substring(0, 600));
  console.log('→ Prévia /contas:', preview.replace(/\n/g,' | '));

  // EXTRAIR SALDOS
  const saldos = await page.evaluate(() => {
    function parseBR(s) { return parseFloat(s.replace(/\./g,'').replace(',','.')); }
    const text = document.body.innerText;
    const banks = { 'Itaú':/Itaú\s*Unibanco[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/, 'BNB':/Banco\s*do\s*Nordeste[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/, 'Caixa':/Caixa\s*Econômica\s*Federal[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/, 'Sicoob':/Sicoob[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/, 'Santander':/Santander[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/ };
    const sgM = text.match(/Saldo\s*geral[\s\S]{0,40}?R\$\s*(-?[\d.]+,\d{2})/);
    const out = { saldoGeral: sgM ? parseBR(sgM[1]) : null };
    for (const [k,re] of Object.entries(banks)) { const m=text.match(re); out[k]=m?parseBR(m[1]):null; }
    const sum=(out['Itaú']||0)+(out['BNB']||0)+(out['Caixa']||0)+(out['Sicoob']||0)+(out['Santander']||0);
    if(out.saldoGeral===null) out.saldoGeral=Math.round(sum*100)/100;
    return out;
  });
  await browser.close();
  console.log('→ Saldos:', JSON.stringify(saldos));

  const nulls=Object.entries(saldos).filter(([,v])=>v===null).map(([k])=>k);
  if(nulls.length>0){console.error('ERRO: nulos:',nulls.join(','));process.exit(1);}
  const soma=(saldos['Itaú']||0)+(saldos['BNB']||0)+(saldos['Caixa']||0)+(saldos['Sicoob']||0)+(saldos['Santander']||0);
  if(Math.abs(soma-saldos.saldoGeral)>1){console.error('ERRO: integridade');process.exit(1);}
  console.log('✓ Integridade OK');

  const b=new Date(Date.now()-3*60*60*1000);
  const dt=String(b.getUTCDate()).padStart(2,'0')+'/'+String(b.getUTCMonth()+1).padStart(2,'0')+'/'+b.getUTCFullYear()+' às '+String(b.getUTCHours()).padStart(2,'0')+':'+String(b.getUTCMinutes()).padStart(2,'0');

  fs.writeFileSync('data.json',JSON.stringify({data_coleta:dt,saldo_geral:saldos.saldoGeral,receita_ytd:null,contas:[{nome:'Itaú Unibanco',saldo:saldos['Itaú']},{nome:'Santander',saldo:saldos['Santander']},{nome:'Banco do Nordeste',saldo:saldos['BNB']},{nome:'Caixa Econômica Federal',saldo:saldos['Caixa']},{nome:'Sicoob',saldo:saldos['Sicoob']}]},null,2),'utf8');
  console.log('✓ data.json');

  let html=fs.readFileSync('index.html','utf8');
  const arr=[saldos['Itaú'],saldos['BNB'],saldos['Caixa'],saldos['Sicoob'],saldos['Santander']];
  const dataStr='data:['+arr.map(v=>Number(v).toFixed(2)).join(',')+']';
  const idx=html.indexOf("labels:['Itaú','BNB','Caixa','Sicoob','Santander']");
  if(idx===-1){console.error('ERRO: labels');process.exit(1);}
  const ds=html.indexOf('data:[',idx),de=html.indexOf(']',ds)+1;
  html=html.substring(0,ds)+dataStr+html.substring(de);
  html=html.replace(/Atualizado \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/g,'Atualizado '+dt);
  html=html.replace(/Posição: \d{2}\/\d{2}\/\d{4}(?: às \d{2}:\d{2})?/g,'Posição: '+dt);
  fs.writeFileSync('index.html',html,'utf8');
  console.log('✓ index.html');
  console.log('✅ Atualizado —', dt, '| R$', saldos.saldoGeral);
})();
