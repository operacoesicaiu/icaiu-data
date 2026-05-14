const axios = require('axios');

function secureLog(message, isError = false) {
    const timestamp = new Date().toISOString();
    const logLevel = isError ? 'ERROR' : 'INFO';
    console.log(`[${timestamp}] [${logLevel}] ${message}`);
}

function formatZohoValue(val) {
    if (val === null || val === undefined || val === '') return '';
    if (typeof val === 'object') {
        if (Array.isArray(val)) {
            return val.map(v => (typeof v === 'object' ? v.display_value || v.ID : v)).join(', ');
        }
        return val.display_value || val.ID || String(val);
    }
    return String(val);
}

async function run() {
    try {
        const {
            ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET,
            ZOHO_ACCOUNT_OWNER, ZOHO_APP_NAME, ZOHO_REPORT_NAME,
            REPORT_SPREADSHEET_ID, REPORT_SHEET_NAME, GOOGLE_TOKEN, REPORT_COLUMN_MAPPING
        } = process.env;

        const gHeaders = { 'Authorization': `Bearer ${GOOGLE_TOKEN}`, 'Content-Type': 'application/json' };
        const safeSheet = `'${REPORT_SHEET_NAME}'`;

        // 1. Auth Zoho
        const authRes = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
            params: { refresh_token: ZOHO_REFRESH_TOKEN, client_id: ZOHO_CLIENT_ID, client_secret: ZOHO_CLIENT_SECRET, grant_type: 'refresh_token' }
        });
        const zohoToken = authRes.data.access_token;

        // 2. Datas (2 meses)
        const today = new Date();
        const startDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const formatZohoDate = (d) => `${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
        const criteria = `(Data_e_hora_de_inicio_do_formulario >= "${formatZohoDate(startDate)}" && Data_e_hora_de_inicio_do_formulario <= "${formatZohoDate(today)}")`;

        // 3. Coleta Zoho
        let zohoRecords = [];
        let fromIndex = 1;
        while (zohoRecords.length < 10000) {
            const resp = await axios.get(`https://creator.zoho.com/api/v2/${ZOHO_ACCOUNT_OWNER}/${ZOHO_APP_NAME}/report/${ZOHO_REPORT_NAME}`, {
                params: { from: fromIndex, limit: 200, criteria: criteria },
                headers: { 'Authorization': `Zoho-oauthtoken ${zohoToken}` }
            });
            const data = resp.data.data || [];
            if (data.length === 0) break;
            zohoRecords = zohoRecords.concat(data);
            if (data.length < 200) break;
            fromIndex += 200;
        }

        // 4. Buscar Metadados e Datas
        const sheetMeta = await axios.get(`https://sheets.googleapis.com/v4/spreadsheets/${REPORT_SPREADSHEET_ID}`, { headers: gHeaders });
        const sheetObj = sheetMeta.data.sheets.find(s => s.properties.title === REPORT_SHEET_NAME);
        const sheetId = sheetObj.properties.sheetId;
        let currentMaxRows = sheetObj.properties.gridProperties.rowCount;

        const resR = await axios.get(`https://sheets.googleapis.com/v4/spreadsheets/${REPORT_SPREADSHEET_ID}/values/${safeSheet}!R:R`, { headers: gHeaders });
        const allDates = resR.data.values || [];
        let deleteFromRow = allDates.length + 1;

        for (let i = allDates.length - 1; i >= 1; i--) {
            const dateStr = allDates[i][0];
            if (!dateStr) continue;
            const p = dateStr.replace(/'/g, '').split('/');
            if (p.length < 3) continue;
            const rowDate = new Date(`${p[1]} ${p[0]}, ${p[2]}`);
            if (!isNaN(rowDate) && rowDate >= startDate) deleteFromRow = i + 1;
            else if (!isNaN(rowDate)) break;
        }

        // 5. Processamento (Mesma lógica anterior, com correções de I, J, R e T)
        const mapping = JSON.parse(REPORT_COLUMN_MAPPING);
        const dictRes = await axios.get(`https://sheets.googleapis.com/v4/spreadsheets/${REPORT_SPREADSHEET_ID}/values/'Dicionário'!A:B`, { headers: gHeaders }).catch(() => ({data:{}}));
        const dictionary = {};
        if (dictRes.data.values) dictRes.data.values.forEach(r => dictionary[r[0]] = r[1]);

        const countMap = {};
        zohoRecords.forEach(rec => {
            const valM = formatZohoValue(rec[mapping[12]]);
            const dR = valM.split(' ')[0] || '';
            const key = `${formatZohoValue(rec[mapping[2]])}|${dR}`;
            countMap[key] = (countMap[key] || 0) + 1;
        });

        const finalData = zohoRecords.map(rec => {
            const row = mapping.map((f, index) => {
                let v = formatZohoValue(rec[f]);
                
                // CORREÇÃO 1: Remove o '+' do telefone (Coluna A)
                if (index === 0 && v.startsWith('+')) v = v.substring(1);
                
                if (['=', '+', '-', '@'].some(c => v.startsWith(c))) v = `'${v}`;
                return v;
            });

            let [A, B, C, D, E, F, G, H, I, J, K, L, M, N, O] = row;

            // CORREÇÃO 2: Se F for só hora, puxa a data de E
            if (F && F.includes(':') && !F.includes('-') && !F.includes('/')) {
                const dataParte = (E || '').split(' ')[0];
                if (dataParte) F = `${dataParte} ${F}`;
            }

            const dM_raw = (M || '').split(' ')[0] || '';
            const dE_raw = (E || '').split(' ')[0] || '';
            const colR = dM_raw.split('-').join('/');
            const colT = dE_raw.split('-').join('/');

            let serialT = "";
            if (dE_raw) {
                const dObj = new Date(dE_raw);
                if (!isNaN(dObj)) serialT = Math.floor((dObj - new Date(1899, 11, 30)) / 86400000);
            }

            const colQ = `'${serialT}${D}`;
            const colP = dictionary[N] || '';
            const colS = (M || '').split(' ')[1] || '';
            const colU = (E || '').split(' ')[1] || '';
            const colV = G === "Novo serviço" ? 1 : 0;
            const colW = G === "Avaliação Store" ? 1 : 0;
            const colX = G === "Retirada" ? 1 : 0;
            const colY = G === "Garantia" ? 1 : 0;
            const colZ = countMap[`${C}|${dM_raw}`] === 1 ? 1 : 0;
            const colAA = 1;
            const colAB = B === "Cliente realizou o serviço" ? 1 : 0;
            const colAC = O === "Cliente reagendou" ? 0 : 1;
            const colAD = B === "Cliente faltou" ? 1 : 0;
            const colAE = (B === "Cliente cancelou o serviço" && O !== "Cliente reagendou") ? 1 : 0;
            const colAF = B === "Cliente realizou o serviço" ? 1 : 0;
            const colAG = 0;
            const colAH = colR.includes('/') ? `${colR.split('/')[1]}/${colR.split('/')[2]}` : '';

            row[0] = A; 
            row[5] = F; 
            row[3] = `'${D}`;
            
            return [...row, colP, colQ, colR, colS, colT, colU, colV, colW, colX, colY, colZ, colAA, colAB, colAC, colAD, colAE, colAF, colAG, colAH];
        });

        // 6. Ajustar tamanho da planilha se necessário
        const requiredRows = deleteFromRow + finalData.length;
        if (requiredRows > currentMaxRows) {
            const addCount = requiredRows - currentMaxRows + 100; // Adiciona com folga
            secureLog(`Aumentando planilha em ${addCount} linhas...`);
            await axios.post(`https://sheets.googleapis.com/v4/spreadsheets/${REPORT_SPREADSHEET_ID}:batchUpdate`, {
                requests: [{ appendCells: { sheetId: sheetId, rows: Array(addCount).fill({ values: [] }), fields: 'userEnteredValue' } }]
            }, { headers: gHeaders });
        }

        // 7. Limpeza e Upload
        if (deleteFromRow <= allDates.length && allDates.length > 0) {
            const rangeClear = `${safeSheet}!A${deleteFromRow}:AH${allDates.length}`;
            await axios.post(`https://sheets.googleapis.com/v4/spreadsheets/${REPORT_SPREADSHEET_ID}/values/${rangeClear}:clear`, {}, { headers: gHeaders });
        }

        secureLog(`Enviando ${finalData.length} linhas...`);
        const batchSize = 500;
        for (let i = 0; i < finalData.length; i += batchSize) {
            const batch = finalData.slice(i, i + batchSize);
            const rangeUpload = `${safeSheet}!A${deleteFromRow + i}`;
            await axios.put(`https://sheets.googleapis.com/v4/spreadsheets/${REPORT_SPREADSHEET_ID}/values/${rangeUpload}?valueInputOption=USER_ENTERED`, 
                { values: batch }, { headers: gHeaders });
        }

        secureLog("Sincronização concluída!");

    } catch (e) {
        secureLog(`ERRO: ${e.response ? JSON.stringify(e.response.data) : e.message}`, true);
        process.exit(1);
    }
}

run();
