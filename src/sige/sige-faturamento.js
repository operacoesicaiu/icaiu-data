const axios = require('axios');
const supabase = require('../lib/supabase');
const formatPublicError = require('../lib/public-error');

const { SIGE_TOKEN, SIGE_USER, SIGE_APP } = process.env;

async function run() {
  try {
    console.log('[raw_events_faturado] Sincronizando (últimos 5 dias)...');

    const sigeHeaders = {
      "Authorization-Token": SIGE_TOKEN,
      "User": SIGE_USER,
      "App": SIGE_APP,
      "Content-Type": "application/json"
    };

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    let dataAtual = new Date(hoje);
    dataAtual.setDate(hoje.getDate() - 4);

    while (dataAtual <= hoje) {
      const dataBusca = dataAtual.toISOString().split('T')[0];
      console.log(`[raw_events_faturado] ${dataBusca}`);

      const resSige = await axios.get(
        "https://api.sigecloud.com.br/request/Pedidos/Pesquisar",
        { headers: sigeHeaders, params: { status: "Pedido Faturado", dataInicial: dataBusca, dataFinal: dataBusca, filtrarPor: 3, pageSize: 100 } }
      );

      const pedidos = resSige.data || [];
      if (!pedidos.length) { dataAtual.setDate(dataAtual.getDate() + 1); continue; }

      const rows = pedidos.map(p => ({ external_id: `pedido-${p.Codigo}`, payload: p }));

      const { error } = await supabase.from('raw_events_faturado').upsert(rows, { onConflict: 'external_id' });
      if (error) throw error;

      console.log(`[raw_events_faturado] ${rows.length} em ${dataBusca}`);
      dataAtual.setDate(dataAtual.getDate() + 1);
    }

    console.log('[raw_events_faturado] Concluído.');
  } catch (err) {
    console.error('[raw_events_faturado] Erro:', formatPublicError(err));
    process.exit(1);
  }
}

module.exports = run;
if (require.main === module) run();