const path = require("path");
const { spawn } = require("child_process");
const { getGoogleAccessTokenDetails } = require("../google/auth");
const { backoffMs, sleep } = require("../lib/http-retry");
const formatPublicError = require("../lib/public-error");

function runScriptOnce(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, "..", script)],
      {
        env: process.env,
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Sincronizacao falhou: ${script}`)),
    );
  });
}

async function runScript(script) {
  // API clients already retry only safe/transient requests. Re-running an entire
  // synchronization can duplicate writes or ignore a provider circuit-breaker.
  const maxAttempts = Number(process.env.SYNC_SCRIPT_MAX_ATTEMPTS || 1);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("SYNC_SCRIPT_MAX_ATTEMPTS precisa ser inteiro >= 1");
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await runScriptOnce(script);
      return;
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error;
      const waitMs = backoffMs(attempt, { baseMs: 5000, maxMs: 30000 });
      console.log(`Sincronizacao transitoria falhou; repetindo ${script} em ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }
}

async function main() {
  const scripts = process.argv.slice(2);
  if (!scripts.length) throw new Error("Informe ao menos uma sincronizacao");
  const missing = String(process.env.REQUIRED_ENV || "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name && !process.env[name]);
  if (missing.length)
    throw new Error(`Variaveis obrigatorias ausentes: ${missing.join(", ")}`);
  const token = await getGoogleAccessTokenDetails();
  process.env.GOOGLE_TOKEN = token.accessToken;
  process.env.GOOGLE_TOKEN_EXPIRES_AT = String(token.expiresAt);
  const failures = [];
  for (const script of scripts) {
    try {
      await runScript(script);
    } catch (error) {
      failures.push(script);
      console.error(`Sincronizacao falhou apos retries: ${script}`);
    }
  }
  if (failures.length) throw new Error(`${failures.length} sincronizacao(oes) falharam`);
}

main().catch((error) => {
  console.error(`Falha na execucao das sincronizacoes: ${formatPublicError(error)}`);
  process.exit(1);
});
