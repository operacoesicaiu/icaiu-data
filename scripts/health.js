const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publicReason(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'tempo limite excedido';
  return 'falha de comunicação';
}

async function request(url, options = {}, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const attempts = dependencies.attempts || DEFAULT_ATTEMPTS;
  const timeoutMs = dependencies.timeoutMs || DEFAULT_TIMEOUT_MS;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      if (response.ok) return response;

      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === attempts) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error;
      if (attempt === attempts || /^HTTP (?!408|429|5\d\d)/.test(error.message || '')) throw error;
    } finally {
      clearTimeout(timer);
    }

    await sleep(250 * 2 ** (attempt - 1));
  }

  throw lastError || new Error('request failed');
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'data-automation-health-monitor',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubJson(repo, resource, token, dependencies = {}) {
  const response = await request(
    `https://api.github.com/repos/${repo}${resource}`,
    { headers: githubHeaders(token) },
    dependencies,
  );
  return response.json();
}

function validateConfig(config) {
  if (!config || typeof config.company !== 'string' || !config.company.trim()) {
    throw new Error('Configuração de observabilidade sem empresa');
  }
  if (!Array.isArray(config.workflows) || config.workflows.length === 0) {
    throw new Error('Configuração de observabilidade sem workflows');
  }

  for (const workflow of config.workflows) {
    if (!workflow?.file || !workflow?.name || !Number.isFinite(workflow.maxAgeHours)) {
      throw new Error('Workflow inválido na configuração de observabilidade');
    }
  }
  return config;
}

function loadConfig(file = process.env.WORKFLOW_HEALTH_CONFIG || '.github/workflow-health.json') {
  return validateConfig(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
}

function ageHours(date, now = new Date()) {
  return (now.getTime() - new Date(date).getTime()) / 3_600_000;
}

async function checkWorkflow(repo, branch, workflow, token, dependencies = {}) {
  const encodedFile = encodeURIComponent(workflow.file);
  const metadata = await githubJson(repo, `/actions/workflows/${encodedFile}`, token, dependencies);

  if (metadata.state !== 'active') {
    return { name: workflow.name, healthy: false, reason: `estado ${metadata.state || 'desconhecido'}` };
  }

  const query = new URLSearchParams({ branch, per_page: '10' });
  const runs = await githubJson(
    repo,
    `/actions/workflows/${encodedFile}/runs?${query}`,
    token,
    dependencies,
  );
  const completed = Array.isArray(runs.workflow_runs)
    ? runs.workflow_runs.find((run) => run.status === 'completed')
    : null;

  if (!completed) return { name: workflow.name, healthy: false, reason: 'sem execução concluída' };

  const startedAt = completed.run_started_at || completed.created_at;
  const elapsed = ageHours(startedAt, dependencies.now || new Date());
  const result = {
    name: workflow.name,
    url: completed.html_url,
    ageHours: elapsed,
    conclusion: completed.conclusion,
  };

  if (completed.conclusion !== 'success') {
    return { ...result, healthy: false, reason: `última execução ${completed.conclusion || 'sem conclusão'}` };
  }
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > workflow.maxAgeHours) {
    return { ...result, healthy: false, reason: `último sucesso há ${Math.max(0, elapsed).toFixed(1)}h` };
  }
  return { ...result, healthy: true };
}

function healthchecksUrl(base, suffix) {
  const url = new URL(base);
  if (suffix) url.pathname = `${url.pathname.replace(/\/$/, '')}/${suffix}`;
  return url.toString();
}

async function pingHealthchecks(base, suffix, dependencies = {}) {
  if (!base) return false;
  await request(healthchecksUrl(base, suffix), { method: 'POST' }, dependencies);
  return true;
}

async function sendDiscord(webhook, content, dependencies = {}) {
  if (!webhook) return false;
  await request(
    webhook,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 1_900), allowed_mentions: { parse: [] } }),
    },
    dependencies,
  );
  return true;
}

function issueMessage(company, repo, issues) {
  const lines = issues.map((item) => {
    const link = item.url ? ` — ${item.url}` : '';
    return `• ${item.name}: ${item.reason}${link}`;
  });
  return [`🚨 ${company} — automação requer intervenção`, `Repositório: ${repo}`, ...lines].join('\n');
}

async function writeSummary(title, results) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = [`## ${title}`, '', '| Workflow | Estado | Idade |', '|---|---:|---:|'];
  for (const result of results) {
    const state = result.healthy ? '✅ saudável' : `❌ ${result.reason}`;
    const age = Number.isFinite(result.ageHours) ? `${result.ageHours.toFixed(1)}h` : '—';
    lines.push(`| ${result.name} | ${state} | ${age} |`);
  }
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

async function runWatchdog(env = process.env, dependencies = {}) {
  const config = dependencies.config || loadConfig(env.WORKFLOW_HEALTH_CONFIG);
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_TOKEN) {
    throw new Error('Ambiente do GitHub incompleto para observabilidade');
  }

  try {
    await pingHealthchecks(env.HEALTHCHECKS_PING_URL, 'start', dependencies);
  } catch (error) {
    console.warn(`Healthchecks indisponível no início: ${publicReason(error)}`);
  }

  const results = [];
  for (const workflow of config.workflows) {
    try {
      results.push(
        await checkWorkflow(
          env.GITHUB_REPOSITORY,
          config.branch || 'main',
          workflow,
          env.GITHUB_TOKEN,
          dependencies,
        ),
      );
    } catch (error) {
      results.push({ name: workflow.name, healthy: false, reason: publicReason(error) });
    }
  }

  const issues = results.filter((result) => !result.healthy);
  await writeSummary(`${config.company} — saúde das automações`, results);

  if (issues.length > 0) {
    const message = issueMessage(config.company, env.GITHUB_REPOSITORY, issues);
    try {
      const sent = await sendDiscord(env.DISCORD_WEBHOOK_URL, message, dependencies);
      if (!sent) console.warn('DISCORD_WEBHOOK_URL não configurado; alerta externo não enviado');
    } catch (error) {
      console.warn(`Discord indisponível: ${publicReason(error)}`);
    }
    try {
      await pingHealthchecks(env.HEALTHCHECKS_PING_URL, 'fail', dependencies);
    } catch (error) {
      console.warn(`Healthchecks indisponível na falha: ${publicReason(error)}`);
    }
    throw new Error(`${issues.length} automação(ões) requer(em) intervenção`);
  }

  try {
    const pinged = await pingHealthchecks(env.HEALTHCHECKS_PING_URL, '', dependencies);
    if (!pinged) console.warn('HEALTHCHECKS_PING_URL não configurado; dead-man externo inativo');
  } catch (error) {
    console.warn(`Healthchecks indisponível no sucesso: ${publicReason(error)}`);
  }
  console.log(`${results.length} automações saudáveis`);
  return results;
}

async function runCompletionAlert(env = process.env, dependencies = {}) {
  const event = dependencies.event || JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const run = event.workflow_run;
  if (!run || run.conclusion === 'success') return false;

  const company = env.COMPANY_NAME || 'Automação';
  const message = issueMessage(company, env.GITHUB_REPOSITORY || 'repositório', [
    { name: run.name || 'workflow', reason: `execução ${run.conclusion || 'sem conclusão'}`, url: run.html_url },
  ]);

  try {
    const sent = await sendDiscord(env.DISCORD_WEBHOOK_URL, message, dependencies);
    if (!sent) console.warn('DISCORD_WEBHOOK_URL não configurado; alerta externo não enviado');
  } catch (error) {
    console.warn(`Discord indisponível: ${publicReason(error)}`);
  }
  throw new Error('Workflow de produção não concluiu com sucesso');
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'watchdog') return runWatchdog();
  if (mode === 'completion') return runCompletionAlert();
  throw new Error('Use: node scripts/health.js <watchdog|completion>');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || 'Falha na observabilidade');
    process.exitCode = 1;
  });
}

module.exports = {
  ageHours,
  checkWorkflow,
  healthchecksUrl,
  issueMessage,
  loadConfig,
  runCompletionAlert,
  runWatchdog,
  sendDiscord,
  validateConfig,
};
