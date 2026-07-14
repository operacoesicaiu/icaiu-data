const crypto = require("node:crypto");
const { withHttpRetry } = require("../lib/http-retry");
const { retryableSupabaseError } = require("../lib/supabase-upsert");

const TABLE = "raw_cs_avaliacao_atendimento";

function text(value) {
  return String(value ?? "").trim();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function firstValue(...values) {
  return values.map(text).find(Boolean) || "";
}

function identityParts(item) {
  const sector = firstValue(item.sector?.id, item.sector_id, item.sector?.name);
  const user = firstValue(
    item.user?.id,
    item.user_id,
    item.attendant_id,
    item.id,
    item.user?.email,
    item.user?.name,
  );
  const connectionFallback = [
    text(item.connection?.name),
    text(item.connection?.type),
  ].join("|");
  const connection = firstValue(
    item.connection?.id,
    item.connection_id,
    connectionFallback === "|" ? "" : connectionFallback,
  );
  return { connection, sector, user };
}

function validateDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) {
    throw new Error("Dia Hablla invalido para reconciliacao de atendentes");
  }
  return String(day);
}

function attendantExternalId(day, item) {
  const safeDay = validateDay(day);
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("Atendente Hablla invalido");
  }
  const { connection, sector, user } = identityParts(item);
  const material = sector && user && connection
    ? ["identity-v2", safeDay, sector, user, connection]
    : ["payload-v2", safeDay, canonicalize(item)];
  const digest = crypto.createHash("sha256").update(stableJson(material)).digest("hex");
  return `attendant-${safeDay}-v2-${digest}`;
}

function buildAttendantRows(day, items) {
  if (!Array.isArray(items)) throw new Error("Lista de atendentes Hablla invalida");
  const rowsById = new Map();
  for (const item of items) {
    const externalId = attendantExternalId(day, item);
    rowsById.set(externalId, { external_id: externalId, payload: item });
  }
  return [...rowsById.values()];
}

function positiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} precisa ser inteiro >= 1`);
  }
  return parsed;
}

function safeDatabaseError(operation, error, status) {
  const code = error?.code || "unknown";
  const wrapped = new Error(
    `Supabase ${operation} falhou: status=${status || "unknown"} code=${code}`,
  );
  if (error?.code) wrapped.code = error.code;
  if (status) wrapped.response = { status, headers: {} };
  return wrapped;
}

async function checkedQuery(operation, query, options = {}) {
  const maxAttempts = positiveInteger(
    options.maxAttempts ?? process.env.SUPABASE_MAX_ATTEMPTS,
    4,
    "SUPABASE_MAX_ATTEMPTS",
  );
  return withHttpRetry(
    async () => {
      let result;
      try {
        result = await query();
      } catch (error) {
        throw error;
      }
      if (!result || result.error) {
        const status = Number(result?.status || result?.error?.status || 0);
        throw safeDatabaseError(operation, result?.error, status);
      }
      return result;
    },
    {
      maxAttempts,
      baseMs: 1500,
      maxMs: 60000,
      shouldRetry: retryableSupabaseError,
    },
  );
}

async function readExistingIds(client, day, options = {}) {
  const safeDay = validateDay(day);
  const prefix = `attendant-${safeDay}-`;
  const pageSize = positiveInteger(options.pageSize, 1000, "pageSize");
  const maxPages = positiveInteger(options.maxPages, 100, "maxPages");
  const ids = new Set();

  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const result = await checkedQuery(
      "leitura de atendentes",
      () =>
        client
          .from(TABLE)
          .select("external_id")
          .like("external_id", `${prefix}%`)
          .order("external_id", { ascending: true })
          .range(from, from + pageSize - 1),
      options,
    );
    if (!Array.isArray(result.data)) {
      throw new Error("Supabase retornou lista invalida ao ler atendentes");
    }
    for (const row of result.data) {
      const externalId = text(row?.external_id);
      if (!externalId || !externalId.startsWith(prefix)) {
        throw new Error("Supabase retornou external_id invalido ao ler atendentes");
      }
      ids.add(externalId);
    }
    if (result.data.length < pageSize) return ids;
  }
  throw new Error("Supabase excedeu o limite seguro ao ler atendentes");
}

async function deleteObsoleteIds(client, ids, options = {}) {
  const batchSize = positiveInteger(options.deleteBatchSize, 500, "deleteBatchSize");
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    await checkedQuery(
      "exclusao de atendentes obsoletos",
      () => client.from(TABLE).delete().in("external_id", batch),
      options,
    );
  }
}

async function reconcileAttendantRows({
  client,
  rowsByDay,
  upsertRows,
  options = {},
}) {
  if (!client || typeof client.from !== "function") {
    throw new Error("Cliente Supabase invalido para reconciliacao de atendentes");
  }
  if (!(rowsByDay instanceof Map) || typeof upsertRows !== "function") {
    throw new Error("Parametros invalidos para reconciliacao de atendentes");
  }

  const existingByDay = new Map();
  const desiredIds = new Set();
  const allRows = [];
  for (const [day, rows] of rowsByDay) {
    validateDay(day);
    if (!Array.isArray(rows)) throw new Error("Linhas de atendentes invalidas");
    existingByDay.set(day, await readExistingIds(client, day, options));
    for (const row of rows) {
      if (!row?.external_id || !row.external_id.startsWith(`attendant-${day}-v2-`)) {
        throw new Error("external_id atual de atendente invalido");
      }
      desiredIds.add(row.external_id);
      allRows.push(row);
    }
  }

  if (allRows.length) {
    await upsertRows({
      client,
      table: TABLE,
      rows: allRows,
      onConflict: "external_id",
    });
  }

  const obsoleteIds = [];
  for (const ids of existingByDay.values()) {
    for (const externalId of ids) {
      if (!desiredIds.has(externalId)) obsoleteIds.push(externalId);
    }
  }
  await deleteObsoleteIds(client, obsoleteIds, options);

  return { deleted: obsoleteIds.length, upserted: allRows.length };
}

module.exports = {
  attendantExternalId,
  buildAttendantRows,
  canonicalize,
  readExistingIds,
  reconcileAttendantRows,
};
