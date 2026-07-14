const axios = require("axios");

// Helper para esperar entre requisições (Rate Limit)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Segurança: Sanitiza strings para evitar "Spreadsheet Formula Injection".
 * Adiciona um apóstrofo (') se o texto começar com caracteres de fórmula.
 */
function sanitize(val) {
  if (typeof val !== "string") return val;
  const formulaChars = ["=", "+", "-", "@"];
  if (formulaChars.some((char) => val.startsWith(char))) {
    return `'${val}`;
  }
  return val;
}

function parseDataBR(texto) {
  if (!texto) return null;
  try {
    const limpo = texto.replace(",", "").trim().split(" ")[0];
    const [d, m, y] = limpo.split("/");
    if (!d || !m || !y) return null;
    const dataISO = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T00:00:00Z`;
    const dObj = new Date(dataISO);
    return isNaN(dObj.getTime()) ? null : dObj;
  } catch (e) {
    return null;
  }
}

function formatarDataBR(dataISO) {
  if (!dataISO) return "";
  try {
    return new Date(new Date(dataISO).getTime() - 3 * 3600000)
      .toLocaleString("pt-BR", { timeZone: "UTC" })
      .replace(",", "");
  } catch (e) {
    return "";
  }
}

async function run() {
  const {
    GOOGLE_TOKEN,
    HABLLA_EMAIL,
    HABLLA_PASSWORD,
    HABLLA_WORKSPACE_ID,
    HABLLA_BOARD_ID,
    SPREADSHEET_ID,
    HABLLA_TOKEN,
  } = process.env;

  // Verificação básica de ambiente para evitar erro de runtime
  if (!GOOGLE_TOKEN) {
    console.error("ERRO CRÍTICO: GOOGLE_TOKEN ausente.");
    return;
  }

  if (!HABLLA_WORKSPACE_ID) {
    console.error("ERRO CRÍTICO: HABLLA_WORKSPACE_ID ausente.");
    return;
  }

  const gHeaders = {
    Authorization: `Bearer ${GOOGLE_TOKEN}`,
    "Content-Type": "application/json",
  };

  try {
    // --- 1. PREPARAÇÃO ---
    console.log(">>> [ETAPA 1] Metadados...");
    const meta = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`,
      { headers: gHeaders },
    );
    const sheetHablla = meta.data.sheets.find(
      (s) => s.properties.title === "Base Hablla Card",
    );

    if (!sheetHablla) throw new Error("Aba 'Base Hablla Card' não encontrada.");
    const idBaseHablla = sheetHablla.properties.sheetId;

    // Verifica se a aba 'Base Cliente' existe
    const sheetCliente = meta.data.sheets.find(
      (s) => s.properties.title === "Base Cliente",
    );
    const hasBaseCliente = !!sheetCliente;
    const idBaseCliente = hasBaseCliente
      ? sheetCliente.properties.sheetId
      : null;

    // --- 1. AUTENTICAÇÃO HABLLA ---
    let hToken = HABLLA_TOKEN;
    let isWorkspaceToken = false;

    if (!hToken) {
      if (!HABLLA_EMAIL || !HABLLA_PASSWORD) {
        console.error(
          "ERRO: Para autenticação Hablla, defina HABLLA_TOKEN ou HABLLA_EMAIL + HABLLA_PASSWORD.",
        );
        return;
      }
      console.log(">>> Fazendo login no Hablla...");
      const login = await axios.post(
        "https://api.hablla.com/v1/authentication/login",
        { email: HABLLA_EMAIL, password: HABLLA_PASSWORD },
      );
      hToken = login.data.accessToken;
      console.log("Login realizado com sucesso.");
    } else {
      // Detectar tipo de token
      if (hToken.startsWith("ey")) {
        console.log(">>> Usando User Token do Hablla");
      } else {
        console.log(">>> Usando Workspace Token do Hablla (recomendado)");
        isWorkspaceToken = true;
      }
    }

    const hHeaders = {
      Authorization: isWorkspaceToken ? hToken : `Bearer ${hToken}`,
      accept: "application/json",
    };

    // Rate limit entre requisições Hablla (500ms)
    await sleep(500);

    const hoje = new Date();
    const seteDiasAtras = new Date();
    seteDiasAtras.setDate(hoje.getDate() - 7);
    seteDiasAtras.setHours(0, 0, 0, 0);

    // --- 2. LIMPEZA SEGURANÇA (7 DIAS) ---
    console.log(">>> [ETAPA 2] Limpeza de segurança...");
    const resSheet = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Base%20Hablla%20Card!A:B`,
      { headers: gHeaders },
    );

    if (resSheet.data?.values) {
      const rows = resSheet.data.values;
      let blocos = [],
        startIdx = -1,
        cont = 0;
      for (let i = rows.length - 1; i >= 1; i--) {
        const dt = parseDataBR(rows[i][1]);
        if (dt && dt >= seteDiasAtras) {
          if (startIdx === -1) startIdx = i;
          cont = 0;
        } else {
          cont++;
          if (startIdx !== -1) {
            blocos.push({ start: i + 1, end: startIdx + 1 });
            startIdx = -1;
          }
          if (cont >= 20) break;
        }
      }
      if (startIdx !== -1) blocos.push({ start: 1, end: startIdx + 1 });

      if (blocos.length > 0) {
        const requests = blocos.map((b) => ({
          deleteDimension: {
            range: {
              sheetId: idBaseHablla,
              dimension: "ROWS",
              startIndex: b.start,
              endIndex: b.end,
            },
          },
        }));
        await axios.post(
          `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`,
          { requests },
          { headers: gHeaders },
        );
      }
    }

    // --- 3. SINCRONIZAÇÃO CARDS ---
    console.log(">>> [ETAPA 3] Sincronizando Cards...");
    let page = 1;
    while (page <= 500) {
      const resApi = await axios.get(
        `https://api.hablla.com/v3/workspaces/${HABLLA_WORKSPACE_ID}/cards`,
        {
          params: {
            board: HABLLA_BOARD_ID,
            limit: 50,
            page: page,
            updated_after: seteDiasAtras.toISOString(),
          },
          headers: hHeaders,
        },
      );

      // Rate limit entre requisições Hablla
      await sleep(500);

      const cards = resApi.data.results || [];
      if (cards.length === 0) break;

      const rowsToInsert = cards
        .filter((c) => new Date(c.created_at) >= seteDiasAtras)
        .map((card) => {
          let cf = ["", "", "", "", ""];
          const customFieldIds = [
            "67b39131ee792966f3fba492",
            "67b608470787782ce7acafba",
            "67dc6a0a17925c23d8365708",
            "679120ec177ff6d2c7597156",
            "69e8d49592607a5877e699d5",
          ];
          (card.custom_fields || []).forEach((f) => {
            const idx = customFieldIds.indexOf(f.custom_field);
            if (idx !== -1) cf[idx] = f.value;
          });

          const uid =
            card.user && typeof card.user === "object"
              ? card.user.id
              : card.user || "";
          const userName =
            card.user && typeof card.user === "object"
              ? card.user.name || card.user.email || ""
              : "";

          // Sanitização aplicada em campos de texto livre
          return [
            formatarDataBR(card.updated_at),
            formatarDataBR(card.created_at),
            card.workspace,
            card.board,
            card.list,
            sanitize(cf[0]),
            sanitize(cf[1]),
            sanitize(cf[2]),
            sanitize(card.name),
            sanitize(card.description),
            card.source,
            card.status,
            uid,
            formatarDataBR(card.finished_at),
            card.id,
            sanitize(userName),
            sanitize(cf[3]),
            (card.tags || []).map((t) => t.name).join(", "),
            sanitize(cf[4]),
          ];
        });

      if (rowsToInsert.length > 0) {
        await axios.post(
          `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Base%20Hablla%20Card!A:A:append?valueInputOption=USER_ENTERED`,
          { values: rowsToInsert },
          { headers: gHeaders },
        );
        await sleep(1200);
      }

      if (
        !cards.some((c) => new Date(c.created_at) >= seteDiasAtras) &&
        page > 2
      )
        break;
      page++;
    }

    // --- 4. FAXINA DUPLICADOS ---
    console.log(">>> [ETAPA 4] Faxina de duplicados...");
    const resF = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Base%20Hablla%20Card!A:R`,
      { headers: gHeaders },
    );
    if (resF.data?.values) {
      const rows = resF.data.values;
      const mapU = new Map();
      rows.slice(1).forEach((l) => {
        if (l[14]) mapU.set(l[14], l);
      });
      const final = [rows[0], ...mapU.values()];

      await axios.post(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Base%20Hablla%20Card!A:R:clear`,
        {},
        { headers: gHeaders },
      );
      await axios.put(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Base%20Hablla%20Card!A1`,
        { values: final },
        { params: { valueInputOption: "USER_ENTERED" }, headers: gHeaders },
      );
    }

    // --- 5. BASE ATENDENTE ---
    console.log(">>> [ETAPA 5] Processando Base Atendente...");
    const ontem = new Date();
    ontem.setDate(ontem.getDate() - 1);
    const dIni = new Date(ontem.setHours(0, 0, 0, 0)).toISOString();
    const dFim = new Date(ontem.setHours(23, 59, 59, 999)).toISOString();

    const resAt = await axios.get(
      `https://api.hablla.com/v1/workspaces/${HABLLA_WORKSPACE_ID}/reports/services/summary`,
      {
        params: { start_date: dIni, end_date: dFim },
        headers: hHeaders,
      },
    );

    // Rate limit entre requisições Hablla
    await sleep(500);

    const rowsAt = (resAt.data.results || []).map((item) => {
      const u = item.user || {},
        s = item.sector || {},
        c = item.connection || {};
      return [
        new Date(dFim).toLocaleDateString("pt-BR"),
        HABLLA_WORKSPACE_ID,
        s.id || "",
        sanitize(s.name || ""),
        u.id || "",
        sanitize(u.name || ""),
        sanitize(u.email || ""),
        item.total_services || 0,
        item.tme || 0,
        item.tma || 0,
        c.id || "",
        sanitize(c.name || ""),
        c.type || "",
        item.total_csat || 0,
        item.total_csat_greater_4 || 0,
        item.csat || 0,
        item.total_fcr || 0,
      ];
    });

    if (rowsAt.length > 0) {
      await axios.post(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Base%20Atendente!A:A:append?valueInputOption=USER_ENTERED`,
        { values: rowsAt },
        { headers: gHeaders },
      );
    }

    // --- 6. BASE CLIENTE ---
    console.log(">>> [ETAPA 6] Processando Base Cliente...");

    // Buscar pessoas/clientes criados ontem
    let clientPage = 1;
    const allClients = [];
    const maxPages = 150;

    while (clientPage <= maxPages) {
      try {
        const resClients = await axios.get(
          `https://api.hablla.com/v1/workspaces/${HABLLA_WORKSPACE_ID}/persons`,
          {
            params: {
              start_date: dIni,
              end_date: dFim,
              page: clientPage,
              limit: 50,
              field_date: "created_at",
              populate: true,
            },
            headers: hHeaders,
          },
        );

        // Rate limit entre requisições Hablla
        await sleep(500);

        const data =
          resClients.data?.results ||
          resClients.data?.data ||
          resClients.data ||
          [];

        if (!Array.isArray(data) || data.length === 0) {
          break;
        }

        allClients.push(...data);

        if (data.length < 50) {
          break;
        }

        clientPage++;
      } catch (err) {
        console.error(
          `Erro na página ${clientPage} de clientes:`,
          err.response?.status,
          err.response?.data,
        );
        break;
      }
    }

    // Log removido para não expor dados em ambiente público

    if (allClients.length > 0 && hasBaseCliente) {
      // Processar clientes para o formato do Sheets
      const rowsClientes = allClients.map((person) => {
        // Extrair telefone principal
        let phone = "";
        let whatsapp = "";
        if (
          person.phones &&
          Array.isArray(person.phones) &&
          person.phones.length > 0
        ) {
          phone = person.phones[0].phone || "";
          if (person.phones[0].is_whatsapp) {
            whatsapp = "Sim";
          }
        }

        // Extrair emails
        let emailsStr = "";
        if (person.emails && Array.isArray(person.emails)) {
          emailsStr = person.emails
            .map((e) => {
              if (typeof e === "string") return e;
              if (typeof e === "object" && e.email) return e.email;
              return "";
            })
            .filter((e) => e)
            .join("; ");
        }

        // Extrair setores
        let sectorsStr = "";
        if (person.sectors && Array.isArray(person.sectors)) {
          sectorsStr = person.sectors.join("; ");
        }

        // Extrair tags
        let tagsStr = "";
        if (person.tags && Array.isArray(person.tags)) {
          tagsStr = person.tags
            .map((t) => {
              if (typeof t === "string") return t;
              if (typeof t === "object" && t.name) return t.name;
              return "";
            })
            .filter((t) => t)
            .join("; ");
        }

        // IDs fixos de custom_fields
        const fixedCustomFieldIds = [
          "6887db7cc2a3a46cebf75ea7",
          "67e6d711eb31b8892b75849a",
          "67e6d70ae8d3a28c98616065",
          "67ec621f8deaf73871b405d5",
          "67e6d5b88d506fc6c09408f9",
          "67af906d0b7fbf296df82ea4",
        ];

        // Extrair custom fields - separar fixos dos outros
        let customFieldsStr = "";
        const customFieldsMap = {};
        if (person.custom_fields && Array.isArray(person.custom_fields)) {
          person.custom_fields.forEach((cf) => {
            const fieldId = cf.custom_field;
            if (fieldId) {
              let value = cf.value;
              if (typeof value === "boolean") {
                value = value ? "Sim" : "Não";
              } else if (typeof value === "object") {
                value = JSON.stringify(value);
              }
              if (fixedCustomFieldIds.includes(fieldId)) {
                customFieldsMap[fieldId] = value;
              }
            }
          });
          // Concatenar apenas os fixos na ordem definida
          fixedCustomFieldIds.forEach((id) => {
            if (customFieldsMap[id] !== undefined) {
              customFieldsStr += `${id}: ${customFieldsMap[id]}; `;
            }
          });
          customFieldsStr = customFieldsStr.trim().replace(/; $/, "");
        }

        // Extrair usuários
        let usersStr = "";
        if (person.users && Array.isArray(person.users)) {
          usersStr = person.users.join("; ");
        }

        // Extrair outros campos (custom fields que não são fixos + outros campos do person)
        let outrosCamposStr = "";
        const camposEspecificos = [
          "name",
          "emails",
          "phones",
          "sectors",
          "tags",
          "custom_fields",
          "users",
          "id",
          "created_at",
          "updated_at",
          "workspace",
          "duplicate_keys",
          "instagrams",
          "facebooks",
          "followers",
          "sla_config_id",
          "workspace_id",
        ];
        const outrosCampos = [];

        // Adicionar custom fields que não são fixos
        if (person.custom_fields && Array.isArray(person.custom_fields)) {
          person.custom_fields.forEach((cf) => {
            const fieldId = cf.custom_field;
            if (fieldId && !fixedCustomFieldIds.includes(fieldId)) {
              let value = cf.value;
              if (typeof value === "boolean") {
                value = value ? "Sim" : "Não";
              } else if (typeof value === "object") {
                value = JSON.stringify(value);
              }
              outrosCampos.push(`${fieldId}: ${value}`);
            }
          });
        }

        // Adicionar outros campos do person
        Object.keys(person).forEach((key) => {
          if (
            !camposEspecificos.includes(key) &&
            person[key] !== null &&
            person[key] !== undefined
          ) {
            if (typeof person[key] === "object") {
              outrosCampos.push(`${key}: ${JSON.stringify(person[key])}`);
            } else {
              outrosCampos.push(`${key}: ${person[key]}`);
            }
          }
        });
        outrosCamposStr = outrosCampos.join("; ");

        // Retornar array com colunas fixas de custom fields
        return [
          person.id || "",
          sanitize(person.name || ""),
          phone,
          whatsapp,
          sanitize(emailsStr),
          person.created_at
            ? new Date(person.created_at)
                .toLocaleString("pt-BR")
                .replace(",", "")
            : "",
          person.updated_at
            ? new Date(person.updated_at)
                .toLocaleString("pt-BR")
                .replace(",", "")
            : "",
          sanitize(sectorsStr),
          sanitize(tagsStr),
          customFieldsMap["6887db7cc2a3a46cebf75ea7"] || "",
          customFieldsMap["67e6d711eb31b8892b75849a"] || "",
          customFieldsMap["67e6d70ae8d3a28c98616065"] || "",
          customFieldsMap["67ec621f8deaf73871b405d5"] || "",
          customFieldsMap["67e6d5b88d506fc6c09408f9"] || "",
          customFieldsMap["67af906d0b7fbf296df82ea4"] || "",
          sanitize(outrosCamposStr),
          sanitize(usersStr),
        ];
      });

      // Enviar para o Sheets
      await axios.post(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Base%20Cliente!A:A:append?valueInputOption=USER_ENTERED`,
        { values: rowsClientes },
        { headers: gHeaders },
      );

      // Log removido para não expor dados em ambiente público
    } else if (allClients.length > 0 && !hasBaseCliente) {
      console.log(
        "Aba 'Base Cliente' não encontrada. Pulando exportação de clientes.",
      );
    }

    console.log(">>> [SUCESSO] Processo concluído com segurança.");
  } catch (e) {
    // TRATAMENTO DE ERRO SEGURO:
    const errorMsg = e.response
      ? `Status ${e.response.status}: ${JSON.stringify(e.response.data)}`
      : e.message;
    console.error(">>> [ERRO CONTROLADO]:", errorMsg);
  }
}

run();
