const GoogleSheets = require("../../google/sheets");
const formatPublicError = require("../../lib/public-error");
const { listSigeOrdersForDay } = require("../api");

// ================================
// CONFIG
// ================================

const DIAS_REPROCESSAR = 5;

// ================================
// UTILITÁRIOS
// ================================

function secureLog(message, isError = false) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${isError ? "ERROR" : "INFO"}] ${message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitize(val) {
  if (typeof val !== "string") return val;

  const formulaChars = ["=", "+", "-", "@"];

  if (formulaChars.some((char) => val.startsWith(char))) {
    return `'${val}`;
  }

  return val;
}

function formatarDataBR(dataInput) {
  if (!dataInput) return "";

  return new Date(dataInput).toLocaleDateString("pt-BR");
}

function dateToExcelSerial(dateStr) {
  if (!dateStr || typeof dateStr !== "string" || !dateStr.includes("/")) {
    return "";
  }

  const [d, m, y] = dateStr.split("/");

  const date = new Date(y, m - 1, d);

  if (isNaN(date)) return "";

  return Math.floor(
    25569 + (date.getTime() - date.getTimezoneOffset() * 60000) / 86400000,
  );
}

function parseSheetDate(value) {
  const text = String(value || "").split(" ")[0];
  const br = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1]));
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  return null;
}

function normalizeHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const FATURAMENTO_HEADER = [
  "Contato",
  "Código",
  "Status Venda",
  "Data",
  "Nome Cliente",
  "Telefone Cliente",
  "E-mail Cliente",
  "Valor Venda",
  "Local Técnico",
  "Nº Documento",
  "CPF/CNPJ Cliente",
  "Dia agendado novos serviços",
  "Colaborador",
  "Valor de venda do novo serviço",
  "Dia agendado retirada",
  "Responsável pela venda Retirada",
  "Valor de venda da retirada",
  "Mês",
].map(normalizeHeader);

function validateFaturamentoHeader(header) {
  if (!Array.isArray(header) || header.length !== FATURAMENTO_HEADER.length) {
    throw new Error("Cabecalho Faturamento invalido");
  }
  const normalized = header.map(normalizeHeader);
  const valid = normalized.every(
    (value, index) => value === FATURAMENTO_HEADER[index],
  );
  if (!valid) throw new Error("Ordem das colunas de Faturamento esta invalida");
}

// ================================
// EXECUÇÃO PRINCIPAL
// ================================

async function run() {
  try {
    const {
      GOOGLE_TOKEN,
      SIGE_SPREADSHEET_ID,
    } = process.env;
    const SPREADSHEET_ID = SIGE_SPREADSHEET_ID;

    const sheets = new GoogleSheets({
      spreadsheetId: SPREADSHEET_ID,
      accessToken: GOOGLE_TOKEN,
    });
    const currentHeader = (await sheets.getValues("Faturamento!A1:R1"))[0];
    validateFaturamentoHeader(currentHeader);

    // ================================
    // RANGE DE DATAS
    // ================================

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    const ontem = new Date(hoje);
    ontem.setDate(hoje.getDate() - 1);

    const inicio = new Date(hoje);
    inicio.setDate(hoje.getDate() - DIAS_REPROCESSAR);

    secureLog(`Reprocessando últimos ${DIAS_REPROCESSAR} dias.`);

    // ================================
    // CARREGA ERP
    // ================================

    const erpRows = await sheets.getValues("ERP!A:AH");

    const COL = {
      CPF: 3,
      TIPO: 6,
      RESP: 15,
      DATA: 19,
    };
    const erpByCpf = new Map();
    for (let index = erpRows.length - 1; index >= 1; index--) {
      const row = erpRows[index];
      const cpf = String(row[COL.CPF] || "").replace(/\D/g, "");
      if (!cpf) continue;
      if (!erpByCpf.has(cpf)) erpByCpf.set(cpf, []);
      erpByCpf.get(cpf).push(row);
    }

    // ================================
    // PROCESSA DIAS
    // ================================

    let dataAtual = new Date(inicio);
    const collectedRows = [];

    while (dataAtual <= ontem) {
      const dataBusca = dataAtual.toISOString().split("T")[0];

      secureLog(`Processando ${dataBusca}`);

      const pedidos = await listSigeOrdersForDay(dataBusca);

      if (pedidos.length === 0) {
        secureLog(`Nenhum pedido encontrado em ${dataBusca}`);

        dataAtual.setDate(dataAtual.getDate() + 1);

        await sleep(3000);

        continue;
      }

      const rowsFinal = [];

      for (const p of pedidos) {
        if (p.Codigo === undefined || p.Codigo === null || p.Codigo === "") {
          throw new Error("SIGE retornou pedido sem Codigo");
        }
        const clienteCpf = p.ClienteCNPJ || "";

        const clienteCpfLimpo = clienteCpf.replace(/\D/g, "");

        let serialNovo = "";
        let respNovo = "Sem vendedor";

        let serialRetirada = "";
        let respRetirada = "Sem vendedor";

        const dataVenda = new Date(p.DataFaturamento || p.Data);

        const valorTotal = Number(p.ValorFinal || 0);

        // ================================
        // PROCURA NO ERP
        // ================================

        for (const r of erpByCpf.get(clienteCpfLimpo) || []) {
            const tipo = (r[COL.TIPO] || "").toLowerCase();

            const dataERPStr = r[COL.DATA];

            // NOVO
            if (tipo.includes("novo") && serialNovo === "") {
              serialNovo = dateToExcelSerial(dataERPStr);

              respNovo = r[COL.RESP] || "Sem vendedor";
            }

            // RETIRADA
            if (tipo.includes("retirada") && serialRetirada === "") {
              if (!dataERPStr || !dataERPStr.includes("/")) {
                continue;
              }

              const [d, m, y] = dataERPStr.split("/");

              const dataERP = new Date(y, m - 1, d);

              if (dataERP <= dataVenda) {
                serialRetirada = dateToExcelSerial(dataERPStr);

                respRetirada = r[COL.RESP] || "Sem vendedor";
              }
            }
            if (serialNovo !== "" && serialRetirada !== "") break;
        }

        const displayNovo = serialNovo !== "" ? `'${serialNovo}` : 0;

        const displayRetirada =
          serialRetirada !== "" ? `'${serialRetirada}` : 0;

        rowsFinal.push([
          sanitize(""),
          p.Codigo,
          sanitize(p.StatusSistema || ""),
          formatarDataBR(dataVenda),
          sanitize(p.Cliente || ""),
          "",
          sanitize(p.ClienteEmail || ""),
          valorTotal,
          sanitize(p.Vendedor || ""),
          sanitize(`Pedido ${p.Codigo}`),
          sanitize(clienteCpf),
          displayNovo,
          sanitize(respNovo),
          serialRetirada !== "" ? valorTotal * 0.5 : valorTotal,
          displayRetirada,
          sanitize(respRetirada),
          serialRetirada !== "" ? valorTotal * 0.5 : 0,
          `${dataVenda.getMonth() + 1}/${dataVenda.getFullYear()}`,
        ]);
      }

      // ================================
      // APPEND
      // ================================

      collectedRows.push(...rowsFinal);
      secureLog(`${rowsFinal.length} registros adicionados (${dataBusca})`);

      dataAtual.setDate(dataAtual.getDate() + 1);

      await sleep(4000);
    }

    // ================================
    // REMOVE DUPLICADOS
    // ================================

    const uniqueRows = [
      ...new Map(
        collectedRows.map((row) => [String(row[9] || ""), row]),
      ).values(),
    ];
    const result = await sheets.replaceRows({
      sheetTitle: "Faturamento",
      columnRange: "A:R",
      header: currentHeader,
      newRows: uniqueRows,
      matchColumnIndexes: [3],
      shouldReplace: (row) => {
        const date = parseSheetDate(row[3]);
        return date && date >= inicio && date <= ontem;
      },
    });
    secureLog(
      `${result.removed} registros substituidos por ${result.inserted}.`,
    );

    secureLog("Processo finalizado com sucesso.");
  } catch (err) {
    secureLog(`Erro critico: ${formatPublicError(err)}`, true);
    throw err;
  }
}

module.exports = run;
module.exports.validateFaturamentoHeader = validateFaturamentoHeader;

if (require.main === module) {
  run().catch(() => {
    process.exitCode = 1;
  });
}
