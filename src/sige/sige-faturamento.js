const axios = require('axios');

const supabase = require('../lib/supabase');

const DIAS_REPROCESSAR = 5;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function secureLog(message, isError = false) {

    const timestamp = new Date().toISOString();

    console.log(
        `[${timestamp}] [${isError ? 'ERROR' : 'INFO'}] ${message}`
    );
}

function sanitize(val) {

    if (typeof val !== 'string') {
        return val;
    }

    const formulaChars = ['=', '+', '-', '@'];

    if (formulaChars.some(char => val.startsWith(char))) {
        return `'${val}`;
    }

    return val;
}

function formatarDataBR(dataInput) {

    if (!dataInput) {
        return "";
    }

    return new Date(dataInput)
        .toLocaleDateString('pt-BR');
}

function dateToExcelSerial(dateStr) {

    if (
        !dateStr ||
        typeof dateStr !== 'string' ||
        !dateStr.includes('/')
    ) {
        return "";
    }

    const [d, m, y] = dateStr.split('/');

    const date = new Date(y, m - 1, d);

    if (isNaN(date)) {
        return "";
    }

    return Math.floor(
        25569 +
        (
            date.getTime() -
            (date.getTimezoneOffset() * 60000)
        ) / 86400000
    );
}

async function run() {

    try {

        const {
            SIGE_TOKEN,
            SIGE_USER,
            SIGE_APP
        } = process.env;

        const sigeHeaders = {
            "Authorization-Token": SIGE_TOKEN,
            "User": SIGE_USER,
            "App": SIGE_APP,
            "Content-Type": "application/json"
        };

        // ============================
        // RANGE DATAS
        // ============================

        const hoje = new Date();

        hoje.setHours(0, 0, 0, 0);

        const ontem = new Date(hoje);

        ontem.setDate(
            hoje.getDate() - 1
        );

        const inicio = new Date(hoje);

        inicio.setDate(
            hoje.getDate() - DIAS_REPROCESSAR
        );

        secureLog(
            `Reprocessando ${DIAS_REPROCESSAR} dias`
        );

        // ============================
        // CARREGA ERP DO SUPABASE
        // ============================

        const {
            data: erpRows,
            error: erpError
        } = await supabase
            .from('erp')
            .select('*');

        if (erpError) {
            throw erpError;
        }

        // ============================
        // PROCESSAMENTO
        // ============================

        let dataAtual = new Date(inicio);

        while (dataAtual <= ontem) {

            const dataBusca =
                dataAtual.toISOString()
                    .split('T')[0];

            secureLog(
                `Processando ${dataBusca}`
            );

            const resSige = await axios.get(
                "https://api.sigecloud.com.br/request/Pedidos/Pesquisar",
                {
                    headers: sigeHeaders,
                    params: {
                        status: "Pedido Faturado",
                        dataInicial: dataBusca,
                        dataFinal: dataBusca,
                        filtrarPor: 3,
                        pageSize: 100
                    }
                }
            );

            const pedidos =
                resSige.data || [];

            if (pedidos.length === 0) {

                secureLog(
                    `Nenhum pedido em ${dataBusca}`
                );

                dataAtual.setDate(
                    dataAtual.getDate() + 1
                );

                await sleep(3000);

                continue;
            }

            const finalRows = [];

            for (const p of pedidos) {

                const clienteCpf =
                    p.ClienteCNPJ || "";

                const clienteCpfLimpo =
                    clienteCpf.replace(/\D/g, "");

                let serialNovo = "";
                let respNovo = "Sem vendedor";

                let serialRetirada = "";
                let respRetirada = "Sem vendedor";

                const dataVenda =
                    new Date(
                        p.DataFaturamento || p.Data
                    );

                const valorTotal =
                    Number(p.ValorFinal || 0);

                // ============================
                // PROCURA ERP
                // ============================

                [...erpRows]
                    .reverse()
                    .forEach(r => {

                        const erpCpfLimpo =
                            (r.cpf || "")
                                .replace(/\D/g, "");

                        if (
                            erpCpfLimpo !==
                            clienteCpfLimpo
                        ) {
                            return;
                        }

                        const tipo =
                            (r.tipo || "")
                                .toLowerCase();

                        const dataERPStr =
                            r.data || "";

                        // NOVO

                        if (
                            tipo.includes("novo") &&
                            serialNovo === ""
                        ) {

                            serialNovo =
                                dateToExcelSerial(
                                    dataERPStr
                                );

                            respNovo =
                                r.responsavel ||
                                "Sem vendedor";
                        }

                        // RETIRADA

                        if (
                            tipo.includes("retirada") &&
                            serialRetirada === ""
                        ) {

                            if (
                                !dataERPStr ||
                                !dataERPStr.includes('/')
                            ) {
                                return;
                            }

                            const [d, m, y] =
                                dataERPStr.split('/');

                            const dataERP =
                                new Date(
                                    y,
                                    m - 1,
                                    d
                                );

                            if (
                                dataERP <= dataVenda
                            ) {

                                serialRetirada =
                                    dateToExcelSerial(
                                        dataERPStr
                                    );

                                respRetirada =
                                    r.responsavel ||
                                    "Sem vendedor";
                            }
                        }
                    });

                // ============================
                // OBJETO FINAL
                // ============================

                const row = {

                    pedido_codigo:
                        p.Codigo,

                    status_sistema:
                        sanitize(
                            p.StatusSistema || ""
                        ),

                    data_venda:
                        formatarDataBR(
                            dataVenda
                        ),

                    cliente:
                        sanitize(
                            p.Cliente || ""
                        ),

                    cliente_email:
                        sanitize(
                            p.ClienteEmail || ""
                        ),

                    valor_total:
                        valorTotal,

                    vendedor:
                        sanitize(
                            p.Vendedor || ""
                        ),

                    pedido_nome:
                        sanitize(
                            `Pedido ${p.Codigo}`
                        ),

                    cliente_cpf:
                        sanitize(clienteCpf),

                    serial_novo:
                        serialNovo !== ""
                            ? serialNovo
                            : 0,

                    responsavel_novo:
                        sanitize(respNovo),

                    valor_novo:
                        serialRetirada !== ""
                            ? valorTotal * 0.5
                            : valorTotal,

                    serial_retirada:
                        serialRetirada !== ""
                            ? serialRetirada
                            : 0,

                    responsavel_retirada:
                        sanitize(respRetirada),

                    valor_retirada:
                        serialRetirada !== ""
                            ? valorTotal * 0.5
                            : 0,

                    mes_ano:
                        `${dataVenda.getMonth() + 1}/${dataVenda.getFullYear()}`
                };

                finalRows.push(row);
            }

            // ============================
            // UPSERT
            // ============================

            if (finalRows.length > 0) {

                const {
                    error
                } = await supabase
                    .from('sige_faturamento')
                    .upsert(
                        finalRows,
                        {
                            onConflict: 'pedido_codigo'
                        }
                    );

                if (error) {
                    throw error;
                }

                secureLog(
                    `${finalRows.length} registros sincronizados`
                );
            }

            dataAtual.setDate(
                dataAtual.getDate() + 1
            );

            await sleep(4000);
        }

        secureLog(
            "Processo concluído."
        );

    } catch (err) {

        console.error(
            err.response?.data ||
            err.message
        );

        process.exit(1);
    }
}

run();