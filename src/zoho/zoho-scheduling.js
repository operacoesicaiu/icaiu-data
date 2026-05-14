const axios = require('axios');
const supabase = require('../lib/supabase');
const getZohoToken = require('./zoho-auth');

async function run() {
  try {
    console.log('[events_agendamento] Sincronizando...');

    const { ZOHO_ACCOUNT_OWNER, ZOHO_SCHEDULING_APP_NAME, ZOHO_SCHEDULING_REPORT_NAME } = process.env;
    const zohoToken = await getZohoToken();

    const today = new Date();
    const startDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const fmt = (d) => `${String(d.getDate()).padStart(2,'0')}-${months[d.getMonth()]}-${d.getFullYear()}`;

    let zohoRecords = [], from = 1;
    while (true) {
      const resp = await axios.get(
        `https://creator.zoho.com/api/v2/${ZOHO_ACCOUNT_OWNER}/${ZOHO_SCHEDULING_APP_NAME}/report/${ZOHO_SCHEDULING_REPORT_NAME}`,
        {
          params: { from, limit: 200, criteria: `(Data_e_hora_de_inicio_do_formulario >= "${fmt(startDate)}" && Data_e_hora_de_inicio_do_formulario <= "${fmt(today)}")` },
          headers: { Authorization: `Zoho-oauthtoken ${zohoToken}` }
        }
      );

      const data = resp.data.data || [];
      if (!data.length) break;
      zohoRecords.push(...data);
      if (data.length < 200) break;
      from += 200;
    }

    if (!zohoRecords.length) { console.log('[events_agendamento] Nenhum registro.'); return; }

    const rows = zohoRecords.map(rec => ({ external_id: `agendamento-${rec.ID}`, payload: rec }));

    const { error } = await supabase.from('events_agendamento').upsert(rows, { onConflict: 'external_id' });
    if (error) throw error;
    console.log(`[events_agendamento] Sincronizados: ${rows.length}`);
  } catch (e) {
    console.error('[events_agendamento] Erro:', e.response?.data || e.message);
    process.exit(1);
  }
}

module.exports = run;