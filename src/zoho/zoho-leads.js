const axios = require('axios');
const supabase = require('../lib/supabase');
const getZohoToken = require('../lib/zoho-auth');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sanitize(val) {
    if (typeof val !== 'string') return val;

    const formulaChars = ['=', '+', '-', '@'];

    if (formulaChars.some(c => val.startsWith(c))) {
        return `'${val}`;
    }

    return val;
}

function extractValue(value) {
    if (value === null || value === undefined || value === '') {
        return '';
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
        return sanitize(value.display_value || value.ID || String(value));
    }

    if (Array.isArray(value)) {
        return sanitize(
            value.map(v =>
                typeof v === 'object'
                    ? v.display_value || v
                    : v
            ).join(', ')
        );
    }

    return sanitize(String(value));
}

async function run() {
    try {
        const {
            ZOHO_ACCOUNT_OWNER,
            ZOHO_LEADS_APP_NAME,
            ZOHO_LEADS_REPORT_NAME,
            ZOHO_LEADS_COLUMN_MAPPING
        } = process.env;

        const mapping = JSON.parse(ZOHO_LEADS_COLUMN_MAPPING);

        const zohoToken = await getZohoToken();

        const meses = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

        const ontem = new Date();
        ontem.setDate(ontem.getDate() - 1);

        const dataFiltro = `${String(ontem.getDate()).padStart(2,'0')}-${meses[ontem.getMonth()]}-${ontem.getFullYear()}`;

        let from = 1;
        const limit = 200;

        let finalRows = [];

        while (true) {

            const criteria =
                `(Data_e_hora_de_inicio_do_formul_rio >= "${dataFiltro} 00:00:00" && Data_e_hora_de_inicio_do_formul_rio <= "${dataFiltro} 23:59:59")`;

            const url =
                `https://creator.zoho.com/api/v2/${ZOHO_ACCOUNT_OWNER}/${ZOHO_LEADS_APP_NAME}/report/${ZOHO_LEADS_REPORT_NAME}`;

            const resp = await axios.get(url, {
                params: {
                    from,
                    limit,
                    criteria
                },
                headers: {
                    Authorization: `Zoho-oauthtoken ${zohoToken}`
                }
            });

            const data = resp.data.data || [];

            if (data.length === 0) {
                break;
            }

            for (const record of data) {

                const row = {};

                Object.entries(mapping).forEach(([column, zohoField]) => {
                    row[column] = extractValue(record[zohoField]);
                });

                if (record.ID) {
                    row.zoho_id = String(record.ID);
                }

                finalRows.push(row);
            }

            if (data.length < limit) {
                break;
            }

            from += limit;

            await sleep(1000);
        }

        if (finalRows.length > 0) {

            const { error } = await supabase
                .from('zoho_leads')
                .upsert(finalRows, {
                    onConflict: 'zoho_id'
                });

            if (error) {
                throw error;
            }
        }

        console.log(`Leads sincronizados: ${finalRows.length}`);

    } catch (e) {

        console.error(
            e.response?.data || e.message
        );

        process.exit(1);
    }
}

run();