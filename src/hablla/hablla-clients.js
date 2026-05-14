const axios = require('axios');
const supabase = require('../lib/supabase');
const getHabllaHeaders = require('./hablla-auth');

async function run() {
  try {
    console.log('[contact_hablla] Sincronizando clients...');

    const headers = await getHabllaHeaders();
    const quinzeDias = new Date();
    quinzeDias.setDate(quinzeDias.getDate() - 15);
    const dIni = new Date(quinzeDias.setHours(0, 0, 0, 0)).toISOString();
    const dFim = new Date(quinzeDias.setHours(23, 59, 59, 999)).toISOString();

    let page = 1, allClients = [];
    while (page <= 150) {
      const res = await axios.get(
        `https://api.hablla.com/v1/workspaces/${process.env.HABLLA_WORKSPACE_ID}/persons`,
        { params: { start_date: dIni, end_date: dFim, page, limit: 50, field_date: 'created_at', populate: true }, headers }
      );
      const data = res.data?.results || res.data?.data || res.data || [];
      if (!Array.isArray(data) || !data.length) break;
      allClients.push(...data);
      if (data.length < 50) break;
      page++;
    }

    if (!allClients.length) { console.log('[contact_hablla] Nenhum cliente.'); return; }

    const rows = allClients.map(item => ({ external_id: `client-${item.id}`, payload: item }));

    const { error } = await supabase.from('contact_hablla').upsert(rows, { onConflict: 'external_id' });
    if (error) throw error;
    console.log(`[contact_hablla] ${rows.length} clientes.`);
  } catch (err) {
    console.error('[contact_hablla] Erro clients:', err.response?.data || err.message);
    process.exit(1);
  }
}

module.exports = run;