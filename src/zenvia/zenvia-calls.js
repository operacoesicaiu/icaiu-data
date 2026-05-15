const axios = require('axios');
const supabase = require('../lib/supabase');

const { ZENVIA_ACCESS_TOKEN, ZENVIA_QUEUE_ID } = process.env;

async function run() {
  try {
    console.log('[raw_contact_telefonia] Iniciando...');

    const agora = new Date();
    const dsInicio = new Date(agora);
    dsInicio.setDate(agora.getDate() - 4);
    const fmt = (d) => d.toISOString().split('T')[0];

    let allCalls = [], posicao = 0, limite = 200;
    while (true) {
      const endpoint = ZENVIA_QUEUE_ID
        ? `https://voice-api.zenvia.com/fila/${ZENVIA_QUEUE_ID}/relatorio`
        : 'https://voice-api.zenvia.com/chamada/relatorio';
      const res = await axios.get(endpoint, {
        params: { data_inicio: fmt(dsInicio), data_fim: fmt(agora), posicao, limite },
        headers: { 'Access-Token': ZENVIA_ACCESS_TOKEN, 'Content-Type': 'application/json' }
      });
      const calls = res.data?.dados?.relatorio || [];
      if (!calls.length) break;
      allCalls.push(...calls);
      if (calls.length < limite) break;
      posicao += limite;
      if (posicao > 50000) break;
    }

    if (!allCalls.length) { console.log('[raw_contact_telefonia] Nenhum registro.'); return; }

    const rows = allCalls.map(item => ({ external_id: String(item.id), payload: item }));

    const batchSize = 1000;
    for (let i = 0; i < rows.length; i += batchSize) {
      const { error } = await supabase.from('raw_contact_telefonia').upsert(rows.slice(i, i + batchSize), { onConflict: 'external_id' });
      if (error) throw error;
    }
    console.log(`[raw_contact_telefonia] ${rows.length} registros sincronizados.`);
  } catch (err) {
    console.error('[raw_contact_telefonia] Erro:', err.response?.data || err.message);
    process.exit(1);
  }
}

module.exports = run;