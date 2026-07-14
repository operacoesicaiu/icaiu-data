const supabase = require('../../lib/supabase');
const formatPublicError = require('../../lib/public-error');
const { addDays, isoDay, today: saoPauloToday } = require('../../lib/sao-paulo-date');
const { upsertRows } = require('../../lib/supabase-upsert');
const { listSigeOrdersForDay } = require('../api');

function sigeDateRange(now = new Date()) {
  const endDate = saoPauloToday(now);
  return { startDate: addDays(endDate, -4), endDate };
}

async function run(now = new Date()) {
  try {
    console.log('[raw_events_faturado] Sincronizando (últimos 5 dias)...');

    const { startDate, endDate } = sigeDateRange(now);
    let dataAtual = startDate;
    const rowsById = new Map();

    while (dataAtual <= endDate) {
      const dataBusca = isoDay(dataAtual);
      console.log(`[raw_events_faturado] ${dataBusca}`);

      const pedidos = await listSigeOrdersForDay(dataBusca);
      if (!pedidos.length) { dataAtual = addDays(dataAtual, 1); continue; }

      for (const pedido of pedidos) {
        if (pedido.Codigo === undefined || pedido.Codigo === null || pedido.Codigo === '') {
          throw new Error('SIGE retornou pedido sem Codigo');
        }
        const externalId = `pedido-${pedido.Codigo}`;
        rowsById.set(externalId, { external_id: externalId, payload: pedido });
      }
      console.log(`[raw_events_faturado] ${pedidos.length} em ${dataBusca}`);
      dataAtual = addDays(dataAtual, 1);
    }

    const rows = [...rowsById.values()];
    await upsertRows({
      client: supabase,
      table: 'raw_events_faturado',
      rows,
      batchSize: 500,
    });

    console.log('[raw_events_faturado] Concluído.');
  } catch (err) {
    console.error('[raw_events_faturado] Erro:', formatPublicError(err));
    process.exit(1);
  }
}

module.exports = run;
module.exports.sigeDateRange = sigeDateRange;
if (require.main === module) run();
