// GTI Dashboard v6 — login beta, accessToken passado para /contas
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  console.log('▶ GTI Dashboard v6');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' });
  const page = await context.newPage();

  // LOGIN em beta.controlle.com (tem o formulário real)
  console.log('→ Login em beta.controlle.com/login...');
  await page.goto('https://beta.controlle.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const campos = await page.evaluate(() => [...document.querySelectorAll('input')].map(i=>i.type+'|'+i.name).join(', '));
  console.log('→ Campos encontrados:', campos);

  await page.locator('input[type="email"], input[name="email"]').first().fill(process.env.CONTROLLE_EMAIL);
  await page.locator('input[type="password"]').first().fill(process.env.CONTROLLE_PASSWORD);
  await page.locator('button[type="submit"]').first().click();

  try { await page.waitForURL(u => !u.includes('login'), { timeout: 20000 }); } catch(e) { console.log('timeout redirect:', page.url()); }
  await page.waitForTimeout(6000);

  const urlDash = page.url();
  console.log('→ URL dashboard:', urlDash.replace(/accessToken=[^&\s]+/g, 'accessToken=***'));
  if (urlDash.includes('login')) { await browser.close(); console.error('ERRO: falha no login'); process.exit(1); }

  // Extrair accessToken da URL
  const urlObj = new URL(urlDash);
  const accessToken = urlObj.searchParams.get('accessToken');
  const baseUrl = urlObj.origin;
  console.log('→ baseUrl:', baseUrl, '| token encontrado:', accessToken ? 'sim' : 'não');

  // Aguardar dashboard inicializar completamente
  await page.waitForTimeout(5000);
  const dashContent = await page.evaluate(() => document.body.innerText.substring(0, 200));
  console.log('→ Dashboard:', dashContent.replace(/\n/g, '|'));

  // Navegar para /contas passando accessToken na URL (se disponível)
  const contasUrl = accessToken
    ? baseUrl + '/contas?accessToken=' + accessToken
    : baseUrl + '/contas';
  console.log('→ Navegando para:', contasUrl.replace(/accessToken=[^&\s]+/, 'accessToken=***'));

  await page.goto(contasUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(10000);

  const urlContas = page.url();
  console.log('→ URL /contas final:', urlContas);

  if (urlContas.includes('login')) {
    const txt = await page.evaluate(() => document.body.innerText.substring(0, 300));
    console.log('→ Conteúdo:', txt.replace(/\n/g,'|'));
    await browser.close(); console.error('ERRO: redirect login'); process.exit(1);
  }

  const preview = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('→ Conteúdo /contas:', preview.replace(/\n/g,' | '));

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
  if(Math.abs(soma-saldos.saldoGeral)>1){console.error('ERRO: integridade. soma='+soma+' geral='+saldos.saldoGeral);process.exit(1);}
  console.log('✓ Integridade OK');

  const b=new Date(Date.now()-3*60*60*1000);
  const dt=String(b.getUTCDate()).padStart(2,'0')+'/'+String(b.getUTCMonth()+1).padStart(2,'0')+'/'+b.getUTCFullYear()+' às '+String(b.getUTCHours()).padStart(2,'0')+':'+String(b.getUTCMinutes()).padStart(2,'0');

  fs.writeFileSync('data.json',JSON.stringify({data_coleta:dt,saldo_geral:saldos.saldoGeral,receita_ytd:null,contas:[{nome:'Itaú Unibanco',saldo:saldos['Itaú']},{nome:'Santander',saldo:saldos['Santander']},{nome:'Banco do Nordeste',saldo:saldos['BNB']},{nome:'Caixa Econômica Federal',saldo:saldos['Caixa']},{nome:'Sicoob',saldo:saldos['Sicoob']}]},null,2),'utf8');
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
  console.log('✅', dt, '| R$', saldos.saldoGeral);
})();
