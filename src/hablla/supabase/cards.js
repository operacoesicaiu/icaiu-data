const supabase = require("../../lib/supabase");
const formatPublicError = require("../../lib/public-error");
const { upsertRows } = require("../../lib/supabase-upsert");
const getHabllaClient = require("../api");
const collectHabllaCards = require("../card-collector");
const saoPauloDayRange = require("../date-range");

function positiveInteger(value, fallback, name) {
  const number = Number(value || fallback);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} precisa ser inteiro >= 1`);
  }
  return number;
}

async function run() {
  try {
    console.log("[raw_events_hablla] Sincronizando cards...");

    if (!process.env.HABLLA_WORKSPACE_ID) {
      throw new Error("HABLLA_WORKSPACE_ID ausente");
    }
    if (!process.env.HABLLA_BOARD_ID) {
      throw new Error("HABLLA_BOARD_ID ausente");
    }
    const hablla = await getHabllaClient();
    const days = positiveInteger(
      process.env.HABLLA_CARDS_DAYS,
      7,
      "HABLLA_CARDS_DAYS",
    );
    const range = saoPauloDayRange(days);
    const cards = await collectHabllaCards({
      hablla,
      workspaceId: process.env.HABLLA_WORKSPACE_ID,
      boardId: process.env.HABLLA_BOARD_ID,
      cutoff: range.start,
    });
    const rows = cards.map((card) => ({
      external_id: `card-${card.id}`,
      payload: card,
    }));
    if (!rows.length) {
      console.log("[raw_events_hablla] Nenhum card na janela.");
      return;
    }

    await upsertRows({
      client: supabase,
      table: "raw_events_hablla",
      rows,
      onConflict: "external_id",
    });
    console.log(
      `[raw_events_hablla] Cards finalizado. Total gravado: ${rows.length}.`,
    );
  } catch (error) {
    console.error(
      "[raw_events_hablla] Erro cards:",
      formatPublicError(error),
    );
    process.exit(1);
  }
}

module.exports = run;
if (require.main === module) run();
