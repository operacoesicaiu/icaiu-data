// src/hablla/hablla-cards.js

const axios = require('axios');
const supabase = require('../config/supabase');
const getHabllaHeaders = require('./hablla-auth');
const sleep = require('../utils/sleep');
const sanitize = require('../utils/sanitize');

async function syncHabllaCards() {
    try {
        console.log('>>> Sincronizando Hablla Cards...');

        const headers = await getHabllaHeaders();

        const seteDiasAtras = new Date();
        seteDiasAtras.setDate(seteDiasAtras.getDate() - 7);
        seteDiasAtras.setHours(0, 0, 0, 0);

        let page = 1;

        while (page <= 500) {
            const response = await axios.get(
                `https://api.hablla.com/v3/workspaces/${process.env.HABLLA_WORKSPACE_ID}/cards`,
                {
                    params: {
                        board: process.env.HABLLA_BOARD_ID,
                        limit: 50,
                        page,
                        updated_after: seteDiasAtras.toISOString()
                    },
                    headers
                }
            );

            await sleep(500);

            const cards = response.data.results || [];

            if (!cards.length) {
                break;
            }

            const parsedCards = cards.map(card => {
                let cf = ['', '', '', '', ''];

                const customFieldIds = [
                    '67b39131ee792966f3fba492',
                    '67b608470787782ce7acafba',
                    '67dc6a0a17925c23d8365708',
                    '679120ec177ff6d2c7597156',
                    '69e8d49592607a5877e699d5'
                ];

                (card.custom_fields || []).forEach(field => {
                    const idx = customFieldIds.indexOf(field.custom_field);

                    if (idx !== -1) {
                        cf[idx] = field.value;
                    }
                });

                return {
                    card_id: card.id,

                    workspace_id: card.workspace,
                    board_id: card.board,
                    list_id: card.list,

                    created_at: card.created_at,
                    updated_at: card.updated_at,
                    finished_at: card.finished_at,

                    name: sanitize(card.name),
                    description: sanitize(card.description),

                    source: card.source,
                    status: card.status,

                    user_id:
                        typeof card.user === 'object'
                            ? card.user.id
                            : card.user || null,

                    user_name:
                        typeof card.user === 'object'
                            ? sanitize(card.user.name || card.user.email || '')
                            : '',

                    custom_field_1: sanitize(cf[0]),
                    custom_field_2: sanitize(cf[1]),
                    custom_field_3: sanitize(cf[2]),
                    custom_field_4: sanitize(cf[3]),
                    custom_field_5: sanitize(cf[4]),

                    tags: (card.tags || [])
                        .map(t => t.name)
                        .join(', ')
                };
            });

            const { error } = await supabase
                .from('hablla_cards')
                .upsert(parsedCards, {
                    onConflict: 'card_id'
                });

            if (error) {
                console.error(error);
                return;
            }

            console.log(
                `Página ${page} sincronizada (${parsedCards.length} cards)`
            );

            page++;
        }

        console.log('>>> Hablla Cards finalizado.');

    } catch (err) {
        console.error(err.response?.data || err.message);
    }
}

module.exports = syncHabllaCards;