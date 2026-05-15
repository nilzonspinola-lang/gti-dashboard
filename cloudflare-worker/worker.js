/**
 * GTI Dashboard — Agente Robô v3.0 (Cloudflare Worker)
 *
 * NOVA ARQUITETURA v3 — Worker é o MOTOR principal de disparo.
 * Os crons do Cloudflare são precisos ao minuto (SLA de infraestrutura).
 * O GitHub Actions schedule é não-determinístico (pode atrasar 5–30 min).
 *
 * Responsabilidades:
 * 1. A cada cron: verifica se o dashboard foi atualizado hoje
 * 2. Se NÃO foi: dispara o workflow daily-update.yml via GitHub API (force=true)
 * 3. Se JÁ foi: não faz nada (idempotente)
 * 4. Envia alerta por e-mail se precisou agir (via Resend)
 * 5. Expõe /status e /force para verificação e disparo manual
 *
 * Variáveis de ambiente — configurar no Cloudflare Dashboard:
 *   Workers → gti-dashboard-robo → Settings → Variables & Secrets
 *
 *   [vars] — não-secretas (já no wrangler.toml):
 *     GITHUB_REPO      — nilzonspinola-lang/gti-dashboard
 *
 *   [secrets] — via Cloudflare Dashboard ou deploy-worker.yml:
 *     GITHUB_PAT       — PAT com permissão actions:write (NOVO — motor principal)
 *     RESEND_API_KEY   — chave da API Resend (para alertas)
 *     ALERT_EMAIL_TO   — e-mail destino dos alertas
 *
 * Crons configurados (wrangler.toml) — precisos ao minuto:
 *   09:00 UTC → 06:00 BRT  (disparo matinal)
 *   11:00 UTC → 08:00 BRT
 *   13:00 UTC → 10:00 BRT
 *   15:00 UTC → 12:00 BRT
 *   17:00 UTC → 14:00 BRT  (watchdog tarde)
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
    const headers = {
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent':           'GTI-Dashboard-Robot/3.0',
    };
    // Usa PAT se disponível — evita rate limit de 60 req/h do anônimo
    if (env.GITHUB_PAT) headers['Authorization'] = `Bearer ${env.GITHUB_PAT}`;

    const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/data.json`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
    const envelope = await res.json();
    const raw  = atob(envelope.content.replace(/\n/g, ''));
    const data = JSON.parse(raw);

    const lastUpdate = (data.data_coleta || '').substring(0, 10);
    const today      = todayBrasilia();
    return {
      ok:           lastUpdate === today,
      lastUpdate,
      today,
      saldoGeral:   data.saldo_geral,
      receitaYtd:   data.receita_ytd,
      resultadoYtd: data.resultado_ytd,
    };
  } catch (err) {
    return { ok: false, lastUpdate: 'erro', today: todayBrasilia(), error: err.message };
  }
}

// ─── Disparar workflow via GitHub API ────────────────────────────────────────
async function dispatchWorkflow(env) {
  if (!env.GITHUB_PAT) {
    return { ok: false, error: 'GITHUB_PAT não configurado no Worker' };
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/daily-update.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization':        `Bearer ${env.GITHUB_PAT}`,
          'Accept':               'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type':         'application/json',
          'User-Agent':           'GTI-Dashboard-Robot/3.0',
        },
        body: JSON.stringify({ ref: 'main', inputs: { force: 'true' } }),
      }
    );
    // 204 = sucesso (GitHub não retorna body no dispatch)
    if (res.status === 204) return { ok: true, status: 204 };
    const body = await res.text();
    return { ok: false, status: res.status, body: body.substring(0, 200) };
  } catch (err) {
    return { ok: false, error: err.message };
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

// ─── Lógica principal ─────────────────────────────────────────────────────────
async function runMonitor(env, forcedByHuman = false) {
  const log   = [];
  const stamp = nowBrasilia();
  log.push(`🤖 GTI Monitor v3 iniciado: ${stamp}`);

  // 1. Verifica status atual
  const check = await checkDashboard(env);
  log.push(`📊 Última atualização: "${check.lastUpdate}" | Hoje: "${check.today}"`);
  if (check.error) log.push(`⚠️ Erro na verificação: ${check.error}`);

  // 2. Já atualizado hoje — nada a fazer
  if (check.ok && !forcedByHuman) {
    log.push(`✅ Dashboard já atualizado hoje. Nenhuma ação necessária.`);
    return { status: 'ok', check, log, dispatched: false };
  }

  // 3. Desatualizado (ou forçado) — dispara workflow via GitHub API
  const reason = forcedByHuman ? 'disparo manual' : 'dashboard desatualizado';
  log.push(`🚀 Disparando daily-update.yml via GitHub API (motivo: ${reason})...`);

  const dispatch = await dispatchWorkflow(env);
  log.push(dispatch.ok
    ? `✅ Workflow disparado com sucesso (HTTP 204).`
    : `❌ Falha no dispatch: ${dispatch.error || dispatch.body || dispatch.status}`
  );

  // 4. Alerta por e-mail se desatualizado (não se foi forçado manualmente)
  if (!check.ok && !forcedByHuman && dispatch.ok) {
    const alertResult = await sendAlert(env,
      '🚀 GTI Dashboard — Atualização disparada automaticamente',
      `<h2>🚀 GTI Dashboard — Atualização em andamento</h2>
      <p>O Robô detectou que o dashboard ainda não havia sido atualizado e <b>disparou a atualização automaticamente</b>.</p>
      <table style="border-collapse:collapse;width:100%;font-family:sans-serif">
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Última atualização:</b></td><td style="padding:8px;border:1px solid #ddd">${check.lastUpdate}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Detectado às:</b></td><td style="padding:8px;border:1px solid #ddd">${stamp}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Ação tomada:</b></td><td style="padding:8px;border:1px solid #ddd">✅ daily-update.yml disparado (force=true)</td></tr>
      </table>
      <br>
      <p>🔗 <a href="https://github.com/${env.GITHUB_REPO}/actions">Acompanhar no GitHub Actions</a></p>
      <p>🌐 <a href="https://dashboard.gti-g.com">Ver Dashboard GTI</a></p>`
    );
    log.push(`📧 Alerta enviado: ${JSON.stringify(alertResult)}`);
  }

  return {
    status:     check.ok ? 'ok' : 'dispatched',
    check,
    dispatch,
    log,
    dispatched: dispatch.ok,
  };
}

// ─── Entry point ──────────────────────────────────────────────────────────────
export default {
  // Cron — executa no horário exato configurado no wrangler.toml
  async scheduled(event, env, ctx) {
    const result = await runMonitor(env, false);
    console.log(JSON.stringify({ event: 'scheduled', cron: event.cron, ...result }));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── GET /status ────────────────────────────────────────────────────────
    if (url.pathname === '/status') {
      const check = await checkDashboard(env);
      return new Response(JSON.stringify({
        agente:       '🤖 GTI Dashboard Monitor v3.0',
        arquitetura:  'Cloudflare cron → GitHub API dispatch (motor principal)',
        horario:      nowBrasilia(),
        dashboard:    check.ok ? '✅ Atualizado hoje' : '⚠️ Desatualizado',
        ultimaData:   check.lastUpdate,
        hoje:         check.today,
        saldoGeral:   check.saldoGeral,
        receitaYtd:   check.receitaYtd,
        resultadoYtd: check.resultadoYtd,
        githubPat:    env.GITHUB_PAT ? '✅ configurado' : '❌ ausente',
        erro:         check.error || undefined,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // ── POST /force — dispara workflow imediatamente ───────────────────────
    if (request.method === 'POST' && url.pathname === '/force') {
      const result = await runMonitor(env, true);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // ── GET / — Página de status visual ───────────────────────────────────
    const check = await checkDashboard(env);
    const fmt = (v) => v != null
      ? Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
      : '—';
    const patOk = !!env.GITHUB_PAT;

    return new Response(`<!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="60">
        <title>🤖 GTI Monitor — Status</title>
        <style>
          body { font-family: 'Segoe UI', monospace; background: #0d1117; color: #e6edf3; padding: 40px; max-width: 720px; margin: 0 auto; }
          h1   { color: #7CDA24; margin-bottom: 4px; }
          .sub { color: #8b949e; font-size: 13px; margin-bottom: 24px; }
          table { border-collapse: collapse; width: 100%; margin-top: 16px; }
          td, th { padding: 10px 16px; border: 1px solid #30363d; font-size: 14px; }
          th { background: #161b22; color: #7CDA24; text-align: left; }
          .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: bold; }
          .badge-ok   { background: #0a3d0a; color: #00c853; }
          .badge-warn { background: #3d2800; color: #ff9800; }
          .badge-err  { background: #3d0a0a; color: #ff5252; }
          .arch { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-top: 24px; font-size: 13px; color: #8b949e; }
          .arch h3 { color: #7CDA24; margin: 0 0 8px 0; font-size: 14px; }
          .arch li { margin: 4px 0; }
          .note { margin-top: 20px; color: #8b949e; font-size: 12px; }
          a { color: #7CDA24; }
        </style>
      </head>
      <body>
        <h1>🤖 GTI Dashboard — Monitor v3.0</h1>
        <div class="sub">Motor principal: Cloudflare cron → GitHub API dispatch</div>

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
          <tr><td>GITHUB_PAT</td>
              <td><span class="badge ${patOk ? 'badge-ok' : 'badge-err'}">${patOk ? '✅ configurado' : '❌ ausente — Worker não consegue disparar'}</span></td></tr>
        </table>

        <div class="arch">
          <h3>🏗️ Arquitetura v3 — Cloudflare como motor principal</h3>
          <ul>
            <li>🔵 <b>Cloudflare crons</b> (precisos): 06h/08h/10h/12h/14h BRT → disparam GitHub API diretamente</li>
            <li>🟢 <b>daily-update.yml</b>: executa o script de coleta quando acionado</li>
            <li>🟡 <b>Self-heal</b>: em caso de falha, o Worker reage no próximo cron</li>
            <li>🔴 <b>GitHub schedules</b>: mantidos como backup (mesmo com atraso, eventual)</li>
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
