const path = require("path");
const { spawn } = require("child_process");
const { getGoogleAccessToken } = require("./google-auth");

function runScript(script) {
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

async function main() {
  const scripts = process.argv.slice(2);
  if (!scripts.length) throw new Error("Informe ao menos uma sincronizacao");
  const missing = String(process.env.REQUIRED_ENV || "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name && !process.env[name]);
  if (missing.length)
    throw new Error(`Variaveis obrigatorias ausentes: ${missing.join(", ")}`);
  process.env.GOOGLE_TOKEN = await getGoogleAccessToken();
  for (const script of scripts) await runScript(script);
}

main().catch((error) => {
  console.error(`Falha na execucao das sincronizacoes: ${error.message}`);
  process.exit(1);
});
