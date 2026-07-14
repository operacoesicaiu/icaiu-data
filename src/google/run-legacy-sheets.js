const path = require("path");
const { getGoogleAccessToken } = require("./google-auth");

async function main() {
  const script = process.argv[2];
  if (!script) throw new Error("Informe o script legado a executar");
  const missing = String(process.env.REQUIRED_ENV || "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name && !process.env[name]);
  if (missing.length)
    throw new Error(`Variaveis obrigatorias ausentes: ${missing.join(", ")}`);
  process.env.GOOGLE_TOKEN = await getGoogleAccessToken();
  require(path.resolve(__dirname, "..", "legacy-sheets", script));
}

main().catch((error) => {
  console.error(`Falha ao preparar autenticacao Google: ${error.message}`);
  process.exit(1);
});
