const axios = require('axios');
const supabase = require('../lib/supabase');
const getHabllaHeaders = require('./hablla-auth');
const formatPublicError = require('../lib/public-error');

async function run() {
  try {
    console.log('[raw_events_hablla] Sincronizando cards...');

    const headers = await getHabllaHeaders();
    const quinzeDias = new Date();
    quinzeDias.setDate(quinzeDias.getDate() - 15);
    quinzeDias.setHours(0, 0, 0, 0);

    let page = 1;
    while (page <= 500) {
      const res = await axios.get(
        `https://api.hablla.com/v3/workspaces/${process.env.HABLLA_WORKSPACE_ID}/cards`,
        { params: { board: process.env.HABLLA_BOARD_ID, limit: 50, page, updated_after: quinzeDias.toISOString() }, headers }
      );
      const cards = res.data.results || [];
      if (!cards.length) break;

      const rows = cards.map(item => ({ external_id: `card-${item.id}`, payload: item }));

      const { error } = await supabase.from('raw_events_hablla').upsert(rows, { onConflict: 'external_id' });
      if (error) throw error;
      console.log(`[raw_events_hablla] Página ${page}: ${rows.length} cards`);
      page++;
    }
    console.log('[raw_events_hablla] Cards finalizado.');
  } catch (err) {
    console.error('[raw_events_hablla] Erro cards:', formatPublicError(err));
    process.exit(1);
  }
}

module.exports = run;
if (require.main === module) run();