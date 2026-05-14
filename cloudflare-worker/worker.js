/**
 * GTI Dashboard — Agente Robô (Cloudflare Worker)
 *
 * NOVA ARQUITETURA — Worker é APENAS monitor e alertador.
 * O dispatch de workflows agora é feito pelo próprio GitHub Actions
 * usando GITHUB_TOKEN nativo (nunca expira).
 *
 * Responsabilidades:
 * 1. Monitora a cada hora se o dashboard foi atualizado hoje
 * 2. Envia alerta se desatualizado (informativo — o watchdog.yml já age)
 * 3. Expõe /status para verificação manual
 *
 * Variáveis de ambiente (Cloudflare Dashboard → Workers → Settings → Variables):
 *   GITHUB_REPO      — nilzonspinola-lang/gti-dashboard
 *   RESEND_API_KEY   — chave da API Resend (para alertas)
 *   ALERT_EMAIL_TO   — e-mail destino dos alertas
 *
 * NÃO PRECISA MAIS DE:
 *   GITHUB_TOKEN     — REMOVIDO. Dispatch agora é nativo no GitHub Actions.
 *
 * Crons configurados (wrangler.toml):
 *   08:00, 10:00, 12:00, 14:00, 17:00 UTC (05h/07h/09h/11h/14h BRT)
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────
function nowBrasilia() {
  return new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function todayBrasilia() {
  return new Date().toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric'
  });
}

// ─── Verificar status do dashboard via API GitHub (sem cache CDN) ─────────────
async function checkDashboard(env) {
  try {
    const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/data.json`;
    const headers = {
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Cache-Control':        'no-store',
      'User-Agent':           'GTI-Dashboard-Robot/2.0',
    };
    // Adiciona token se disponível (melhora rate limit, mas não é obrigatório)
    if (env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
    const envelope = await res.json();
    const raw  = atob(envelope.content.replace(/\n/g, ''));
    const data = JSON.parse(raw);

    const lastUpdate = (data.data_coleta || '').substring(0, 10);
    const today      = todayBrasilia();
    return {
      ok: lastUpdate === today,
      lastUpdate,
      today,
      saldoGeral:  data.saldo_geral,
      receitaYtd:  data.receita_ytd,
      resultadoYtd: data.resultado_ytd,
    };
  } catch (err) {
    return { ok: false, lastUpdate: 'erro', today: todayBrasilia(), error: err.message };
  }
}

// ─── Enviar alerta via Resend ─────────────────────────────────────────────────
async function sendAlert(env, subject, html) {
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL_TO) return { skipped: true };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'GTI Robô <onboarding@resend.dev>',
        to:      [env.ALERT_EMAIL_TO],
        subject,
        html,
      }),
    });
    return { status: res.status, ok: res.ok };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── Lógica principal do Monitor ─────────────────────────────────────────────
async function runMonitor(env) {
  const log   = [];
  const stamp = nowBrasilia();
  log.push(`🤖 Monitor GTI iniciado: ${stamp}`);

  // Verifica status do dashboard
  const check = await checkDashboard(env);
  log.push(`📊 Dashboard: última="${check.lastUpdate}" | hoje="${check.today}"`);
  if (check.error) log.push(`⚠️ Erro na verificação: ${check.error}`);

  if (check.ok) {
    log.push(`✅ Dashboard atualizado hoje. Nenhuma ação necessária.`);
    return { status: 'ok', check, log };
  }

  // Dashboard desatualizado — apenas alerta (o watchdog.yml age automaticamente)
  log.push(`⚠️ Dashboard desatualizado! O watchdog.yml já está agendado para agir.`);

  // Envia alerta informativo (máximo 1× por dia — sem spam)
  const hourUTC = new Date().getUTCHours();

  // Alerta apenas no horário de monitoramento da manhã (antes do watchdog agir)
  // para evitar spam de emails quando o watchdog já está cuidando
  if (hourUTC <= 15) {
    await sendAlert(env,
      '⚠️ GTI Dashboard — Aguardando atualização automática',
      `<h2>⚠️ GTI Dashboard — Atualização em andamento</h2>
      <p>O Monitor detectou que o dashboard ainda não foi atualizado hoje.</p>
      <p><b>O sistema está agindo automaticamente</b> — o Watchdog do GitHub Actions
      irá atualizar o dashboard em breve. Nenhuma ação sua é necessária.</p>
      <table style="border-collapse:collapse;width:100%;font-family:sans-serif">
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Última atualização:</b></td><td style="padding:8px;border:1px solid #ddd">${check.lastUpdate}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Hoje esperado:</b></td><td style="padding:8px;border:1px solid #ddd">${check.today}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Detectado às:</b></td><td style="padding:8px;border:1px solid #ddd">${stamp}</td></tr>
      </table>
      <br>
      <p>🤖 O Watchdog automático irá corrigir isso entre 13h–19h BRT.</p>
      <p>🔗 <a href="https://github.com/${env.GITHUB_REPO}/actions">Acompanhar no GitHub Actions</a></p>
      <p>🌐 <a href="https://dashboard.gti-g.com">Ver Dashboard</a></p>`
    );
    log.push(`📧 Alerta informativo enviado.`);
  } else {
    log.push(`ℹ️ Alerta não enviado (já é tarde — watchdog está agindo).`);
  }

  return { status: 'outdated', check, log };
}

// ─── Entry point ──────────────────────────────────────────────────────────────
export default {
  // Executa nos crons configurados no wrangler.toml
  async scheduled(event, env, ctx) {
    const result = await runMonitor(env);
    console.log(JSON.stringify({ event: 'scheduled', ...result }));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── GET /status — JSON com estado atual ────────────────────────────────
    if (url.pathname === '/status') {
      const check = await checkDashboard(env);
      return new Response(JSON.stringify({
        agente:       '🤖 GTI Dashboard Monitor v2.0',
        arquitetura:  'Monitor apenas — dispatch via GitHub Actions nativo',
        horario:      nowBrasilia(),
        dashboard:    check.ok ? '✅ Atualizado hoje' : '⚠️ Desatualizado',
        ultimaData:   check.lastUpdate,
        hoje:         check.today,
        saldoGeral:   check.saldoGeral,
        receitaYtd:   check.receitaYtd,
        resultadoYtd: check.resultadoYtd,
        erro:         check.error || undefined,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // ── POST /force — força o monitor agora ───────────────────────────────
    if (request.method === 'POST' && url.pathname === '/force') {
      const result = await runMonitor(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // ── GET / — Página de status visual ───────────────────────────────────
    const check = await checkDashboard(env);
    const statusColor = check.ok ? '#00c853' : '#ff9800';

    const fmt = (v) => v != null
      ? Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
      : '—';

    return new Response(`<!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="60">
        <title>🤖 GTI Monitor — Status</title>
        <style>
          body { font-family: 'Segoe UI', monospace; background: #0d1117; color: #e6edf3; padding: 40px; max-width: 700px; margin: 0 auto; }
          h1   { color: #7CDA24; margin-bottom: 4px; }
          .sub { color: #8b949e; font-size: 13px; margin-bottom: 24px; }
          .ok  { color: #00c853; font-weight: bold; }
          .warn{ color: #ff9800; font-weight: bold; }
          .err { color: #ff5252; font-weight: bold; }
          table { border-collapse: collapse; width: 100%; margin-top: 16px; }
          td, th { padding: 10px 16px; border: 1px solid #30363d; font-size: 14px; }
          th { background: #161b22; color: #7CDA24; text-align: left; }
          .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: bold; }
          .badge-ok   { background: #0a3d0a; color: #00c853; }
          .badge-warn { background: #3d2800; color: #ff9800; }
          .arch { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-top: 24px; font-size: 13px; color: #8b949e; }
          .arch h3 { color: #7CDA24; margin: 0 0 8px 0; font-size: 14px; }
          .arch li { margin: 4px 0; }
          .note { margin-top: 20px; color: #8b949e; font-size: 12px; }
          a { color: #7CDA24; }
        </style>
      </head>
      <body>
        <h1>🤖 GTI Dashboard — Monitor</h1>
        <div class="sub">v2.0 · Arquitetura: Monitor-only · Dispatch via GitHub Actions nativo</div>

        <table>
          <tr><th colspan="2">Status atual</th></tr>
          <tr><td>Horário da verificação</td><td>${nowBrasilia()}</td></tr>
          <tr><td>Dashboard</td>
              <td><span class="badge ${check.ok ? 'badge-ok' : 'badge-warn'}">${check.ok ? '✅ Atualizado hoje' : '⚠️ Aguardando atualização'}</span></td></tr>
          <tr><td>Última atualização</td><td>${check.lastUpdate}</td></tr>
          <tr><td>Hoje esperado</td><td>${check.today}</td></tr>
          <tr><td>Saldo geral</td><td>R$ ${fmt(check.saldoGeral)}</td></tr>
          <tr><td>Receita YTD</td><td>R$ ${fmt(check.receitaYtd)}</td></tr>
          <tr><td>Resultado YTD</td><td>R$ ${fmt(check.resultadoYtd)}</td></tr>
        </table>

        <div class="arch">
          <h3>🏗️ Arquitetura de redundância (4 camadas)</h3>
          <ul>
            <li>🔵 Camada 0 — <b>Keep-alive</b>: 03:00 BRT (evita suspensão de schedules)</li>
            <li>🟢 Camada 1 — <b>Daily-update</b>: 06h–12h BRT (7 tentativas + self-heal)</li>
            <li>🟡 Camada 2 — <b>Self-heal</b>: redispara em caso de falha (GITHUB_TOKEN nativo)</li>
            <li>🔴 Camada 3 — <b>Watchdog</b>: 13h/15h/17h/19h BRT (GITHUB_TOKEN nativo)</li>
            <li>⚪ Camada 4 — <b>Monitor</b> (este Worker): monitora e alerta apenas</li>
          </ul>
        </div>

        <p class="note">
          Atualiza a cada 60s ·
          <a href="/status">JSON /status</a> ·
          <a href="https://github.com/${env.GITHUB_REPO}/actions" target="_blank">GitHub Actions</a> ·
          <a href="https://dashboard.gti-g.com" target="_blank">Dashboard GTI</a>
        </p>
      </body>
      </html>`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }
};
