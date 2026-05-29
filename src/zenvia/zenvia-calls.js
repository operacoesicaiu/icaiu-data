const axios = require('axios');
const supabase = require('../lib/supabase');
const formatPublicError = require('../lib/public-error');

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

    const res = await axios.get(`${BASE_URL}${path}`, {
      params,
      headers: { 'Access-Token': ZENVIA_ACCESS_TOKEN, 'Content-Type': 'application/json' }
    });
    shouldDelayRequest = true;
    return res;
  };
}

async function getQueues(getFromZenvia) {
  const res = await getFromZenvia('/fila');
  const filas = res.data?.dados?.filas || [];
  const queuesById = new Map();

  for (const fila of filas) {
    const id = fila?.id ? String(fila.id) : '';
    if (id) queuesById.set(id, { id, nome: fila.nome });
  }

  return [...queuesById.values()];
}

async function run() {
  try {
    console.log('[raw_contact_telefonia] Iniciando...');
    if (!ZENVIA_ACCESS_TOKEN) throw new Error('ZENVIA_ACCESS_TOKEN nao configurado.');

    const agora = new Date();
    const dsInicio = new Date(agora);
    dsInicio.setDate(agora.getDate() - 4);
    const fmt = (d) => d.toISOString().split('T')[0];

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
    for (const target of targets) {
      console.log(`[raw_contact_telefonia] Consultando ${target.label}...`);

      let posicao = 0;
      while (true) {
        const res = await getFromZenvia(target.endpoint, { data_inicio: fmt(dsInicio), data_fim: fmt(agora), posicao, limite });
        const calls = res.data?.dados?.relatorio || [];
        if (!calls.length) break;
        allCalls.push(...calls.map(item => target.queueId
          ? { ...item, zenvia_queue_id: target.queueId }
          : item));
        if (calls.length < limite) break;
        posicao += limite;
        if (posicao > 50000) break;
      }
    }

    if (!allCalls.length) { console.log('[raw_contact_telefonia] Nenhum registro.'); return; }

    const uniqueRows = new Map();
    for (const item of allCalls) {
      uniqueRows.set(String(item.id), { external_id: String(item.id), payload: item });
    }
    const rows = [...uniqueRows.values()];

    const batchSize = 1000;
    for (let i = 0; i < rows.length; i += batchSize) {
      const { error } = await supabase.from('raw_contact_telefonia').upsert(rows.slice(i, i + batchSize), { onConflict: 'external_id' });
      if (error) throw error;
    }
    console.log(`[raw_contact_telefonia] ${rows.length} registros sincronizados.`);
  } catch (err) {
    console.error('[raw_contact_telefonia] Erro:', formatPublicError(err));
    process.exit(1);
  }
}

module.exports = run;
if (require.main === module) run();
