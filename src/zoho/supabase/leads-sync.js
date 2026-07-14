const supabase = require('../../lib/supabase');
const { createIdPageTracker } = require('../../lib/page-progress');
const { addDays, today: saoPauloToday } = require('../../lib/sao-paulo-date');
const { upsertRows } = require('../../lib/supabase-upsert');
const createZohoClient = require('../api');
const { extractZohoRecords } = require('../response');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatZohoDay(date) {
  return `${String(date.getUTCDate()).padStart(2, '0')}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function leadsDateRange(days, now = new Date()) {
  if (!Number.isInteger(days) || days < 1) throw new Error('days precisa ser inteiro >= 1');
  const endDate = saoPauloToday(now);
  return { startDate: addDays(endDate, -(days - 1)), endDate };
}

async function runZohoLeadsSync({ days, label, now = new Date() }) {
  console.log(`[raw_contact_site] Sincronizando leads (${label})...`);
  const { startDate, endDate } = leadsDateRange(days, now);

  const { ZOHO_ACCOUNT_OWNER, ZOHO_LEADS_APP_NAME, ZOHO_LEADS_REPORT_NAME } = process.env;
  if (!ZOHO_ACCOUNT_OWNER || !ZOHO_LEADS_APP_NAME || !ZOHO_LEADS_REPORT_NAME) {
    throw new Error('Variaveis Zoho Leads ausentes');
  }
  const zoho = await createZohoClient();

  const rowsById = new Map();
  const maxPages = Number(process.env.ZOHO_MAX_PAGES || 10000);
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error('ZOHO_MAX_PAGES precisa ser inteiro >= 1');

  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    const formattedDate = formatZohoDay(date);
    let from = 1;
    const limit = 200;
    let pages = 0;
    const pageTracker = createIdPageTracker({
      source: 'Zoho leads',
      idOf: (record) => record?.ID,
    });

    while (true) {
      if (++pages > maxPages) throw new Error('Zoho excedeu o limite seguro de paginas');
      const criteria = `(Data_e_hora_de_inicio_do_formul_rio >= "${formattedDate} 00:00:00" && Data_e_hora_de_inicio_do_formul_rio <= "${formattedDate} 23:59:59")`;
      const url = `https://creator.zoho.com/api/v2/${ZOHO_ACCOUNT_OWNER}/${ZOHO_LEADS_APP_NAME}/report/${ZOHO_LEADS_REPORT_NAME}`;

      let resp;
      try {
        resp = await zoho.get(url, { params: { from, limit, criteria } });
      } catch (e) {
        if (Number(e.providerCode) === 3100) {
          console.log(`[raw_contact_site] ${formattedDate}: sem dados.`);
          break;
        }
        throw e;
      }

      const data = extractZohoRecords(resp, 'leads');
      if (!data.length) break;
      pageTracker.observe(data);

      for (const record of data) {
        if (!record.ID) throw new Error('Zoho retornou lead sem ID');
        const externalId = `lead-${record.ID}`;
        rowsById.set(externalId, { external_id: externalId, payload: record });
      }

      if (data.length < limit) break;
      from += limit;
    }
  }

  const finalRows = [...rowsById.values()];
  await upsertRows({
    client: supabase,
    table: 'raw_contact_site',
    rows: finalRows,
    batchSize: 500,
  });

  console.log(`[raw_contact_site] Leads: ${finalRows.length}`);
}

module.exports = runZohoLeadsSync;
module.exports._internals = { formatZohoDay, leadsDateRange };
