const axios = require("axios");
const GoogleSheets = require("../google/google-sheets");

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

// ================================
// REMOVE DUPLICADOS (COLUNA J)
// MANTÉM A LINHA MAIS RECENTE
// ================================

async function removerDuplicados({ SPREADSHEET_ID, gHeaders }) {
  secureLog("Removendo duplicados...");

  const res = await axios.get(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Faturamento!A:R`,
    {
      headers: gHeaders,
    },
  );

  const rows = res.data.values || [];

  if (rows.length <= 1) {
    secureLog("Nenhum dado encontrado.");
    return;
  }

  const header = rows[0];
  const dataRows = rows.slice(1);

  const vistos = new Set();

  const filtradasReverso = [];

  // percorre de baixo pra cima
  // mantém a última ocorrência
  for (let i = dataRows.length - 1; i >= 0; i--) {
    const row = dataRows[i];

    const pedido = row[9]; // coluna J

    if (!pedido) continue;

    if (!vistos.has(pedido)) {
      vistos.add(pedido);

      filtradasReverso.push(row);
    }
  }

  const filtradas = [header, ...filtradasReverso.reverse()];

  const removidos = rows.length - filtradas.length;

  secureLog(`${removidos} duplicados removidos.`);

  // limpa planilha
  await axios.post(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Faturamento!A:R:clear`,
    {},
    {
      headers: gHeaders,
    },
  );

  // reescreve limpa
  await axios.put(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Faturamento!A1?valueInputOption=USER_ENTERED`,
    {
      values: filtradas,
    },
    {
      headers: gHeaders,
    },
  );

  secureLog("Deduplicação finalizada.");
}

// ================================
// EXECUÇÃO PRINCIPAL
// ================================

async function run() {
  try {
    const {
      SIGE_TOKEN,
      SIGE_USER,
      SIGE_APP,
      GOOGLE_TOKEN,
      SIGE_SPREADSHEET_ID,
    } = process.env;
    const SPREADSHEET_ID = SIGE_SPREADSHEET_ID;

    const gHeaders = {
      Authorization: `Bearer ${GOOGLE_TOKEN}`,
      "Content-Type": "application/json",
    };
    const sheets = new GoogleSheets({
      spreadsheetId: SPREADSHEET_ID,
      accessToken: GOOGLE_TOKEN,
    });
    const currentHeader = (await sheets.getValues("Faturamento!A1:R1"))[0];
    if (!currentHeader || currentHeader.length !== 18)
      throw new Error("Cabecalho Faturamento invalido");

    const sigeHeaders = {
      "Authorization-Token": SIGE_TOKEN,
      User: SIGE_USER,
      App: SIGE_APP,
      "Content-Type": "application/json",
    };

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

    const resErp = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ERP!A:AH`,
      {
        headers: gHeaders,
      },
    );

    const erpRows = resErp.data.values || [];

    const COL = {
      CPF: 3,
      TIPO: 6,
      RESP: 15,
      DATA: 19,
    };

    // ================================
    // PROCESSA DIAS
    // ================================

    let dataAtual = new Date(inicio);
    const collectedRows = [];

    while (dataAtual <= ontem) {
      const dataBusca = dataAtual.toISOString().split("T")[0];

      secureLog(`Processando ${dataBusca}`);

      const resSige = await axios.get(
        "https://api.sigecloud.com.br/request/Pedidos/Pesquisar",
        {
          headers: sigeHeaders,
          params: {
            status: "Pedido Faturado",
            dataInicial: dataBusca,
            dataFinal: dataBusca,
            filtrarPor: 3,
            pageSize: 100,
          },
        },
      );

      const pedidos = resSige.data || [];

      if (pedidos.length === 0) {
        secureLog(`Nenhum pedido encontrado em ${dataBusca}`);

        dataAtual.setDate(dataAtual.getDate() + 1);

        await sleep(3000);

        continue;
      }

      const rowsFinal = [];

      for (const p of pedidos) {
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

        erpRows
          .slice()
          .reverse()
          .forEach((r) => {
            const erpCpfLimpo = (r[COL.CPF] || "").replace(/\D/g, "");

            if (erpCpfLimpo !== clienteCpfLimpo) {
              return;
            }

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
                return;
              }

              const [d, m, y] = dataERPStr.split("/");

              const dataERP = new Date(y, m - 1, d);

              if (dataERP <= dataVenda) {
                serialRetirada = dateToExcelSerial(dataERPStr);

                respRetirada = r[COL.RESP] || "Sem vendedor";
              }
            }
          });

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
      /* append substituido pela atualizacao atomica ao final
      await axios.post(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Faturamento:append?valueInputOption=USER_ENTERED`,
        {
          values: rowsFinal,
        },
        {
          headers: gHeaders,
        },
      ); */

      secureLog(`${rowsFinal.length} registros adicionados (${dataBusca})`);

      dataAtual.setDate(dataAtual.getDate() + 1);

      await sleep(4000);
    }

    // ================================
    // REMOVE DUPLICADOS
    // ================================

    const pedidoIds = new Set(collectedRows.map((row) => String(row[9] || "")));
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
      shouldReplace: (row) => pedidoIds.has(String(row[9] || "")),
    });
    secureLog(
      `${result.removed} registros substituidos por ${result.inserted}.`,
    );

    secureLog("Processo finalizado com sucesso.");
  } catch (err) {
    secureLog("Erro crítico na execução.", true);

    process.exit(1);
  }
}

run();
