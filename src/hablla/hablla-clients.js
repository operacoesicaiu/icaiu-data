const axios = require('axios');
const supabase = require('../lib/supabase');
const getHabllaHeaders = require('./hablla-auth');
const formatPublicError = require('../lib/public-error');

async function run() {
  try {
    console.log('[raw_contact_hablla] Sincronizando clients...');

    const headers = await getHabllaHeaders();
    const hoje = new Date();
    const inicio = new Date(hoje);
    inicio.setDate(inicio.getDate() - 4);
    const dIni = new Date(inicio.setHours(0, 0, 0, 0)).toISOString();
    const dFim = new Date(hoje.setHours(23, 59, 59, 999)).toISOString();

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

    if (!allClients.length) { console.log('[raw_contact_hablla] Nenhum cliente.'); return; }

    const rowsMap = new Map();
    for (const item of allClients) {
      rowsMap.set(`client-${item.id}`, { external_id: `client-${item.id}`, payload: item });
    }
    const rows = Array.from(rowsMap.values());

    const { error } = await supabase.from('raw_contact_hablla').upsert(rows, { onConflict: 'external_id' });
    if (error) throw error;
    console.log(`[raw_contact_hablla] ${rows.length} clientes.`);
  } catch (err) {
    console.error('[raw_contact_hablla] Erro clients:', formatPublicError(err));
    process.exit(1);
  }
}

module.exports = run;
if (require.main === module) run();