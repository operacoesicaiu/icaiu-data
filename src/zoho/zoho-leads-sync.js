const axios = require('axios');
const supabase = require('../lib/supabase');
const getZohoToken = require('./zoho-auth');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatZohoDay(date) {
  return `${String(date.getDate()).padStart(2, '0')}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`;
}

async function runZohoLeadsSync({ days, label }) {
  console.log(`[raw_contact_site] Sincronizando leads (${label})...`);

  const { ZOHO_ACCOUNT_OWNER, ZOHO_LEADS_APP_NAME, ZOHO_LEADS_REPORT_NAME } = process.env;
  const zohoToken = await getZohoToken();

  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - (days - 1));

  const finalRows = [];

  for (let date = new Date(startDate); date <= today; date.setDate(date.getDate() + 1)) {
    const formattedDate = formatZohoDay(date);
    let from = 1;
    const limit = 200;

    while (true) {
      const criteria = `(Data_e_hora_de_inicio_do_formul_rio >= "${formattedDate} 00:00:00" && Data_e_hora_de_inicio_do_formul_rio <= "${formattedDate} 23:59:59")`;
      const url = `https://creator.zoho.com/api/v2/${ZOHO_ACCOUNT_OWNER}/${ZOHO_LEADS_APP_NAME}/report/${ZOHO_LEADS_REPORT_NAME}`;

      const resp = await axios.get(url, {
        params: { from, limit, criteria },
        headers: { Authorization: `Zoho-oauthtoken ${zohoToken}` }
      });

      const data = resp.data.data || [];
      if (!data.length) break;

      for (const record of data) {
        finalRows.push({ external_id: `lead-${record.ID}`, payload: record });
      }

      if (data.length < limit) break;
      from += limit;
    }
  }

  if (finalRows.length > 0) {
    const { error } = await supabase.from('raw_contact_site').upsert(finalRows, { onConflict: 'external_id' });
    if (error) throw error;
  }

  console.log(`[raw_contact_site] Leads: ${finalRows.length}`);
}

module.exports = runZohoLeadsSync;
