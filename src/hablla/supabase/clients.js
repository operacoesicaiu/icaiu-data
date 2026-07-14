const supabase = require("../../lib/supabase");
const formatPublicError = require("../../lib/public-error");
const { upsertRows } = require("../../lib/supabase-upsert");
const getHabllaClient = require("../api");
const { extractClients } = require("../response-contracts");
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
    console.log("[raw_contact_hablla] Sincronizando clients...");

    if (!process.env.HABLLA_WORKSPACE_ID) {
      throw new Error("HABLLA_WORKSPACE_ID ausente");
    }
    const hablla = await getHabllaClient();
    const maxPages = positiveInteger(
      process.env.HABLLA_CLIENTS_MAX_PAGES,
      150,
      "HABLLA_CLIENTS_MAX_PAGES",
    );
    const start = saoPauloDayRange(4).start;
    const end = saoPauloDayRange(0).end;
    const clientsById = new Map();
    const pageFingerprints = new Set();
    let completed = false;

    for (let page = 1; page <= maxPages; page++) {
      const response = await hablla.get(
        `/v1/workspaces/${process.env.HABLLA_WORKSPACE_ID}/persons`,
        {
          params: {
            start_date: start,
            end_date: end,
            page,
            limit: 50,
            field_date: "created_at",
            populate: true,
          },
        },
      );
      const clients = extractClients(response.data);
      if (!clients.length) {
        completed = true;
        break;
      }

      const fingerprint = `${clients.length}:${clients[0]?.id || ""}:${clients.at(-1)?.id || ""}`;
      if (pageFingerprints.has(fingerprint)) {
        throw new Error("Hablla repetiu uma pagina de clients");
      }
      pageFingerprints.add(fingerprint);

      for (const client of clients) {
        if (!client.id) throw new Error("Hablla retornou client sem id");
        clientsById.set(`client-${client.id}`, {
          external_id: `client-${client.id}`,
          payload: client,
        });
      }

      if (clients.length < 50) {
        completed = true;
        break;
      }
    }

    if (!completed) {
      throw new Error(
        `Hablla atingiu o limite seguro de ${maxPages} paginas de clients`,
      );
    }

    const rows = [...clientsById.values()];
    if (!rows.length) {
      console.log("[raw_contact_hablla] Nenhum cliente.");
      return;
    }

    await upsertRows({
      client: supabase,
      table: "raw_contact_hablla",
      rows,
      onConflict: "external_id",
    });
    console.log(`[raw_contact_hablla] ${rows.length} clientes.`);
  } catch (error) {
    console.error(
      "[raw_contact_hablla] Erro clients:",
      formatPublicError(error),
    );
    process.exit(1);
  }
}

module.exports = run;
if (require.main === module) run();
