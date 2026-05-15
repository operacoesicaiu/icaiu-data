const axios = require('axios');
const supabase = require('../lib/supabase');
const getHabllaHeaders = require('./hablla-auth');
const formatPublicError = require('../lib/public-error');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parsePositiveInteger(value, fallback, name) {
  const number = Number(value || fallback);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} precisa ser inteiro >= 1`);
  }
  return number;
}

function startOfDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(0, 0, 0, 0);
  return date;
}

function hasDateInWindow(value, startDate) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date >= startDate;
}

async function run() {
  try {
    console.log('[raw_events_hablla] Sincronizando cards...');

    const headers = await getHabllaHeaders();
    const days = parsePositiveInteger(process.env.HABLLA_CARDS_DAYS, 7, 'HABLLA_CARDS_DAYS');
    const maxPages = parsePositiveInteger(process.env.HABLLA_CARDS_MAX_PAGES, 500, 'HABLLA_CARDS_MAX_PAGES');
    const startDate = startOfDaysAgo(days);

    let page = 1;
    let total = 0;

    while (page <= maxPages) {
      const res = await axios.get(
        `https://api.hablla.com/v3/workspaces/${process.env.HABLLA_WORKSPACE_ID}/cards`,
        { params: { board: process.env.HABLLA_BOARD_ID, limit: 50, page, updated_after: startDate.toISOString() }, headers }
      );
      const cards = res.data.results || [];
      if (!cards.length) break;

      const recentCards = cards.filter(item => hasDateInWindow(item.created_at, startDate));
      const rows = recentCards.map(item => ({ external_id: `card-${item.id}`, payload: item }));

      if (rows.length) {
        const { error } = await supabase.from('raw_events_hablla').upsert(rows, { onConflict: 'external_id' });
        if (error) throw error;
      }

      total += rows.length;
      console.log(`[raw_events_hablla] Pagina ${page}: ${rows.length}/${cards.length} cards dentro da janela`);

      if (!recentCards.length && page > 2) {
        console.log('[raw_events_hablla] Parando: pagina sem cards criados dentro da janela.');
        break;
      }

      page++;
      await sleep(500);
    }

    if (page > maxPages) {
      console.log(`[raw_events_hablla] Limite de ${maxPages} paginas atingido.`);
    }

    console.log(`[raw_events_hablla] Cards finalizado. Total gravado: ${total}.`);
  } catch (err) {
    console.error('[raw_events_hablla] Erro cards:', formatPublicError(err));
    process.exit(1);
  }
}

module.exports = run;
if (require.main === module) run();
