/**
 * GTI Dashboard — Atualização Diária Automática
 * Roda via GitHub Actions: sem computador, sem custo.
 */

import { io } from 'socket.io-client';
import { appendFileSync, writeFileSync } from 'fs';

const REFRESH_TOKEN = process.env.CONTROLLE_REFRESH_TOKEN;
const GH_TOKEN      = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const REPO_OWNER    = 'nilzonspinola-lang';
const REPO_NAME     = 'gti-dashboard';
const API_BASE      = 'https://controlle-api-prod.controlle.com';
const COMPANY_ID    = 105337;
const COMPANY_UUID  = 'c2712324-36fe-44d1-a466-afa0cddc0fcb';

// ── 1. RENOVAR TOKEN ──────────────────────────────────────────────────────────
async function renovarToken() {
  const endpoints = ['/auth/refresh', '/auth/refresh-token', '/sessions/refresh', '/users/refresh-token'];
  for (const ep of endpoints) {
    try {
      const r = await fetch(API_BASE + ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: REFRESH_TOKEN }),
      });
      if (r.ok) {
        const data = await r.json();
        const token = data.accessToken || data.access_token || data.token;
        if (token) {
          console.log(`✅ Token renovado via ${ep}`);
          // Captura novo refreshToken se a API fizer rotação de tokens
          const novoRefresh = data.refreshToken || data.refresh_token;
          if (novoRefresh && novoRefresh !== REFRESH_TOKEN) {
            console.log('🔄 Novo refreshToken detectado — será salvo automaticamente no GitHub Secrets');
            const outputFile = process.env.GITHUB_OUTPUT;
            if (outputFile) {
              appendFileSync(outputFile, `novo_refresh_token=${novoRefresh}\n`);
            }
            try { writeFileSync('/tmp/novo_refresh_token.txt', novoRefresh); } catch (_) {}
          } else {
            console.log('ℹ️  API não retornou novo refreshToken (sem rotação de tokens)');
          }
          return token;
        }
      }
    } catch (e) { /* tenta próximo */ }
  }
  throw new Error('Não foi possível renovar o token.');
}

// ── 2. BUSCAR SALDOS VIA SOCKET.IO ────────────────────────────────────────────
async function buscarSaldos(accessToken) {
  return new Promise((resolve) => {
    const saldos = { saldo_total: null, contas: [], raw_events: [] };
    let resolvido = false;

    const socket = io(API_BASE, {
      auth: { token: accessToken },
      transports: ['polling', 'websocket'],
      reconnection: false,
      timeout: 15000,
      extraHeaders: { Authorization: `Bearer ${accessToken}` },
    });

    const finalizar = () => {
      if (!resolvido) { resolvido = true; socket.disconnect(); resolve(saldos); }
    };

    const timer = setTimeout(finalizar, 20000);

    socket.on('connect', () => {
      console.log('🔌 Socket.IO conectado, id:', socket.id);
      socket.emit('generalBalance', { companyId: COMPANY_ID });
      socket.emit('getGeneralBalance', { companyId: COMPANY_ID, companyUuid: COMPANY_UUID });
      socket.emit('dashboard', { companyId: COMPANY_ID });
      socket.emit('getAccounts', { companyId: COMPANY_ID });
    });

    socket.on('connect_error', (err) => {
      console.warn('⚠️  Socket.IO erro:', err.message);
      clearTimeout(timer); finalizar();
    });

    socket.onAny((eventName, ...args) => {
      const payload = JSON.stringify(args);
      console.log(`📨 Evento "${eventName}":`, payload.substring(0, 200));
      saldos.raw_events.push({ eventName, payload: payload.substring(0, 500) });

      try {
        const data = args[0];
        if (!data) return;

        const gb = data?.balances?.generalBalance ?? data?.generalBalance ?? data?.balance;
        if (typeof gb === 'number' && saldos.saldo_total === null) {
          saldos.saldo_total = gb / 100;
          console.log(`💰 Saldo geral: R$ ${saldos.saldo_total.toFixed(2)}`);
        }

        const contas = data?.accounts ?? data?.data ?? (Array.isArray(data) ? data : null);
        if (Array.isArray(contas) && contas.length > 0 && contas[0]?.descriptionAccount) {
          saldos.contas = contas
            .filter(c => c.status === 1 && !c.disabled)
            .map(c => ({ nome: c.descriptionAccount, saldo: (c.balance ?? 0) / 100 }));
          console.log(`🏦 Contas: ${saldos.contas.length}`);
          if (saldos.saldo_total === null)
            saldos.saldo_total = saldos.contas.reduce((s, c) => s + c.saldo, 0);
          clearTimeout(timer);
          setTimeout(finalizar, 1000);
        }
      } catch (e) { /* ignora */ }
    });
  });
}

// ── 3. BUSCAR HTML DO GITHUB ──────────────────────────────────────────────────
async function buscarHtml() {
  const r = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/index.html`,
    { headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
  );
  const d = await r.json();
  const bytes = Uint8Array.from(atob(d.content.replace(/\n/g, '')), c => c.charCodeAt(0));
  return { html: new TextDecoder('utf-8').decode(bytes), sha: d.sha };
}

// ── 4. APLICAR ATUALIZAÇÕES ───────────────────────────────────────────────────
function atualizarHtml(html, saldos) {
  const hoje  = new Date();
  const dd    = String(hoje.getUTCDate()).padStart(2, '0');
  const mm    = String(hoje.getUTCMonth() + 1).padStart(2, '0');
  const aaaa  = hoje.getUTCFullYear();
  const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const mesNome = meses[hoje.getUTCMonth()];
  const d7    = new Date(hoje); d7.setUTCDate(d7.getUTCDate() - 6);
  const d7dia = String(d7.getUTCDate()).padStart(2, '0');
  const d7mes = meses[d7.getUTCMonth()];

  let h = html;

  const countTs = (h.match(/Atualizado \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/g) || []).length;
  h = h.replace(/Atualizado \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/g, `Atualizado ${dd}/${mm}/${aaaa} às 07:52`);
  console.log(`🕐 Timestamps atualizados: ${countTs}`);

  h = h.replace(/Posi[çc][aã]o: \d{2}\/\d{2}\/\d{4}/g, `Posição: ${dd}/${mm}/${aaaa}`);

  h = h.replace(/\d{1,2} a \d{1,2} \w{3}\/\d{4}/g, `${d7dia} a ${dd} ${mesNome}/${aaaa}`);
  h = h.replace(/\d{1,2}-\d{1,2}\/[a-z]{3}\/\d{4}/gi, `${d7dia}-${dd}/${mesNome.toLowerCase()}/${aaaa}`);

  if (saldos.contas.length >= 5) {
    const mapa = { 'itaú':0, 'ita':0, 'nordeste':1, 'bnb':1, 'caixa':2, 'sicoob':3, 'santander':4 };
    const vals = [0, 0, 0, 0, 0];
    for (const conta of saldos.contas) {
      const nome = conta.nome.toLowerCase();
      for (const [key, idx] of Object.entries(mapa))
        if (nome.includes(key)) { vals[idx] = conta.saldo; break; }
    }
    const novosDados = vals.join(',');
    h = h.replace(/(\[)([\-\d.]+,[\-\d.]+,[\-\d.]+,[\-\d.]+,[\-\d.]+)(\])/g,
      (match, pre, dados, post) => {
        const nums = dados.split(',').map(Number);
        return nums.some(n => Math.abs(n) > 100 && Math.abs(n) < 10_000_000)
          ? `${pre}${novosDados}${post}` : match;
      });
    console.log(`💹 Dados do gráfico: [${novosDados}]`);
  }

  return h;
}

// ── 5. PUBLICAR NO GITHUB ─────────────────────────────────────────────────────
async function publicarHtml(html, sha) {
  const hoje = new Date();
  const dd = String(hoje.getUTCDate()).padStart(2,'0');
  const mm = String(hoje.getUTCMonth()+1).padStart(2,'0');
  const aaaa = hoje.getUTCFullYear();

  const r = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/index.html`,
    {
      method: 'PUT',
      headers: { Authorization: `token ${GH_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github.v3+json' },
      body: JSON.stringify({
        message: `chore: atualiza dashboard ${dd}/${mm}/${aaaa} 07:52`,
        content: btoa(unescape(encodeURIComponent(html))),
        sha, branch: 'main',
      }),
    }
  );
  const d = await r.json();
  if (!r.ok) throw new Error(`GitHub API ${r.status}: ${JSON.stringify(d)}`);
  console.log(`✅ Publicado! Commit: ${d.commit?.sha?.substring(0,8)}`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 GTI Dashboard — iniciando atualização...\n');
  if (!REFRESH_TOKEN) throw new Error('CONTROLLE_REFRESH_TOKEN não definido');
  if (!GH_TOKEN)      throw new Error('GH_TOKEN não definido');

  let accessToken;
  try { accessToken = await renovarToken(); }
  catch (e) { console.warn('⚠️  Sem token Controlle:', e.message); }

  let saldos = { saldo_total: null, contas: [] };
  if (accessToken) {
    try { saldos = await buscarSaldos(accessToken); }
    catch (e) { console.warn('⚠️  Sem saldos:', e.message); }
  }

  console.log('\n📥 Buscando HTML atual...');
  const { html, sha } = await buscarHtml();

  console.log('✏️  Aplicando atualizações...');
  const htmlAtualizado = atualizarHtml(html, saldos);

  console.log('📤 Publicando...');
  await publicarHtml(htmlAtualizado, sha);

  console.log('\n🎉 Concluído!');
}

main().catch(e => { console.error('❌ Erro fatal:', e.message); process.exit(1); });
