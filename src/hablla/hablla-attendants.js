// src/hablla/hablla-attendants.js

const axios = require('axios');
const supabase = require('../config/supabase');
const getHabllaHeaders = require('./hablla-auth');
const sleep = require('../utils/sleep');
const sanitize = require('../utils/sanitize');

async function syncHabllaAttendants() {
    try {
        console.log('>>> Sincronizando Hablla Attendants...');

        const headers = await getHabllaHeaders();

        const ontem = new Date();
        ontem.setDate(ontem.getDate() - 1);

        const dIni = new Date(ontem.setHours(0, 0, 0, 0)).toISOString();
        const dFim = new Date(ontem.setHours(23, 59, 59, 999)).toISOString();

        const response = await axios.get(
            `https://api.hablla.com/v1/workspaces/${process.env.HABLLA_WORKSPACE_ID}/reports/services/summary`,
            {
                params: {
                    start_date: dIni,
                    end_date: dFim
                },
                headers
            }
        );

        await sleep(500);

        const attendants = (response.data.results || []).map(item => {
            const u = item.user || {};
            const s = item.sector || {};
            const c = item.connection || {};

            return {
                report_date: dFim,

                workspace_id: process.env.HABLLA_WORKSPACE_ID,

                sector_id: s.id || null,
                sector_name: sanitize(s.name || ''),

                user_id: u.id || null,
                user_name: sanitize(u.name || ''),
                user_email: sanitize(u.email || ''),

                total_services: item.total_services || 0,

                tme: item.tme || 0,
                tma: item.tma || 0,

                connection_id: c.id || null,
                connection_name: sanitize(c.name || ''),
                connection_type: c.type || '',

                total_csat: item.total_csat || 0,
                total_csat_greater_4:
                    item.total_csat_greater_4 || 0,

                csat: item.csat || 0,

                total_fcr: item.total_fcr || 0
            };
        });

        if (!attendants.length) {
            console.log('Nenhum atendimento encontrado.');
            return;
        }

        const { error } = await supabase
            .from('hablla_attendants')
            .upsert(attendants, {
                onConflict: 'report_date,user_id'
            });

        if (error) {
            console.error(error);
            return;
        }

        console.log(
            `>>> ${attendants.length} attendants sincronizados.`
        );

    } catch (err) {
        console.error(err.response?.data || err.message);
    }
}

module.exports = syncHabllaAttendants;