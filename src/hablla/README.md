# Hablla

## Regra de armazenamento raw

As tabelas de destino da Hablla neste projeto representam dados brutos da API.

Por isso, o campo `payload` deve preservar o retorno original da Hablla e nao deve ser:

- enriquecido com dados de outros endpoints
- mesclado com outras entidades
- normalizado
- renomeado
- reduzido ou reestruturado

### O que pode mudar

Pode mudar apenas o envelope de armazenamento usado pela integracao, por exemplo:

- `external_id`
- tabela de destino
- logs
- controle de janela de coleta

### O que nao pode mudar

O conteudo interno de `payload` deve continuar sendo o objeto bruto retornado pela API correspondente.

### Exemplo pratico

Mesmo quando um card possui relacao com `persons`, essa relacao nao deve ser usada para alterar o `payload` salvo na camada raw.

Se for necessario enriquecer, cruzar ou modelar dados de cards, persons, clients ou attendants, isso deve acontecer em uma camada derivada posterior, nunca na carga raw.

## Relacao entre cards e clients

Para associar o numero do cliente ao card, o vinculo identificado na API foi:

- `cards[].persons[]` contem ids de `persons`
- cada id em `cards[].persons[]` pode ser consultado em `/persons/{id}`
- o registro retornado por `/persons/{id}` contem dados do contato, incluindo `phones`

### Evidencia observada

No diagnostico local, um card com nome `Rodrigo Mentz` continha `persons: ["68895fb6047c330df"]`.

A consulta direta em `/persons/68895fb6047c330df` retornou um `person` com:

- mesmo nome `Rodrigo Mentz`
- telefone em `phones`

Isso indica que, neste contexto, `persons` no card esta funcionando como referencia ao contato cliente vinculado ao card.

### Como usar esse vinculo

Se uma camada derivada precisar montar `card + telefone do cliente`, o fluxo esperado e:

1. ler `payload.persons` do card
2. extrair os ids de person
3. consultar `/persons/{id}` para cada id relevante
4. usar `phones` do person retornado

### Limite importante

Esse cruzamento serve para leitura, enriquecimento ou modelagem em camada derivada.

Ele nao deve ser usado para modificar o `payload` raw salvo em `raw_events_hablla` nem o `payload` raw salvo em `raw_contact_hablla`.
