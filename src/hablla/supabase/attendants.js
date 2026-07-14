const supabase = require("../../lib/supabase");
const formatPublicError = require("../../lib/public-error");
const { upsertRows } = require("../../lib/supabase-upsert");
const getHabllaClient = require("../api");
const {
  buildAttendantRows,
  reconcileAttendantRows,
} = require("../attendant-rows");
const { extractAttendants } = require("../response-contracts");
const saoPauloDayRange = require("../date-range");

async function run() {
  try {
    console.log("[raw_cs_avaliacao_atendimento] Sincronizando attendants...");

    if (!process.env.HABLLA_WORKSPACE_ID) {
      throw new Error("HABLLA_WORKSPACE_ID ausente");
    }
    const hablla = await getHabllaClient();
    const days = Number(process.env.HABLLA_ATTENDANTS_DAYS || 5);
    if (!Number.isInteger(days) || days < 1) {
      throw new Error("HABLLA_ATTENDANTS_DAYS precisa ser inteiro >= 1");
    }

    const rowsByDay = new Map();

    for (let i = days - 1; i >= 0; i--) {
      const range = saoPauloDayRange(i);
      const response = await hablla.get(
        `/v1/workspaces/${process.env.HABLLA_WORKSPACE_ID}/reports/services/summary`,
        { params: { start_date: range.start, end_date: range.end } },
      );

      const results = extractAttendants(response.data);
      const dayRows = buildAttendantRows(range.day, results);
      rowsByDay.set(range.day, dayRows);
      if (!dayRows.length) {
        console.log(
          `[raw_cs_avaliacao_atendimento] ${range.day}: sem dados.`,
        );
        continue;
      }

      console.log(
        `[raw_cs_avaliacao_atendimento] ${range.day}: ${dayRows.length} attendants.`,
      );
    }

    const result = await reconcileAttendantRows({
      client: supabase,
      rowsByDay,
      upsertRows,
    });
    console.log(
      `[raw_cs_avaliacao_atendimento] ${result.upserted} enviados; ${result.deleted} obsoletos removidos.`,
    );
  } catch (error) {
    console.error(
      "[raw_cs_avaliacao_atendimento] Erro:",
      formatPublicError(error),
    );
    process.exit(1);
  }
}

module.exports = run;
if (require.main === module) run();
