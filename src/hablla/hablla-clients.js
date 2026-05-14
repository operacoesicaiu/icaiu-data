const axios = require('axios');
const supabase = require('../lib/supabase');
const getHabllaHeaders = require('./hablla-auth');

async function run() {
  try {
    console.log('[contact_hablla] Sincronizando clients...');

    const headers = await getHabllaHeaders();

    const ontem = new Date();
    ontem.setDate(ontem.getDate() - 1);
    const dIni = new Date(ontem.setHours(0, 0, 0, 0)).toISOString();
    const dFim = new Date(ontem.setHours(23, 59, 59, 999)).toISOString();

    let page = 1;
    const allClients = [];

    while (page <= 150) {
      const res = await axios.get(
        `https://api.hablla.com/v1/workspaces/${process.env.HABLLA_WORKSPACE_ID}/persons`,
        {
          params: {
            start_date: dIni,
            end_date: dFim,
            page,
            limit: 50,
            field_date: 'created_at',
            populate: true
          },
          headers
        }
      );

      const data = res.data?.results || res.data?.data || res.data || [];
      if (!Array.isArray(data) || !data.length) break;

      allClients.push(...data);
      if (data.length < 50) break;
      page++;
    }

    if (!allClients.length) {
      console.log('[contact_hablla] Nenhum cliente encontrado.');
      return;
    }

    const rows = allClients.map(item => ({
      id: `client-${item.id}`,
      source: 'client',
      raw_payload: item,
      fetched_at: new Date().toISOString()
    }));

    const { error } = await supabase
      .from('contact_hablla')
      .upsert(rows, { onConflict: 'id' });

    if (error) throw error;
    console.log(`[contact_hablla] ${rows.length} clientes sincronizados.`);
  } catch (err) {
    console.error('[contact_hablla] Erro clients:', err.response?.data || err.message);
    process.exit(1);
  }
}

module.exports = run;