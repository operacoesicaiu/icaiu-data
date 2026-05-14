const axios = require('axios');
const supabase = require('../lib/supabase');
const getZohoToken = require('./zoho-auth');

async function run() {
  try {
    console.log('[contact_site] Sincronizando leads (últimos 15 dias)...');

    const { ZOHO_ACCOUNT_OWNER, ZOHO_LEADS_APP_NAME, ZOHO_LEADS_REPORT_NAME } = process.env;
    const zohoToken = await getZohoToken();

    const meses = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const hoje = new Date();
    const quinzeAtras = new Date(hoje);
    quinzeAtras.setDate(hoje.getDate() - 15);

    let finalRows = [];

    // Busca dia a dia para não exceder limite do Zoho
    for (let d = new Date(quinzeAtras); d <= hoje; d.setDate(d.getDate() + 1)) {
      const dataF = `${String(d.getDate()).padStart(2,'0')}-${meses[d.getMonth()]}-${d.getFullYear()}`;
      let from = 1, limit = 200;

      while (true) {
        const criteria = `(Data_e_hora_de_inicio_do_formul_rio >= "${dataF} 00:00:00" && Data_e_hora_de_inicio_do_formul_rio <= "${dataF} 23:59:59")`;
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
      const { error } = await supabase.from('contact_site').upsert(finalRows, { onConflict: 'external_id' });
      if (error) throw error;
    }
    console.log(`[contact_site] Leads: ${finalRows.length}`);
  } catch (e) {
    console.error('[contact_site] Erro:', e.response?.data || e.message);
    process.exit(1);
  }
}

module.exports = run;