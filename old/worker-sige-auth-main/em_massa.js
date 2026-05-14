const axios = require('axios');

const DATA_INICIO_BR = "01/04/2026"; 
const DATA_FIM_BR    = "30/04/2026"; 

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function sanitize(val) {
    if (typeof val !== 'string') return val;
    const formulaChars = ['=', '+', '-', '@'];
    if (formulaChars.some(char => val.startsWith(char))) return `'${val}`;
    return val;
}

function formatarDataBR(dataInput) {
    if (!dataInput) return "";
    const data = new Date(dataInput);
    return data.toLocaleDateString('pt-BR');
}

function dateToExcelSerial(dateStr) {
    if (!dateStr || typeof dateStr !== 'string' || !dateStr.includes('/')) return "";
    const partes = dateStr.split('/');
    const date = new Date(partes[2], partes[1] - 1, partes[0]);
    if (isNaN(date)) return "";
    const returnDateTime = 25569.0 + (date.getTime() - (date.getTimezoneOffset() * 60 * 1000)) / (1000 * 60 * 60 * 24);
    return Math.floor(returnDateTime);
}

function brStringToDate(dateStr) {
    const [d, m, y] = dateStr.split('/');
    return new Date(y, m - 1, d);
}

async function run() {
    try {
        const { SIGE_TOKEN, SIGE_USER, SIGE_APP, GOOGLE_TOKEN, SPREADSHEET_ID, ERP_SPREADSHEET_ID } = process.env;
        const gHeaders = { 'Authorization': `Bearer ${GOOGLE_TOKEN}`, 'Content-Type': 'application/json' };
        const sigeHeaders = { "Authorization-Token": SIGE_TOKEN, "User": SIGE_USER, "App": SIGE_APP, "Content-Type": "application/json" };

        const resErp = await axios.get(`https://sheets.googleapis.com/v4/spreadsheets/${ERP_SPREADSHEET_ID}/values/ERP!A:AH`, { 
            headers: gHeaders,
            timeout: 60000 
        });
        const erpRows = (resErp.data.values || []).slice(-25000); 
        const COL = { CPF: 3, TIPO: 6, RESP: 15, CHAVE: 16, DATA: 19 };

        let dataAtual = brStringToDate(DATA_INICIO_BR);
        const dataFinal = brStringToDate(DATA_FIM_BR);

        while (dataAtual <= dataFinal) {
            const dataBusca = dataAtual.toISOString().split('T')[0];

            const resSige = await axios.get("https://api.sigecloud.com.br/request/Pedidos/Pesquisar", {
                headers: sigeHeaders,
                params: { status: "Pedido Faturado", dataInicial: dataBusca, dataFinal: dataBusca, filtrarPor: 3, pageSize: 100 },
                timeout: 60000
            });

            const pedidos = resSige.data || [];
            const rowsFinal = [];

            if (pedidos.length > 0) {
                for (const p of pedidos) {
                    const clienteCpf = p.ClienteCNPJ || "";
                    const clienteCpfLimpo = clienteCpf.replace(/\D/g, "");
                    
                    let c = {};
                    if (clienteCpf) {
                        try {
                            await sleep(800); // Delay conservador para evitar bloqueio no SIGE
                            const resP = await axios.get("https://api.sigecloud.com.br/request/Pessoas/Pesquisar", {
                                headers: sigeHeaders, 
                                params: { cpfcnpj: clienteCpf },
                                timeout: 30000
                            });
                            if (resP.data && resP.data.length > 0) c = resP.data[0];
                        } catch (e) {}
                    }

                    let serialNovo = "", respNovo = "Sem vendedor", serialRetirada = "", respRetirada = "Sem vendedor";
                    const dataVenda = new Date(p.DataFaturamento || p.Data);
                    const valorTotal = p.ValorFinal || 0;

                    erpRows.slice().reverse().forEach(r => {
                        const erpCpfLimpo = (r[COL.CPF] || "").replace(/\D/g, "");
                        if (erpCpfLimpo !== clienteCpfLimpo) return;

                        const tipo = (r[COL.TIPO] || "").toLowerCase();
                        const dataERPStr = r[COL.DATA];
                        
                        if (tipo.includes("novo") && serialNovo === "") {
                            serialNovo = dateToExcelSerial(dataERPStr);
                            respNovo = r[COL.RESP] || "Sem vendedor";
                        }

                        if (tipo.includes("retirada") && serialRetirada === "") {
                            const partes = dataERPStr.split('/');
                            const dataERP = new Date(partes[2], partes[1] - 1, partes[0]);
                            if (dataERP <= dataVenda) {
                                serialRetirada = dateToExcelSerial(dataERPStr);
                                respRetirada = r[COL.RESP] || "Sem vendedor";
                            }
                        }
                    });

                    const displayNovo = serialNovo !== "" ? `'${serialNovo}` : 0;
                    const displayRetirada = serialRetirada !== "" ? `'${serialRetirada}` : 0;

                    rowsFinal.push([
                        sanitize((c.Celular || p.ClienteTelefone || "").replace("+", "")),
                        p.Codigo,
                        sanitize(p.StatusSistema || ""),
                        formatarDataBR(dataVenda),
                        sanitize(c.NomeFantasia || p.Cliente || ""),
                        sanitize(c.Telefone || ""),
                        sanitize(c.Email || p.ClienteEmail || ""),
                        valorTotal,
                        sanitize(p.Vendedor || ""),
                        sanitize(`Pedido ${p.Codigo}${p.NumeroNFe ? ' / NF Nº ' + p.NumeroNFe : ''}`),
                        sanitize(clienteCpf),
                        displayNovo,
                        sanitize(respNovo),
                        serialRetirada !== "" ? (valorTotal * 0.5) : valorTotal,
                        displayRetirada,
                        sanitize(respRetirada),
                        serialRetirada !== "" ? (valorTotal * 0.5) : 0,
                        `${dataVenda.getMonth() + 1}/${dataVenda.getFullYear()}`
                    ]);
                }

                if (rowsFinal.length > 0) {
                    await axios.post(
                        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Faturamento:append?valueInputOption=USER_ENTERED`,
                        { values: rowsFinal }, 
                        { headers: gHeaders, timeout: 60000 }
                    );
                    await sleep(5000); // Pausa longa para o Google organizar a planilha
                }
            }

            dataAtual.setDate(dataAtual.getDate() + 1);
            await sleep(10000); // 10 segundos de descanso entre os dias faturados
        }
    } catch (err) {
        process.exit(1);
    }
}

run();
