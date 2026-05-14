const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,

    ZENVIA_ACCESS_TOKEN,
    ZENVIA_QUEUE_ID
} = process.env;

const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
);

function secureLog(message, isError = false) {
    const timestamp = new Date().toISOString();

    console.log(
        `[${timestamp}] [${isError ? 'ERROR' : 'INFO'}] ${message}`
    );
}

function sanitize(val) {
    if (typeof val !== 'string') return val;

    const formulaChars = ['=', '+', '-', '@'];

    if (formulaChars.some(char => val.startsWith(char))) {
        return `'${val}`;
    }

    return val;
}

function formatarParaBR(dataISO) {

    if (!dataISO) return "";

    try {

        const data = new Date(dataISO);

        if (isNaN(data.getTime())) return "";

        return data.toLocaleString('pt-BR', {
            timeZone: 'America/Sao_Paulo'
        }).replace(',', '');

    } catch {

        return "";
    }
}

async function salvarLote(rows) {

    if (!rows.length) return;

    const { error } = await supabase
        .from('zenvia_calls')
        .upsert(rows, {
            onConflict: 'call_id'
        });

    if (error) {
        throw error;
    }
}

async function run() {

    try {

        secureLog('Iniciando sincronização Zenvia');

        const agoraBR = new Date(
            new Date().toLocaleString(
                "en-US",
                { timeZone: "America/Sao_Paulo" }
            )
        );

        const ontemBR = new Date(agoraBR);

        ontemBR.setDate(
            agoraBR.getDate() - 1
        );

        const dataOntemAlvo =
            ontemBR.toISOString().split('T')[0];

        const dataInicioBusca = new Date(agoraBR);

        dataInicioBusca.setDate(
            agoraBR.getDate() - 2
        );

        const dsInicio =
            dataInicioBusca.toISOString().split('T')[0];

        const dsFim =
            agoraBR.toISOString().split('T')[0];

        secureLog(
            `Buscando de ${dsInicio} até ${dsFim}`
        );

        let allCalls = [];

        let posicao = 0;

        const limite = 200;

        while (true) {

            const endpoint = ZENVIA_QUEUE_ID
                ? `https://voice-api.zenvia.com/fila/${ZENVIA_QUEUE_ID}/relatorio`
                : `https://voice-api.zenvia.com/chamada/relatorio`;

            const response = await axios.get(
                endpoint,
                {
                    params: {
                        data_inicio: dsInicio,
                        data_fim: dsFim,
                        posicao,
                        limite
                    },
                    headers: {
                        'Access-Token': ZENVIA_ACCESS_TOKEN,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const calls =
                response.data?.dados?.relatorio || [];

            if (!calls.length) {
                break;
            }

            allCalls.push(...calls);

            if (calls.length < limite) {
                break;
            }

            posicao += limite;

            if (posicao > 50000) {
                break;
            }
        }

        secureLog(
            `${allCalls.length} registros capturados`
        );

        const registrosFiltrados =
            allCalls.filter(item => {

                return (
                    item.data_inicio &&
                    item.data_inicio.startsWith(dataOntemAlvo)
                );
            });

        secureLog(
            `${registrosFiltrados.length} registros após filtro`
        );

        if (!registrosFiltrados.length) {

            secureLog(
                'Nenhum registro encontrado'
            );

            return;
        }

        const rows = registrosFiltrados.map(item => {

            const filaDataInicio =
                item.fila?.data_inicio || "";

            const ramalNumero =
                item.ramal?.numero || "";

            const atendida =
                item.atendida
                    ? "Atendida"
                    : "Não atendida";

            return {

                call_id: item.id || null,

                data_inicio_iso:
                    item.data_inicio || null,

                data_inicio_br:
                    formatarParaBR(item.data_inicio),

                fila_data_inicio_br:
                    formatarParaBR(filaDataInicio),

                origem:
                    sanitize(item.numero_origem || ""),

                destino:
                    sanitize(item.numero_destino || ""),

                ramal:
                    sanitize(ramalNumero),

                status:
                    sanitize(item.status || ""),

                atendida,

                duracao:
                    Number(item.duracao || 0),

                tempo_espera:
                    Number(item.tempo_espera || 0),

                fila_id:
                    item.fila?.id || null,

                ramal_id:
                    item.ramal?.id || null,

                gravacao_url:
                    item.url_gravacao || null,

                ativa:
                    item.ativa || false,

                created_at:
                    new Date().toISOString()
            };
        });

        const batchSize = 1000;

        for (let i = 0; i < rows.length; i += batchSize) {

            const batch =
                rows.slice(i, i + batchSize);

            await salvarLote(batch);

            secureLog(
                `Lote ${Math.floor(i / batchSize) + 1} salvo`
            );
        }

        secureLog(
            'Sincronização finalizada'
        );

    } catch (err) {

        secureLog(
            err.message || 'Erro crítico',
            true
        );

        process.exit(1);
    }
}

run();