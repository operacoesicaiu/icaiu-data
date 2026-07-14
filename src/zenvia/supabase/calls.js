const axios = require('axios');
const supabase = require('../../lib/supabase');
const formatPublicError = require('../../lib/public-error');
const { withHttpRetry } = require('../../lib/http-retry');
const { createIdPageTracker } = require('../../lib/page-progress');
const { addDays, isoDay, today: saoPauloToday } = require('../../lib/sao-paulo-date');
const { upsertRows } = require('../../lib/supabase-upsert');
const { extractZenviaList } = require('../response');

const {
  ZENVIA_ACCESS_TOKEN,
  ZENVIA_REQUEST_DELAY_MS
} = process.env;

const BASE_URL = 'https://voice-api.zenvia.com';
const DEFAULT_REQUEST_DELAY_MS = 1000;

function getRequestDelayMs() {
  const delayMs = Number.parseInt(ZENVIA_REQUEST_DELAY_MS || DEFAULT_REQUEST_DELAY_MS, 10);
  return Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : DEFAULT_REQUEST_DELAY_MS;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createZenviaGetter(requestDelayMs) {
  let shouldDelayRequest = false;

  return async function getFromZenvia(path, params) {
    if (shouldDelayRequest && requestDelayMs > 0) {
      await sleep(requestDelayMs);
    }

    const res = await withHttpRetry(() => axios.get(`${BASE_URL}${path}`, {
        params,
        timeout: 60000,
        headers: { 'Access-Token': ZENVIA_ACCESS_TOKEN, 'Content-Type': 'application/json' }
      }), { maxAttempts: 5, baseMs: 1500 });
    shouldDelayRequest = true;
    return res;
  };
}

async function getQueues(getFromZenvia) {
  const res = await getFromZenvia('/fila');
  const filas = extractZenviaList(res, 'filas', 'filas');
  const pageTracker = createIdPageTracker({
    source: 'Zenvia filas',
    idOf: (fila) => fila?.id,
  });
  pageTracker.observe(filas);
  const queuesById = new Map();

  for (const fila of filas) {
    const id = fila?.id ? String(fila.id) : '';
    if (id) queuesById.set(id, { id, nome: fila.nome });
  }

  return [...queuesById.values()];
}

function zenviaDateRange(now = new Date()) {
  const endDate = saoPauloToday(now);
  return { start: isoDay(addDays(endDate, -4)), end: isoDay(endDate) };
}

async function run() {
  try {
    console.log('[raw_contact_telefonia] Iniciando...');
    if (!ZENVIA_ACCESS_TOKEN) throw new Error('ZENVIA_ACCESS_TOKEN nao configurado.');

    const { start: dataInicio, end: dataFim } = zenviaDateRange();

    const requestDelayMs = getRequestDelayMs();
    const getFromZenvia = createZenviaGetter(requestDelayMs);

    console.log('[raw_contact_telefonia] Buscando filas da Zenvia...');
    const queues = await getQueues(getFromZenvia);
    console.log(`[raw_contact_telefonia] ${queues.length} filas encontradas.`);

    const targets = queues.length
      ? queues.map(queue => ({
        label: queue.nome ? `fila ${queue.id} (${queue.nome})` : `fila ${queue.id}`,
        endpoint: `/fila/${queue.id}/relatorio`,
        queueId: queue.id
      }))
      : [{ label: 'relatorio geral', endpoint: '/chamada/relatorio' }];

    const allCalls = [];
    const limite = 200;
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
      const target = targets[targetIndex];
      console.log(`[raw_contact_telefonia] Fonte Zenvia ${targetIndex + 1}/${targets.length}...`);

      let posicao = 0;
      const pageTracker = createIdPageTracker({
        source: 'Zenvia chamadas',
        idOf: (item) => item?.id,
      });
      while (true) {
        const res = await getFromZenvia(target.endpoint, { data_inicio: dataInicio, data_fim: dataFim, posicao, limite });
        const calls = extractZenviaList(res, 'relatorio', 'chamadas');
        if (!calls.length) break;
        pageTracker.observe(calls);
        allCalls.push(...calls.map(item => target.queueId
          ? { ...item, zenvia_queue_id: target.queueId }
          : item));
        if (calls.length < limite) break;
        posicao += limite;
        if (posicao > 50000) throw new Error('Zenvia excedeu o limite seguro de paginacao');
      }
    }

    if (!allCalls.length) { console.log('[raw_contact_telefonia] Nenhum registro.'); return; }

    const uniqueRows = new Map();
    for (const item of allCalls) {
      if (item.id === undefined || item.id === null || item.id === '') {
        throw new Error('Zenvia retornou chamada sem ID');
      }
      uniqueRows.set(String(item.id), { external_id: String(item.id), payload: item });
    }
    const rows = [...uniqueRows.values()];

    await upsertRows({
      client: supabase,
      table: 'raw_contact_telefonia',
      rows,
      batchSize: 1000,
    });
    console.log(`[raw_contact_telefonia] ${rows.length} registros sincronizados.`);
  } catch (err) {
    console.error('[raw_contact_telefonia] Erro:', formatPublicError(err));
    process.exit(1);
  }
}

module.exports = run;
module.exports.zenviaDateRange = zenviaDateRange;
if (require.main === module) run();
