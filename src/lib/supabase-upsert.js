const {
  isRetryableNetworkError,
  isRetryableStatus,
  withHttpRetry,
} = require("./http-retry");

function positiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} precisa ser inteiro >= 1`);
  }
  return parsed;
}

function statusOf(error) {
  return Number(error?.response?.status || error?.status || 0);
}

function retryableSupabaseError(error) {
  const status = statusOf(error);
  return (
    isRetryableStatus(status) ||
    (status >= 500 && status <= 599) ||
    isRetryableNetworkError(error) ||
    isRetryableNetworkError(error?.cause) ||
    (error?.name === "TypeError" && /fetch failed/i.test(error.message || ""))
  );
}

function safeSupabaseError(error, status) {
  const code = error?.code || "unknown";
  const wrapped = new Error(
    `Supabase upsert falhou: status=${status || "unknown"} code=${code}`,
  );
  if (error?.code) wrapped.code = error.code;
  if (status) wrapped.response = { status, headers: {} };
  return wrapped;
}

async function upsertRows({
  client,
  supabase,
  table,
  rows,
  onConflict = "external_id",
  batchSize = process.env.SUPABASE_BATCH_SIZE || 500,
  maxAttempts = process.env.SUPABASE_MAX_ATTEMPTS || 4,
  baseMs = 1500,
  maxMs = 60000,
}) {
  client = client || supabase;
  if (!client || !table || !Array.isArray(rows)) {
    throw new Error("Parametros invalidos para upsert Supabase");
  }
  const safeBatchSize = positiveInteger(batchSize, 500, "SUPABASE_BATCH_SIZE");
  const safeMaxAttempts = positiveInteger(
    maxAttempts,
    4,
    "SUPABASE_MAX_ATTEMPTS",
  );

  for (let offset = 0; offset < rows.length; offset += safeBatchSize) {
    const batch = rows.slice(offset, offset + safeBatchSize);
    await withHttpRetry(
      async () => {
        const result = await client
          .from(table)
          .upsert(batch, { onConflict });
        if (result.error) {
          throw safeSupabaseError(result.error, Number(result.status || result.error.status || 0));
        }
      },
      {
        maxAttempts: safeMaxAttempts,
        baseMs,
        maxMs,
        shouldRetry: retryableSupabaseError,
        onRetry: ({ nextAttempt, waitMs, status, code }) => {
          console.warn(
            `[${table}] upsert transitorio; tentativa ${nextAttempt}/${safeMaxAttempts} ` +
              `em ${Math.ceil(waitMs / 1000)}s (status=${status || "network"}, code=${code || "unknown"})`,
          );
        },
      },
    );
  }
}

const upsertInBatches = upsertRows;

module.exports = { retryableSupabaseError, upsertInBatches, upsertRows };
