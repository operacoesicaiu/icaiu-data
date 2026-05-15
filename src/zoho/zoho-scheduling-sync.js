const axios = require('axios');
const supabase = require('../lib/supabase');
const getZohoToken = require('./zoho-auth');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatZohoDateTime(date) {
  return `${String(date.getDate()).padStart(2, '0')}-${MONTHS[date.getMonth()]}-${date.getFullYear()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

async function runZohoSchedulingSync({ startDate, endDate, label }) {
  console.log(`[raw_events_agendamento] Sincronizando ${label}...`);

  const { ZOHO_ACCOUNT_OWNER, ZOHO_SCHEDULING_APP_NAME, ZOHO_SCHEDULING_REPORT_NAME } = process.env;
  const zohoToken = await getZohoToken();

  const criteria = `(Data_e_hora_de_inicio_do_formulario >= "${formatZohoDateTime(startDate)}" && Data_e_hora_de_inicio_do_formulario <= "${formatZohoDateTime(endDate)}")`;

  const zohoRecords = [];
  let from = 1;
  while (true) {
    const resp = await axios.get(
      `https://creator.zoho.com/api/v2/${ZOHO_ACCOUNT_OWNER}/${ZOHO_SCHEDULING_APP_NAME}/report/${ZOHO_SCHEDULING_REPORT_NAME}`,
      {
        params: { from, limit: 200, criteria },
        headers: { Authorization: `Zoho-oauthtoken ${zohoToken}` }
      }
    );

    const data = resp.data.data || [];
    if (!data.length) break;
    zohoRecords.push(...data);
    if (data.length < 200) break;
    from += 200;
  }

  if (!zohoRecords.length) {
    console.log('[raw_events_agendamento] Nenhum registro.');
    return;
  }

  const rows = zohoRecords.map(rec => ({ external_id: `agendamento-${rec.ID}`, payload: rec }));

  const { error } = await supabase.from('raw_events_agendamento').upsert(rows, { onConflict: 'external_id' });
  if (error) throw error;
  console.log(`[raw_events_agendamento] Sincronizados: ${rows.length}`);
}

module.exports = runZohoSchedulingSync;
