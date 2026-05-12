/**
 * GTI Dashboard — Agente Robô (Cloudflare Worker)
 *
 * Responsabilidades:
 * 1. Fiscaliza a cada hora se o dashboard foi atualizado hoje
 * 2. Dispara o workflow do GitHub se necessário
 * 3. Envia alerta por e-mail se tudo falhar
 * 4. Registra log de cada verificação
 *
 * Variáveis de ambiente (configurar no Cloudflare Dashboard):
 *   GITHUB_TOKEN     — Token com permissão repo + workflow (ghp_...)
 *   GITHUB_REPO      — nilzonspinola-lang/gti-dashboard
 *   WORKFLOW_ID      — daily-update.yml
 *   ALERT_EMAIL_TO   — e-mail para alertas críticos
 *   RESEND_API_KEY   — chave da API Resend (e-mail gratuito)
 *
 * CORREÇÃO 2026-05-12: usa API GitHub em vez de raw.githubusercontent
 * para evitar cache CDN que atrasava detecção de atualização.
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

// ─── Verificar se dashboard está atualizado (via API GitHub — sem cache) ──────
async function checkDashboard(env) {
  try {
    // Usa a API REST do GitHub que sempre retorna dados frescos (sem CDN cache)
    // Retorna o arquivo em base64 dentro do campo "content"
    const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/data.json`;
    const res = await fetch(url, {
      headers: {
        'Authorization':        `Bearer ${env.GITHUB_TOKEN}`,
        'Accept':               'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Cache-Control':        'no-store',
      }
    });
    if (!res.ok) throw new Error(`API GitHub HTTP ${res.status}`);
    const envelope = await res.json();

    // Decodifica o conteúdo base64 → JSON real
    const raw  = atob(envelope.content.replace(/\n/g, ''));
    const data = JSON.parse(raw);

    const lastUpdate = (data.data_coleta || '').substring(0, 10); // DD/MM/YYYY
    const today      = todayBrasilia();
    return {
      ok:         lastUpdate === today,
      lastUpdate,
      today,
      saldoGeral: data.saldo_geral,
    };
  } catch (err) {
    return { ok: false, lastUpdate: 'erro', today: todayBrasilia(), error: err.message };
  }
}

// ─── Disparar workflow GitHub ─────────────────────────────────────────────────
async function dispatchWorkflow(env) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW_ID}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization':        `Bearer ${env.GITHUB_TOKEN}`,
      'Accept':               'application/vnd.github+json',
      'Content-Type':         'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  return { status: res.status, ok: res.status === 204 };
}

// ─── Enviar e-mail de alerta via Resend ───────────────────────────────────────
async function sendAlert(env, subject, html) {
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL_TO) return { skipped: true };
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
}

// ─── Lógica principal do Agente ───────────────────────────────────────────────
async function runAgent(env) {
  const log   = [];
  const stamp = nowBrasilia();
  log.push(`🤖 Agente GTI iniciado: ${stamp}`);

  // 1. Verifica status (via API GitHub — sempre fresco)
  const check = await checkDashboard(env);
  log.push(`📊 Dashboard: última atualização="${check.lastUpdate}" | hoje="${check.today}"`);
  if (check.error) log.push(`⚠️ Erro na verificação: ${check.error}`);

  if (check.ok) {
    log.push(`✅ OK — Dashboard atualizado hoje. Nenhuma ação necessária.`);
    return { status: 'ok', log };
  }

  // 2. Dashboard desatualizado — dispara workflow
  log.push(`⚠️  Desatualizado! Disparando workflow GitHub...`);
  const dispatch = await dispatchWorkflow(env);
  log.push(`🚀 Dispatch: HTTP ${dispatch.status} — ${dispatch.ok ? '✅ Enviado' : '❌ Falhou'}`);

  if (!dispatch.ok) {
    log.push(`🚨 CRÍTICO: Não conseguiu disparar o workflow!`);
    await sendAlert(env,
      '🚨 [GTI Dashboard] CRÍTICO — Robô não conseguiu disparar atualização!',
      `<h2>🚨 Alerta Crítico — GTI Dashboard</h2>
      <p>O Agente Robô detectou que o dashboard está desatualizado mas <strong>não conseguiu disparar o workflow</strong>.</p>
      <table>
        <tr><td><b>Última atualização:</b></td><td>${check.lastUpdate}</td></tr>
        <tr><td><b>Esperado:</b></td><td>${check.today}</td></tr>
        <tr><td><b>Horário:</b></td><td>${stamp}</td></tr>
        <tr><td><b>Erro:</b></td><td>HTTP ${dispatch.status} — Token pode ter expirado</td></tr>
      </table>
      <p>🔧 <b>Ação necessária:</b> Verifique o token GITHUB_TOKEN no Cloudflare Worker.</p>
      <p>🔗 <a href="https://github.com/${env.GITHUB_REPO}/actions">Ver Actions no GitHub</a></p>
      <p>🌐 <a href="https://dashboard.gti-g.com">Ver Dashboard</a></p>`
    );
    return { status: 'critical', log };
  }

  // 3. Aguarda 90s e verifica novamente
  log.push(`⏳ Aguardando 90s para o workflow concluir...`);
  await new Promise(r => setTimeout(r, 90_000));

  const recheck = await checkDashboard(env);
  log.push(`🔍 Re-verificação: "${recheck.lastUpdate}" vs hoje "${recheck.today}"`);

  if (recheck.ok) {
    log.push(`✅ RESOLVIDO — Dashboard atualizado após ação emergencial!`);
    await sendAlert(env,
      '✅ [GTI Dashboard] Atualização emergencial concluída com sucesso',
      `<h2>✅ GTI Dashboard — Ação Emergencial Bem-sucedida</h2>
      <p>O Agente Robô detectou que o workflow principal havia falhado e tomou ação corretiva.</p>
      <table>
        <tr><td><b>Situação detectada:</b></td><td>Dashboard desatualizado (${check.lastUpdate})</td></tr>
        <tr><td><b>Ação tomada:</b></td><td>Workflow emergencial disparado</td></tr>
        <tr><td><b>Resultado:</b></td><td>✅ Dashboard atualizado com sucesso</td></tr>
        <tr><td><b>Saldo atual:</b></td><td>R$ ${(recheck.saldoGeral || 0).toLocaleString('pt-BR', {minimumFractionDigits:2})}</td></tr>
        <tr><td><b>Horário:</b></td><td>${stamp}</td></tr>
      </table>
      <p>Nenhuma ação sua é necessária. 🤖</p>
      <p>🌐 <a href="https://dashboard.gti-g.com">Ver Dashboard</a></p>`
    );
    return { status: 'resolved', log };
  }

  // 4. Ainda falhou — alerta crítico final
  log.push(`🚨 CRÍTICO — Dashboard ainda desatualizado após ação emergencial!`);
  await sendAlert(env,
    '🚨 [GTI Dashboard] CRÍTICO — Falhou mesmo após ação emergencial!',
    `<h2>🚨 Alerta Crítico — GTI Dashboard</h2>
    <p>O Agente Robô tentou corrigir mas o dashboard <strong>continua desatualizado</strong>.</p>
    <table>
      <tr><td><b>Última atualização:</b></td><td>${check.lastUpdate}</td></tr>
      <tr><td><b>Esperado:</b></td><td>${check.today}</td></tr>
      <tr><td><b>Horário do alerta:</b></td><td>${stamp}</td></tr>
    </table>
    <p>🔧 <b>Verifique:</b></p>
    <ul>
      <li>Secrets CONTROLLE_EMAIL e CONTROLLE_PASSWORD no GitHub</li>
      <li>Se a API do Controlle está acessível</li>
      <li>Logs em: <a href="https://github.com/${env.GITHUB_REPO}/actions">GitHub Actions</a></li>
    </ul>
    <p>🌐 <a href="https://dashboard.gti-g.com">Ver Dashboard</a></p>`
  );
  return { status: 'critical_unresolved', log };
}

// ─── Entry point do Worker ────────────────────────────────────────────────────
export default {
  // Cron trigger — executa a cada hora entre 10:00 e 16:00 UTC (07:00–13:00 BRT)
  async scheduled(event, env, ctx) {
    const result = await runAgent(env);
    console.log(JSON.stringify({ event: 'scheduled', ...result }));
  },

  // HTTP trigger — permite chamar manualmente via URL
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // GET /status — retorna status atual sem agir
    if (url.pathname === '/status') {
      const check = await checkDashboard(env);
      return new Response(JSON.stringify({
        agente:      '🤖 GTI Dashboard Robô',
        horario:     nowBrasilia(),
        dashboard:   check.ok ? '✅ Atualizado' : '⚠️ Desatualizado',
        ultimaData:  check.lastUpdate,
        hoje:        check.today,
        saldoGeral:  check.saldoGeral,
        erro:        check.error || undefined,
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // POST /force — força execução do agente
    if (request.method === 'POST' && url.pathname === '/force') {
      const result = await runAgent(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Default — página de status simples
    const check = await checkDashboard(env);
    const statusColor = check.ok ? '#00c853' : '#ff5252';
    const statusIcon  = check.ok ? '✅' : '⚠️';
    return new Response(`<!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="60">
        <title>🤖 GTI Robô — Status</title>
        <style>
          body { font-family: monospace; background: #0d1117; color: #e6edf3; padding: 40px; }
          h1   { color: #7CDA24; }
          .status { font-size: 24px; color: ${statusColor}; font-weight: bold; }
          table { border-collapse: collapse; margin-top: 20px; }
          td, th { padding: 8px 16px; border: 1px solid #30363d; }
          th { background: #161b22; color: #7CDA24; }
          .note { margin-top: 20px; color: #8b949e; font-size: 12px; }
        </style>
      </head>
      <body>
        <h1>🤖 GTI Dashboard — Agente Robô</h1>
        <p class="status">${statusIcon} ${check.ok ? 'Dashboard atualizado hoje' : 'Dashboard DESATUALIZADO'}</p>
        <table>
          <tr><th>Campo</th><th>Valor</th></tr>
          <tr><td>Horário da verificação</td><td>${nowBrasilia()}</td></tr>
          <tr><td>Última atualização</td><td>${check.lastUpdate}</td></tr>
          <tr><td>Hoje esperado</td><td>${check.today}</td></tr>
          <tr><td>Saldo geral</td><td>R$ ${(check.saldoGeral || 0).toLocaleString('pt-BR', {minimumFractionDigits:2})}</td></tr>
        </table>
        <p class="note">Página atualiza automaticamente a cada 60s · <a href="/status" style="color:#7CDA24">Ver JSON</a></p>
      </body>
      </html>`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }
};
