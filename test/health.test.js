const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkWorkflow,
  healthchecksUrl,
  runCompletionAlert,
  validateConfig,
} = require('../scripts/health');

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('valida a configuração sem aceitar workflow incompleto', () => {
  assert.throws(
    () => validateConfig({ company: 'Empresa', workflows: [{ file: 'job.yml' }] }),
    /Workflow inválido/,
  );
});

test('monta URLs de start e fail sem perder query string', () => {
  assert.equal(
    healthchecksUrl('https://hc-ping.com/uuid?source=actions', 'fail'),
    'https://hc-ping.com/uuid/fail?source=actions',
  );
});

test('considera saudável apenas execução recente e concluída com sucesso', async () => {
  const responses = [
    json({ state: 'active' }),
    json({
      workflow_runs: [
        {
          status: 'completed',
          conclusion: 'success',
          run_started_at: '2026-07-14T10:00:00.000Z',
          html_url: 'https://github.com/org/repo/actions/runs/1',
        },
      ],
    }),
  ];
  const calls = [];
  const result = await checkWorkflow(
    'org/repo',
    'main',
    { file: 'sync.yml', name: 'Sync', maxAgeHours: 10 },
    'token-test',
    {
      now: new Date('2026-07-14T12:00:00.000Z'),
      attempts: 1,
      fetchImpl: async (url, options) => {
        calls.push({ url, authorization: options.headers.Authorization });
        return responses.shift();
      },
    },
  );

  assert.equal(result.healthy, true);
  assert.equal(result.ageHours, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].authorization, 'Bearer token-test');
});

test('detecta workflow desabilitado antes de consultar execuções', async () => {
  let calls = 0;
  const result = await checkWorkflow(
    'org/repo',
    'main',
    { file: 'sync.yml', name: 'Sync', maxAgeHours: 10 },
    'token-test',
    {
      attempts: 1,
      fetchImpl: async () => {
        calls += 1;
        return json({ state: 'disabled_inactivity' });
      },
    },
  );

  assert.equal(result.healthy, false);
  assert.equal(result.reason, 'estado disabled_inactivity');
  assert.equal(calls, 1);
});

test('alerta de conclusão envia somente metadados operacionais e falha o job', async () => {
  let body;
  await assert.rejects(
    runCompletionAlert(
      {
        COMPANY_NAME: 'Empresa',
        GITHUB_REPOSITORY: 'org/repo',
        DISCORD_WEBHOOK_URL: 'https://discord.example/webhook-secret',
      },
      {
        attempts: 1,
        event: {
          workflow_run: {
            name: 'Sync',
            conclusion: 'failure',
            html_url: 'https://github.com/org/repo/actions/runs/2',
          },
        },
        fetchImpl: async (_url, options) => {
          body = JSON.parse(options.body);
          return new Response(null, { status: 204 });
        },
      },
    ),
    /não concluiu com sucesso/,
  );

  assert.match(body.content, /Sync: execução failure/);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.doesNotMatch(body.content, /webhook-secret/);
});
