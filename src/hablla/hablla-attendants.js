const axios = require('axios');
const supabase = require('../lib/supabase');
const getHabllaHeaders = require('./hablla-auth');

async function run() {
  try {
    console.log('[contact_hablla] Sincronizando attendants...');

    const headers = await getHabllaHeaders();
    const quinzeDias = new Date();
    quinzeDias.setDate(quinzeDias.getDate() - 15);
    const dIni = new Date(quinzeDias.setHours(0, 0, 0, 0)).toISOString();
    const dFim = new Date(quinzeDias.setHours(23, 59, 59, 999)).toISOString();

    const res = await axios.get(
      `https://api.hablla.com/v1/workspaces/${process.env.HABLLA_WORKSPACE_ID}/reports/services/summary`,
      { params: { start_date: dIni, end_date: dFim }, headers }
    );

    const results = res.data.results || [];
    if (!results.length) { console.log('[contact_hablla] Nenhum attendant.'); return; }

    const seen = new Set();
    const rows = [];
    for (const item of results) {
      const eid = `attendant-${dFim}-${item.user?.id || 'unknown'}`;
      if (seen.has(eid)) continue;
      seen.add(eid);
      rows.push({ external_id: eid, payload: item });
    }

    const { error } = await supabase.from('contact_hablla').upsert(rows, { onConflict: 'external_id' });
    if (error) throw error;
    console.log(`[contact_hablla] ${rows.length} attendants.`);
  } catch (err) {
    console.error('[contact_hablla] Erro:', err.response?.data || err.message);
    process.exit(1);
  }
}

module.exports = run;