const axios = require('axios');
const supabase = require('../lib/supabase');
const getHabllaHeaders = require('./hablla-auth');

async function run() {
  try {
    console.log('[contact_hablla] Sincronizando cards...');

    const headers = await getHabllaHeaders();

    const seteDiasAtras = new Date();
    seteDiasAtras.setDate(seteDiasAtras.getDate() - 7);
    seteDiasAtras.setHours(0, 0, 0, 0);

    let page = 1;

    while (page <= 500) {
      const res = await axios.get(
        `https://api.hablla.com/v3/workspaces/${process.env.HABLLA_WORKSPACE_ID}/cards`,
        {
          params: {
            board: process.env.HABLLA_BOARD_ID,
            limit: 50,
            page,
            updated_after: seteDiasAtras.toISOString()
          },
          headers
        }
      );

      const cards = res.data.results || [];
      if (!cards.length) break;

      const rows = cards.map(item => ({
        id: `card-${item.id}`,
        source: 'card',
        raw_payload: item,
        fetched_at: new Date().toISOString()
      }));

      const { error } = await supabase
        .from('contact_hablla')
        .upsert(rows, { onConflict: 'id' });

      if (error) throw error;
      console.log(`[contact_hablla] Página ${page} sincronizada (${rows.length} cards)`);
      page++;
    }

    console.log('[contact_hablla] Cards finalizado.');
  } catch (err) {
    console.error('[contact_hablla] Erro cards:', err.response?.data || err.message);
    process.exit(1);
  }
}

module.exports = run;