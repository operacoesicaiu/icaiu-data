const axios = require('axios');
const supabase = require('../lib/supabase');
const getHabllaHeaders = require('./hablla-auth');

async function run() {
  try {
    console.log('[contact_hablla] Sincronizando attendants...');

    const headers = await getHabllaHeaders();

    const ontem = new Date();
    ontem.setDate(ontem.getDate() - 1);
    const dIni = new Date(ontem.setHours(0, 0, 0, 0)).toISOString();
    const dFim = new Date(ontem.setHours(23, 59, 59, 999)).toISOString();

    const res = await axios.get(
      `https://api.hablla.com/v1/workspaces/${process.env.HABLLA_WORKSPACE_ID}/reports/services/summary`,
      { params: { start_date: dIni, end_date: dFim }, headers }
    );

    const results = res.data.results || [];

    if (!results.length) {
      console.log('[contact_hablla] Nenhum attendant encontrado.');
      return;
    }

    const rows = results.map(item => ({
      id: `attendant-${dFim}-${item.user?.id || 'unknown'}`,
      source: 'attendant',
      raw_payload: item,
      fetched_at: new Date().toISOString()
    }));

    const { error } = await supabase
      .from('contact_hablla')
      .upsert(rows, { onConflict: 'id' });

    if (error) throw error;
    console.log(`[contact_hablla] ${rows.length} attendants sincronizados.`);
  } catch (err) {
    console.error('[contact_hablla] Erro attendants:', err.response?.data || err.message);
    process.exit(1);
  }
}

module.exports = run;