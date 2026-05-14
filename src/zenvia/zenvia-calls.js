const axios = require('axios');
const supabase = require('../lib/supabase');

const {
  ZENVIA_ACCESS_TOKEN,
  ZENVIA_QUEUE_ID
} = process.env;

async function run() {
  try {
    console.log('[contact_telefonia] Iniciando sincronização...');

    const agora = new Date();
    const ontem = new Date(agora);
    ontem.setDate(agora.getDate() - 1);
    const dsInicio = new Date(agora);
    dsInicio.setDate(agora.getDate() - 2);

    const fmt = (d) => d.toISOString().split('T')[0];

    let allCalls = [];
    let posicao = 0;
    const limite = 200;

    while (true) {
      const endpoint = ZENVIA_QUEUE_ID
        ? `https://voice-api.zenvia.com/fila/${ZENVIA_QUEUE_ID}/relatorio`
        : 'https://voice-api.zenvia.com/chamada/relatorio';

      const res = await axios.get(endpoint, {
        params: {
          data_inicio: fmt(dsInicio),
          data_fim: fmt(agora),
          posicao,
          limite
        },
        headers: {
          'Access-Token': ZENVIA_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      });

      const calls = res.data?.dados?.relatorio || [];
      if (!calls.length) break;

      allCalls.push(...calls);
      if (calls.length < limite) break;

      posicao += limite;
      if (posicao > 50000) break;
    }

    console.log(`[contact_telefonia] ${allCalls.length} registros capturados`);

    const dataAlvo = fmt(ontem);
    const filtrados = allCalls.filter(c => c.data_inicio?.startsWith(dataAlvo));

    console.log(`[contact_telefonia] ${filtrados.length} registros após filtro do dia anterior`);

    if (!filtrados.length) {
      console.log('[contact_telefonia] Nenhum registro para inserir.');
      return;
    }

    const rows = filtrados.map(item => ({
      id: item.id,
      raw_payload: item,
      fetched_at: new Date().toISOString()
    }));

    const batchSize = 1000;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const { error } = await supabase
        .from('contact_telefonia')
        .upsert(batch, { onConflict: 'id' });
      if (error) throw error;
      console.log(`[contact_telefonia] Lote ${Math.floor(i / batchSize) + 1} salvo`);
    }

    console.log('[contact_telefonia] Sincronização finalizada.');
  } catch (err) {
    console.error('[contact_telefonia] Erro:', err.response?.data || err.message);
    process.exit(1);
  }
}

module.exports = run;