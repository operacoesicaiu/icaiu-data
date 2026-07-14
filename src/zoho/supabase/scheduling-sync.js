const supabase = require('../../lib/supabase');
const { createIdPageTracker } = require('../../lib/page-progress');
const { upsertRows } = require('../../lib/supabase-upsert');
const createZohoClient = require('../api');
const { extractZohoRecords } = require('../response');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatZohoDateTime(date) {
  return `${String(date.getUTCDate()).padStart(2, '0')}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')}`;
}

async function runZohoSchedulingSync({ startDate, endDate, label }) {
  console.log(`[raw_events_agendamento] Sincronizando ${label}...`);

  const { ZOHO_ACCOUNT_OWNER, ZOHO_SCHEDULING_APP_NAME, ZOHO_SCHEDULING_REPORT_NAME } = process.env;
  if (!ZOHO_ACCOUNT_OWNER || !ZOHO_SCHEDULING_APP_NAME || !ZOHO_SCHEDULING_REPORT_NAME) {
    throw new Error('Variaveis Zoho Scheduling ausentes');
  }
  const zoho = await createZohoClient();

  const criteria = `(Data_e_hora_de_inicio_do_formulario >= "${formatZohoDateTime(startDate)}" && Data_e_hora_de_inicio_do_formulario <= "${formatZohoDateTime(endDate)}")`;

  const zohoRecords = [];
  let from = 1;
  let pages = 0;
  const pageTracker = createIdPageTracker({
    source: 'Zoho agendamentos',
    idOf: (record) => record?.ID,
  });
  const maxPages = Number(process.env.ZOHO_MAX_PAGES || 10000);
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error('ZOHO_MAX_PAGES precisa ser inteiro >= 1');
  while (true) {
    if (++pages > maxPages) throw new Error('Zoho excedeu o limite seguro de paginas');
    let resp;
    try {
      resp = await zoho.get(
        `https://creator.zoho.com/api/v2/${ZOHO_ACCOUNT_OWNER}/${ZOHO_SCHEDULING_APP_NAME}/report/${ZOHO_SCHEDULING_REPORT_NAME}`,
        { params: { from, limit: 200, criteria } }
      );
    } catch (error) {
      if (Number(error.providerCode) === 3100) break;
      throw error;
    }

    const data = extractZohoRecords(resp, 'agendamentos');
    if (!data.length) break;
    pageTracker.observe(data);
    zohoRecords.push(...data);
    if (data.length < 200) break;
    from += 200;
  }

  if (!zohoRecords.length) {
    console.log('[raw_events_agendamento] Nenhum registro.');
    return;
  }

  const rowsById = new Map();
  for (const record of zohoRecords) {
    if (!record.ID) throw new Error('Zoho retornou agendamento sem ID');
    const externalId = `agendamento-${record.ID}`;
    rowsById.set(externalId, { external_id: externalId, payload: record });
  }
  const rows = [...rowsById.values()];

  await upsertRows({
    client: supabase,
    table: 'raw_events_agendamento',
    rows,
    batchSize: 500,
  });
  console.log(`[raw_events_agendamento] Sincronizados: ${rows.length}`);
}

module.exports = runZohoSchedulingSync;
module.exports.formatZohoDateTime = formatZohoDateTime;
