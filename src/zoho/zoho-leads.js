const axios = require('axios');
const supabase = require('../lib/supabase');
const getZohoToken = require('./zoho-auth');

async function run() {
  try {
    console.log('[contact_site] Sincronizando leads...');

    const {
      ZOHO_ACCOUNT_OWNER,
      ZOHO_LEADS_APP_NAME,
      ZOHO_LEADS_REPORT_NAME
    } = process.env;

    const zohoToken = await getZohoToken();

    const meses = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const ontem = new Date();
    ontem.setDate(ontem.getDate() - 1);
    const dataFiltro = `${String(ontem.getDate()).padStart(2,'0')}-${meses[ontem.getMonth()]}-${ontem.getFullYear()}`;

    let from = 1;
    const limit = 200;
    let finalRows = [];

    while (true) {
      const criteria =
        `(Data_e_hora_de_inicio_do_formul_rio >= "${dataFiltro} 00:00:00" && Data_e_hora_de_inicio_do_formul_rio <= "${dataFiltro} 23:59:59")`;

      const url =
        `https://creator.zoho.com/api/v2/${ZOHO_ACCOUNT_OWNER}/${ZOHO_LEADS_APP_NAME}/report/${ZOHO_LEADS_REPORT_NAME}`;

      const resp = await axios.get(url, {
        params: { from, limit, criteria },
        headers: { Authorization: `Zoho-oauthtoken ${zohoToken}` }
      });

      const data = resp.data.data || [];
      if (!data.length) break;

      for (const record of data) {
        finalRows.push({
          id: `lead-${record.ID}`,
          raw_payload: record,
          fetched_at: new Date().toISOString()
        });
      }

      if (data.length < limit) break;
      from += limit;
    }

    if (finalRows.length > 0) {
      const { error } = await supabase
        .from('contact_site')
        .upsert(finalRows, { onConflict: 'id' });
      if (error) throw error;
    }

    console.log(`[contact_site] Leads sincronizados: ${finalRows.length}`);
  } catch (e) {
    console.error('[contact_site] Erro:', e.response?.data || e.message);
    process.exit(1);
  }
}

module.exports = run;