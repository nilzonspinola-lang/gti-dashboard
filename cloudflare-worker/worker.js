/**
 * GTI Dashboard — Agente Robô (Cloudflare Worker)
 *
 * Responsabilidades:
 * 1. Fiscaliza a cada hora se o dashboard foi atualizado hoje
 * 2. Dispara o workflow do GitHub se necessário
 * 3. Envia alerta por e-mail se tudo falhar
 *
 * Variáveis de ambiente (Cloudflare Dashboard → Workers → Settings → Variables):
 *   GITHUB_TOKEN     — Fine-grained PAT SEM expiração (permissões: Actions:write, Contents:read)
 *   GITHUB_REPO      — nilzonspinola-lang/gti-dashboard
 *   WORKFLOW_ID      — daily-update.yml
 *   ALERT_EMAIL_TO   — e-mail destino dos alertas
 *   RESEND_API_KEY   — chave da API Resend
 *
 * IMPORTANTE — token sem expiração:
 *   github.com → Settings → Developer settings → Personal access tokens
 *   → Fine-grained tokens → Generate new token
 *   → Expiration: "No expiration"
 *   → Repository: gti-dashboard
 *   → Permissions: Actions (Read & Write) + Contents (Read-only)
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

// ─── Verificar se dashboard está atualizado ───────────────────────────────────
// Usa API GitHub (sem cache CDN) — sempre retorna dados frescos
async function checkDashboard(env) {
  try {
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
    const raw  = atob(envelope.content.replace(/\n/g, ''));
    const data = JSON.parse(raw);

    const lastUpdate = (data.data_coleta || '').substring(0, 10);
    const today      = todayBrasilia();
    return { ok: lastUpdate === today, lastUpdate, today, saldoGeral: data.saldo_geral };
  } catch (err) {
    return { ok: false, lastUpdate: 'erro', today: todayBrasilia(), error: err.message };
  }
}

// ─── Disparar workflow GitHub ─────────────────────────────────────────────────
async function dispatchWorkflow(env, workflowId) {
  const id  = workflowId || env.WORKFLOW_ID;
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${id}/dispatches`;
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

// ─── Validar token GitHub ─────────────────────────────────────────────────────
async function validateToken(env) {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization':        `Bearer ${env.GITHUB_TOKEN}`,
        'Accept':               'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }
    });
    if (res.status === 401) return { valid: false, reason: 'Token inválido ou expirado (HTTP 401)' };
    if (res.status === 403) return { valid: false, reason: 'Token sem permissão (HTTP 403) — verifique escopo Actions:write' };
    if (!res.ok)            return { valid: false, reason: `HTTP ${res.status}` };
    const user = await res.json();
    return { valid: true, login: user.login };
  } catch (e) {
    return { valid: false, reason: e.message };
  }
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

  // 0. Valida token antes de qualquer ação
  const tokenCheck = await validateToken(env);
  log.push(`🔑 Token: ${tokenCheck.valid ? `✅ válido (${tokenCheck.login})` : `❌ ${tokenCheck.reason}`}`);

  if (!tokenCheck.valid) {
    // Token inválido — manda alerta imediatamente com instruções claras
    await sendAlert(env,
      '🔑 [GTI Dashboard] ATENÇÃO — Token do Robô expirado ou inválido!',
      `<h2>🔑 GTI Dashboard — Token Expirado</h2>
      <p>O Agente Robô <strong>não consegue agir</strong> porque o token do GitHub está inválido.</p>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Motivo:</b></td><td style="padding:8px;border:1px solid #ddd">${tokenCheck.reason}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Detectado em:</b></td><td style="padding:8px;border:1px solid #ddd">${stamp}</td></tr>
      </table>
      <br>
      <p>🔧 <b>Como corrigir (1 vez — token sem expiração):</b></p>
      <ol>
        <li>Acesse <a href="https://github.com/settings/personal-access-tokens">github.com → Settings → Developer settings → Fine-grained tokens</a></li>
        <li>Clique em <b>Generate new token</b></li>
        <li>Em <b>Expiration</b> selecione <b>"No expiration"</b></li>
        <li>Em Repository access: selecione <b>gti-dashboard</b></li>
        <li>Em Permissions: <b>Actions → Read & Write</b> + <b>Contents → Read-only</b></li>
        <li>Copie o token gerado (começa com <code>github_pat_</code>)</li>
        <li>Acesse <a href="https://dash.cloudflare.com">dash.cloudflare.com</a> → Workers → gti-dashboard-robo → Settings → Variables & Secrets</li>
        <li>Edite o secret <b>GITHUB_TOKEN</b> e cole o novo token</li>
      </ol>
      <p>✅ Após isso o Robô voltará a funcionar automaticamente — e nunca mais expirará.</p>
      <p>🔗 <a href="https://github.com/${env.GITHUB_REPO}/actions">Ver Actions no GitHub</a></p>`
    );
    return { status: 'token_invalid', reason: tokenCheck.reason, log };
  }

  // 1. Verifica status do dashboard
  const check = await checkDashboard(env);
  log.push(`📊 Dashboard: última="${check.lastUpdate}" | hoje="${check.today}"`);
  if (check.error) log.push(`⚠️ Erro na verificação: ${check.error}`);

  if (check.ok) {
    log.push(`✅ OK — Dashboard atualizado hoje. Nenhuma ação necessária.`);
    return { status: 'ok', log };
  }

  // 2. Dashboard desatualizado — tenta disparar daily-update
  log.push(`⚠️  Desatualizado! Disparando workflow...`);
  const dispatch = await dispatchWorkflow(env, 'daily-update.yml');
  log.push(`🚀 Dispatch daily-update: HTTP ${dispatch.status} — ${dispatch.ok ? '✅ Enviado' : '❌ Falhou'}`);

  if (!dispatch.ok) {
    // Tenta disparar o watchdog como fallback
    log.push(`🔁 Fallback: tentando disparar watchdog...`);
    const watchdog = await dispatchWorkflow(env, 'watchdog.yml');
    log.push(`🚀 Dispatch watchdog: HTTP ${watchdog.status} — ${watchdog.ok ? '✅ Enviado' : '❌ Falhou'}`);

    if (!watchdog.ok) {
      log.push(`🚨 CRÍTICO: Nenhum workflow pôde ser disparado!`);
      await sendAlert(env,
        '🚨 [GTI Dashboard] CRÍTICO — Robô não conseguiu disparar atualização!',
        `<h2>🚨 Alerta Crítico — GTI Dashboard</h2>
        <p>O Agente Robô detectou que o dashboard está desatualizado mas <strong>não conseguiu disparar nenhum workflow</strong>.</p>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;border:1px solid #ddd"><b>Última atualização:</b></td><td style="padding:8px;border:1px solid #ddd">${check.lastUpdate}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><b>Esperado:</b></td><td style="padding:8px;border:1px solid #ddd">${check.today}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><b>Horário:</b></td><td style="padding:8px;border:1px solid #ddd">${stamp}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><b>Erro dispatch:</b></td><td style="padding:8px;border:1px solid #ddd">HTTP ${dispatch.status}</td></tr>
        </table>
        <p>🔧 <b>Verifique o token GITHUB_TOKEN no Cloudflare Worker.</b></p>
        <p>🔗 <a href="https://github.com/${env.GITHUB_REPO}/actions">Ver Actions no GitHub</a></p>
        <p>🌐 <a href="https://dashboard.gti-g.com">Ver Dashboard</a></p>`
      );
      return { status: 'critical', log };
    }
  }

  // 3. Aguarda 5 minutos e re-verifica
  log.push(`⏳ Aguardando 5 min para o workflow concluir...`);
  await new Promise(r => setTimeout(r, 300_000));

  const recheck = await checkDashboard(env);
  log.push(`🔍 Re-verificação: "${recheck.lastUpdate}" vs hoje "${recheck.today}"`);

  if (recheck.ok) {
    log.push(`✅ RESOLVIDO — Dashboard atualizado após ação emergencial!`);
    await sendAlert(env,
      '✅ [GTI Dashboard] Atualização emergencial concluída com sucesso',
      `<h2>✅ GTI Dashboard — Ação Emergencial Bem-sucedida</h2>
      <p>O Agente Robô detectou que o workflow principal havia falhado e tomou ação corretiva.</p>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Situação:</b></td><td style="padding:8px;border:1px solid #ddd">Dashboard desatualizado (${check.lastUpdate})</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Ação:</b></td><td style="padding:8px;border:1px solid #ddd">Workflow emergencial disparado</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Resultado:</b></td><td style="padding:8px;border:1px solid #ddd">✅ Atualizado com sucesso</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Saldo atual:</b></td><td style="padding:8px;border:1px solid #ddd">R$ ${(recheck.saldoGeral || 0).toLocaleString('pt-BR', {minimumFractionDigits:2})}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Horário:</b></td><td style="padding:8px;border:1px solid #ddd">${stamp}</td></tr>
      </table>
      <p>Nenhuma ação sua é necessária. 🤖</p>
      <p>🌐 <a href="https://dashboard.gti-g.com">Ver Dashboard</a></p>`
    );
    return { status: 'resolved', log };
  }

  // 4. Ainda falhou — alerta crítico final
  log.push(`🚨 CRÍTICO — Dashboard ainda desatualizado após ação emergencial!`);
  await sendAlert(env,
    '🚨 [GTI Dashboard] CRÍTICO — Dashboard desatualizado após tentativas!',
    `<h2>🚨 Alerta Crítico — GTI Dashboard</h2>
    <p>O Agente Robô tentou corrigir mas o dashboard <strong>continua desatualizado</strong>.</p>
    <table style="border-collapse:collapse;width:100%">
      <tr><td style="padding:8px;border:1px solid #ddd"><b>Última atualização:</b></td><td style="padding:8px;border:1px solid #ddd">${check.lastUpdate}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><b>Esperado:</b></td><td style="padding:8px;border:1px solid #ddd">${check.today}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><b>Horário:</b></td><td style="padding:8px;border:1px solid #ddd">${stamp}</td></tr>
    </table>
    <p>🔧 <b>Verifique:</b></p>
    <ul>
      <li>Secrets CONTROLLE_EMAIL e CONTROLLE_PASSWORD no GitHub</li>
      <li>Se a API do Controlle está acessível</li>
      <li>Logs: <a href="https://github.com/${env.GITHUB_REPO}/actions">GitHub Actions</a></li>
    </ul>
    <p>🌐 <a href="https://dashboard.gti-g.com">Ver Dashboard</a></p>`
  );
  return { status: 'critical_unresolved', log };
}

// ─── Entry point do Worker ────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    const result = await runAgent(env);
    console.log(JSON.stringify({ event: 'scheduled', ...result }));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      const check      = await checkDashboard(env);
      const tokenCheck = await validateToken(env);
      return new Response(JSON.stringify({
        agente:      '🤖 GTI Dashboard Robô',
        horario:     nowBrasilia(),
        token:       tokenCheck.valid ? `✅ válido (${tokenCheck.login})` : `❌ ${tokenCheck.reason}`,
        dashboard:   check.ok ? '✅ Atualizado' : '⚠️ Desatualizado',
        ultimaData:  check.lastUpdate,
        hoje:        check.today,
        saldoGeral:  check.saldoGeral,
        erro:        check.error || undefined,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'POST' && url.pathname === '/force') {
      const result = await runAgent(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const check      = await checkDashboard(env);
    const tokenCheck = await validateToken(env);
    const statusColor = check.ok ? '#00c853' : '#ff5252';
    const tokenColor  = tokenCheck.valid ? '#00c853' : '#ff5252';

    return new Response(`<!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="60">
        <title>🤖 GTI Robô — Status</title>
        <style>
          body { font-family: monospace; background: #0d1117; color: #e6edf3; padding: 40px; }
          h1   { color: #7CDA24; }
          .ok  { color: #00c853; font-weight: bold; }
          .err { color: #ff5252; font-weight: bold; }
          table { border-collapse: collapse; margin-top: 20px; }
          td, th { padding: 8px 16px; border: 1px solid #30363d; }
          th { background: #161b22; color: #7CDA24; }
          .note { margin-top: 20px; color: #8b949e; font-size: 12px; }
        </style>
      </head>
      <body>
        <h1>🤖 GTI Dashboard — Agente Robô</h1>
        <table>
          <tr><th>Campo</th><th>Valor</th></tr>
          <tr><td>Horário da verificação</td><td>${nowBrasilia()}</td></tr>
          <tr><td>Token GitHub</td><td style="color:${tokenColor}">${tokenCheck.valid ? `✅ Válido (${tokenCheck.login})` : `❌ ${tokenCheck.reason}`}</td></tr>
          <tr><td>Dashboard</td><td style="color:${statusColor}">${check.ok ? '✅ Atualizado hoje' : '⚠️ DESATUALIZADO'}</td></tr>
          <tr><td>Última atualização</td><td>${check.lastUpdate}</td></tr>
          <tr><td>Hoje esperado</td><td>${check.today}</td></tr>
          <tr><td>Saldo geral</td><td>R$ ${(check.saldoGeral || 0).toLocaleString('pt-BR', {minimumFractionDigits:2})}</td></tr>
        </table>
        <p class="note">Atualiza a cada 60s · <a href="/status" style="color:#7CDA24">Ver JSON</a> · <a href="/force" style="color:#7CDA24" onclick="fetch('/force',{method:'POST'});return false">Forçar execução</a></p>
      </body>
      </html>`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }
};
