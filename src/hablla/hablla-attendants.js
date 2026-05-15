const axios = require('axios');
const supabase = require('../lib/supabase');
const getHabllaHeaders = require('./hablla-auth');
const formatPublicError = require('../lib/public-error');

function dayRange(daysAgo) {
  const base = new Date();
  base.setDate(base.getDate() - daysAgo);

  const start = new Date(base);
  start.setHours(0, 0, 0, 0);

  const end = new Date(base);
  end.setHours(23, 59, 59, 999);

  return {
    day: start.toISOString().slice(0, 10),
    start: start.toISOString(),
    end: end.toISOString()
  };
}

async function run() {
  try {
    console.log('[raw_cs_avaliacao_atendimento] Sincronizando attendants...');

    const headers = await getHabllaHeaders();
    const days = Number(process.env.HABLLA_ATTENDANTS_DAYS || 5);
    if (!Number.isInteger(days) || days < 1) {
      throw new Error('HABLLA_ATTENDANTS_DAYS precisa ser inteiro >= 1');
    }

    const rows = [];
    const seen = new Set();

    for (let i = days - 1; i >= 0; i--) {
      const range = dayRange(i);
      const res = await axios.get(
        `https://api.hablla.com/v1/workspaces/${process.env.HABLLA_WORKSPACE_ID}/reports/services/summary`,
        { params: { start_date: range.start, end_date: range.end }, headers }
      );

      const results = Array.isArray(res.data?.results) ? res.data.results : [];
      if (!results.length) {
        console.log(`[raw_cs_avaliacao_atendimento] ${range.day}: sem dados.`);
        continue;
      }

      let dayCount = 0;
      for (const item of results) {
        const attendantId = item.user?.id || item.attendant_id || item.id;
        if (!attendantId) continue;
        const eid = `attendant-${range.day}-${attendantId}`;
        if (seen.has(eid)) continue;
        seen.add(eid);
        rows.push({ external_id: eid, payload: item });
        dayCount++;
      }
      console.log(`[raw_cs_avaliacao_atendimento] ${range.day}: ${dayCount} attendants.`);
    }

    if (!rows.length) {
      console.log('[raw_cs_avaliacao_atendimento] Nenhum attendant com id válido.');
      return;
    }

    const { error } = await supabase.from('raw_cs_avaliacao_atendimento').upsert(rows, { onConflict: 'external_id' });
    if (error) throw error;
    console.log(`[raw_cs_avaliacao_atendimento] ${rows.length} attendants enviados.`);
  } catch (err) {
    console.error('[raw_cs_avaliacao_atendimento] Erro:', formatPublicError(err));
    process.exit(1);
  }
}

module.exports = run;
if (require.main === module) run();