// GTI Dashboard — Atualização automática de saldos v2
// Fix: detecta domínio correto após login (app.controlle.com ou beta.controlle.com)

const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  console.log('▶ Iniciando atualização do GTI Dashboard...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36'
  });
  const page = await context.newPage();

  console.log('→ Abrindo Controlle login...');
  await page.goto('https://beta.controlle.com/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  await page.locator('input[type="email"], input[name="email"]').first().fill(process.env.CONTROLLE_EMAIL);
  await page.locator('input[type="password"]').first().fill(process.env.CONTROLLE_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(6000);

  const urlAposLogin = page.url();
  console.log('→ URL após login:', urlAposLogin.replace(/accessToken=[^&]+/, 'accessToken=***'));

  if (urlAposLogin.includes('login')) {
    await browser.close();
    console.error('ERRO: Falha no login. Verifique credenciais nos Secrets do GitHub.');
    process.exit(1);
  }

  const baseUrl = new URL(urlAposLogin).origin;
  const contasUrl = baseUrl + '/contas';
  console.log('→ Domínio detectado:', baseUrl);
  console.log('→ Navegando para:', contasUrl);

  await page.goto(contasUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(7000);

  const urlContas = page.url();
  console.log('→ URL final em /contas:', urlContas);

  if (urlContas.includes('login')) {
    await browser.close();
    console.error('ERRO: Redirecionado para login em /contas. Sessão inválida.');
    process.exit(1);
  }

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
  console.log('→ Saldos:', JSON.stringify(saldos));

  const nulls = Object.entries(saldos).filter(([,v])=>v===null).map(([k])=>k);
  if (nulls.length > 0) { console.error('ERRO: Saldos nulos:', nulls.join(', ')); process.exit(1); }
  const soma = (saldos['Itaú']||0)+(saldos['BNB']||0)+(saldos['Caixa']||0)+(saldos['Sicoob']||0)+(saldos['Santander']||0);
  if (Math.abs(soma - saldos.saldoGeral) > 1) { console.error('ERRO: Integridade falhou. Soma='+soma.toFixed(2)+' Geral='+saldos.saldoGeral); process.exit(1); }
  console.log('✓ Integridade OK');

  const brasilia = new Date(Date.now() - 3*60*60*1000);
  const dd=String(brasilia.getUTCDate()).padStart(2,'0'), mm=String(brasilia.getUTCMonth()+1).padStart(2,'0');
  const aaaa=brasilia.getUTCFullYear(), hh=String(brasilia.getUTCHours()).padStart(2,'0'), min=String(brasilia.getUTCMinutes()).padStart(2,'0');
  const dt=dd+'/'+mm+'/'+aaaa+' às '+hh+':'+min;

  fs.writeFileSync('data.json', JSON.stringify({ data_coleta:dt, saldo_geral:saldos.saldoGeral, receita_ytd:null, contas:[
    {nome:'Itaú Unibanco',saldo:saldos['Itaú']},{nome:'Santander',saldo:saldos['Santander']},
    {nome:'Banco do Nordeste',saldo:saldos['BNB']},{nome:'Caixa Econômica Federal',saldo:saldos['Caixa']},
    {nome:'Sicoob',saldo:saldos['Sicoob']}
  ]},null,2),'utf8');
  console.log('✓ data.json atualizado');

  let html = fs.readFileSync('index.html','utf8');
  const arr=[saldos['Itaú'],saldos['BNB'],saldos['Caixa'],saldos['Sicoob'],saldos['Santander']];
  const dataStr='data:['+arr.map(v=>Number(v).toFixed(2)).join(',')+']';
  const labelsKey="labels:['Itaú','BNB','Caixa','Sicoob','Santander']";
  const idx=html.indexOf(labelsKey);
  if(idx===-1){console.error('ERRO: labels não encontrados');process.exit(1);}
  const ds=html.indexOf('data:[',idx), de=html.indexOf(']',ds)+1;
  console.log('✓ Chart:', html.substring(ds,de), '→', dataStr);
  html=html.substring(0,ds)+dataStr+html.substring(de);
  html=html.replace(/Atualizado \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/g,'Atualizado '+dt);
  html=html.replace(/Posição: \d{2}\/\d{2}\/\d{4}(?: às \d{2}:\d{2})?/g,'Posição: '+dt);
  fs.writeFileSync('index.html',html,'utf8');
  console.log('✓ index.html atualizado');

  console.log('');
  console.log('✅ GTI Dashboard atualizado —', dt);
  console.log('   Saldo Geral: R$', saldos.saldoGeral);
  console.log('   Itaú:', saldos['Itaú'], '| BNB:', saldos['BNB'], '| Caixa:', saldos['Caixa'], '| Sicoob:', saldos['Sicoob'], '| Santander:', saldos['Santander']);
})();
