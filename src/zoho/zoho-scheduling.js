const axios = require('axios');

const supabase = require('../lib/supabase');
const getZohoToken = require('../lib/zoho-auth');

function formatZohoValue(val) {

    if (val === null || val === undefined || val === '') {
        return '';
    }

    if (typeof val === 'object') {

        if (Array.isArray(val)) {

            return val.map(v =>
                typeof v === 'object'
                    ? v.display_value || v.ID
                    : v
            ).join(', ');
        }

        return val.display_value || val.ID || String(val);
    }

    return String(val);
}

async function run() {

    try {

        const {
            ZOHO_ACCOUNT_OWNER,
            ZOHO_SCHEDULING_APP_NAME,
            ZOHO_SCHEDULING_REPORT_NAME,
            ZOHO_SCHEDULING_COLUMN_MAPPING
        } = process.env;

        const mapping =
            JSON.parse(ZOHO_SCHEDULING_COLUMN_MAPPING);

        const zohoToken = await getZohoToken();

        const today = new Date();

        const startDate =
            new Date(today.getFullYear(), today.getMonth() - 1, 1);

        const months =
            ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

        const formatZohoDate = (d) =>
            `${String(d.getDate()).padStart(2,'0')}-${months[d.getMonth()]}-${d.getFullYear()}`;

        const criteria =
            `(Data_e_hora_de_inicio_do_formulario >= "${formatZohoDate(startDate)}" && Data_e_hora_de_inicio_do_formulario <= "${formatZohoDate(today)}")`;

        let zohoRecords = [];
        let from = 1;

        while (true) {

            const resp = await axios.get(
                `https://creator.zoho.com/api/v2/${ZOHO_ACCOUNT_OWNER}/${ZOHO_SCHEDULING_APP_NAME}/report/${ZOHO_SCHEDULING_REPORT_NAME}`,
                {
                    params: {
                        from,
                        limit: 200,
                        criteria
                    },
                    headers: {
                        Authorization: `Zoho-oauthtoken ${zohoToken}`
                    }
                }
            );

            const data = resp.data.data || [];

            if (data.length === 0) {
                break;
            }

            zohoRecords.push(...data);

            if (data.length < 200) {
                break;
            }

            from += 200;
        }

        const finalRows = [];

        for (const rec of zohoRecords) {

            const row = {};

            mapping.forEach((field, index) => {

                let value =
                    formatZohoValue(rec[field]);

                if (
                    index === 0 &&
                    value.startsWith('+')
                ) {
                    value = value.substring(1);
                }

                if (
                    ['=', '+', '-', '@']
                    .some(c => value.startsWith(c))
                ) {
                    value = `'${value}`;
                }

                row[`col_${index + 1}`] = value;
            });

            if (rec.ID) {
                row.zoho_id = String(rec.ID);
            }

            finalRows.push(row);
        }

        if (finalRows.length > 0) {

            const { error } = await supabase
                .from('zoho_scheduling')
                .upsert(finalRows, {
                    onConflict: 'zoho_id'
                });

            if (error) {
                throw error;
            }
        }

        console.log(
            `Scheduling sincronizados: ${finalRows.length}`
        );

    } catch (e) {

        console.error(
            e.response?.data || e.message
        );

        process.exit(1);
    }
}

run();