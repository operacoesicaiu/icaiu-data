// src/hablla/hablla-clients.js

const axios = require('axios');
const supabase = require('../config/supabase');
const getHabllaHeaders = require('./hablla-auth');
const sleep = require('../utils/sleep');
const sanitize = require('../utils/sanitize');

async function syncHabllaClients() {
    try {
        console.log('>>> Sincronizando Hablla Clients...');

        const headers = await getHabllaHeaders();

        const ontem = new Date();
        ontem.setDate(ontem.getDate() - 1);

        const dIni = new Date(
            ontem.setHours(0, 0, 0, 0)
        ).toISOString();

        const dFim = new Date(
            ontem.setHours(23, 59, 59, 999)
        ).toISOString();

        let page = 1;

        const allClients = [];

        while (page <= 150) {
            const response = await axios.get(
                `https://api.hablla.com/v1/workspaces/${process.env.HABLLA_WORKSPACE_ID}/persons`,
                {
                    params: {
                        start_date: dIni,
                        end_date: dFim,
                        page,
                        limit: 50,
                        field_date: 'created_at',
                        populate: true
                    },
                    headers
                }
            );

            await sleep(500);

            const data =
                response.data?.results ||
                response.data?.data ||
                response.data ||
                [];

            if (!Array.isArray(data) || !data.length) {
                break;
            }

            allClients.push(...data);

            if (data.length < 50) {
                break;
            }

            page++;
        }

        const fixedCustomFieldIds = [
            '6887db7cc2a3a46cebf75ea7',
            '67e6d711eb31b8892b75849a',
            '67e6d70ae8d3a28c98616065',
            '67ec621f8deaf73871b405d5',
            '67e6d5b88d506fc6c09408f9',
            '67af906d0b7fbf296df82ea4'
        ];

        const parsedClients = allClients.map(person => {

            let phone = '';
            let whatsapp = false;

            if (
                person.phones &&
                Array.isArray(person.phones) &&
                person.phones.length
            ) {
                phone = person.phones[0].phone || '';
                whatsapp = !!person.phones[0].is_whatsapp;
            }

            let emails = [];

            if (
                person.emails &&
                Array.isArray(person.emails)
            ) {
                emails = person.emails.map(e => {
                    if (typeof e === 'string') return e;
                    if (typeof e === 'object') return e.email;
                    return null;
                }).filter(Boolean);
            }

            let tags = [];

            if (
                person.tags &&
                Array.isArray(person.tags)
            ) {
                tags = person.tags.map(t => {
                    if (typeof t === 'string') return t;
                    if (typeof t === 'object') return t.name;
                    return null;
                }).filter(Boolean);
            }

            const customFields = {};
            const extraFields = {};

            if (
                person.custom_fields &&
                Array.isArray(person.custom_fields)
            ) {
                person.custom_fields.forEach(cf => {

                    let value = cf.value;

                    if (typeof value === 'boolean') {
                        value = value ? 'Sim' : 'Não';
                    }

                    if (typeof value === 'object') {
                        value = JSON.stringify(value);
                    }

                    if (
                        fixedCustomFieldIds.includes(cf.custom_field)
                    ) {
                        customFields[cf.custom_field] = value;
                    } else {
                        extraFields[cf.custom_field] = value;
                    }
                });
            }

            return {
                person_id: person.id,

                name: sanitize(person.name || ''),

                phone,
                whatsapp,

                emails,

                created_at: person.created_at,
                updated_at: person.updated_at,

                sectors: person.sectors || [],
                tags,

                users: person.users || [],

                custom_field_1:
                    customFields['6887db7cc2a3a46cebf75ea7'] || null,

                custom_field_2:
                    customFields['67e6d711eb31b8892b75849a'] || null,

                custom_field_3:
                    customFields['67e6d70ae8d3a28c98616065'] || null,

                custom_field_4:
                    customFields['67ec621f8deaf73871b405d5'] || null,

                custom_field_5:
                    customFields['67e6d5b88d506fc6c09408f9'] || null,

                custom_field_6:
                    customFields['67af906d0b7fbf296df82ea4'] || null,

                extra_fields: extraFields,

                raw_payload: person
            };
        });

        if (!parsedClients.length) {
            console.log('Nenhum cliente encontrado.');
            return;
        }

        const { error } = await supabase
            .from('hablla_clients')
            .upsert(parsedClients, {
                onConflict: 'person_id'
            });

        if (error) {
            console.error(error);
            return;
        }

        console.log(
            `>>> ${parsedClients.length} clientes sincronizados.`
        );

    } catch (err) {
        console.error(err.response?.data || err.message);
    }
}

module.exports = syncHabllaClients;