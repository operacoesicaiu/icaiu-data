const axios = require('axios');
const supabase = require('../lib/supabase');

const { SIGE_TOKEN, SIGE_USER, SIGE_APP } = process.env;

async function run() {
  try {
    console.log('[events_faturado] Sincronizando (últimos 15 dias)...');

    const sigeHeaders = {
      "Authorization-Token": SIGE_TOKEN,
      "User": SIGE_USER,
      "App": SIGE_APP,
      "Content-Type": "application/json"
    };

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const ontem = new Date(hoje);
    ontem.setDate(hoje.getDate() - 1);

    let dataAtual = new Date(hoje);
    dataAtual.setDate(hoje.getDate() - 15);

    while (dataAtual <= ontem) {
      const dataBusca = dataAtual.toISOString().split('T')[0];
      console.log(`[events_faturado] ${dataBusca}`);

      const resSige = await axios.get(
        "https://api.sigecloud.com.br/request/Pedidos/Pesquisar",
        { headers: sigeHeaders, params: { status: "Pedido Faturado", dataInicial: dataBusca, dataFinal: dataBusca, filtrarPor: 3, pageSize: 100 } }
      );

      const pedidos = resSige.data || [];
      if (!pedidos.length) { dataAtual.setDate(dataAtual.getDate() + 1); continue; }

      const rows = pedidos.map(p => ({ external_id: `pedido-${p.Codigo}`, payload: p }));

      const { error } = await supabase.from('events_faturado').upsert(rows, { onConflict: 'external_id' });
      if (error) throw error;

      console.log(`[events_faturado] ${rows.length} em ${dataBusca}`);
      dataAtual.setDate(dataAtual.getDate() + 1);
    }

    console.log('[events_faturado] Concluído.');
  } catch (err) {
    console.error('[events_faturado] Erro:', err.response?.data || err.message);
    process.exit(1);
  }
}

module.exports = run;