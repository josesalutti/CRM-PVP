# Backlog CRM-PVP — Paridade com Leona Flow

> Gerado a partir da análise de gaps entre o Leona Flow (conta "Grupo PVP") e este repositório.
> Estimativas em story points (Fibonacci) são indicativas e devem ser revistas no refinamento.
> Importação: `work-items-azure-devops.csv` (Azure DevOps Boards → Work Items → Import from CSV).

## Resumo

| Épico | Objetivo | Itens | Pontos | Prioridade |
|---|---|---|---|---|
| **EP-00** Ambiente e flow de teste (Meta Cloud API) | Ter o CRM a correr com uma ligação WhatsApp oficial (número de teste da Meta) e um flow simples validado de ponta a ponta, sem escrever código novo. | 5 | 8 | P1 – Crítica |
| **EP-01** Multi-provedor WhatsApp e múltiplas ligações (UAZAPI) | Permitir usar os números atuais (UAZAPI, +244) e ter várias ligações por conta, como no Leona, mantendo a Meta Cloud API como opção. | 6 | 31 | P1 – Crítica |
| **EP-02** Flow builder: blocos essenciais (paridade Leona) | Trazer para o construtor de flows os blocos mais usados no Leona. Hoje existem: start, send_message, send_buttons, send_list, send_media, collect_input, condition, set_tag, handoff, end. | 9 | 41 | P2 – Alta |
| **EP-03** CRM e operação de atendimento | Blocos e recursos de organização da equipa e do funil que o Leona tem e o CRM ainda não. | 6 | 19 | P2 – Alta |
| **EP-04** Vendas, marketing e integrações avançadas | Registo de vendas, rastreamento de conversões e blocos de maior complexidade. | 5 | 23 | P3 – Média |
| **Total** | | 31 | 122 | |

## Ordem sugerida de sprints

1. **Sprint 1:** EP-00 completo (WI-01 a WI-05) e o spike WI-06. Resultado: flow de teste a funcionar com a Meta.
2. **Sprint 2–3:** WI-07, WI-08, WI-09 e WI-10. Resultado: números UAZAPI a funcionar no CRM.
3. **Sprint 4:** WI-11, WI-12 e WI-13.
4. **Sprint 5–6:** restantes itens do EP-02 e WI-21, WI-23 e WI-26.
5. **Seguintes:** restantes do EP-03 e EP-04.

## Mapa de dependências

```
WI-01, WI-02 → WI-03
WI-03 → WI-04
WI-04 → WI-05
WI-06 → WI-07
WI-06 → WI-08
WI-08 → WI-09
WI-07, WI-08 → WI-10
WI-07, WI-09 → WI-11
WI-01 → WI-12
WI-12 → WI-13
WI-12 → WI-14
WI-08 → WI-15
WI-08 → WI-26
WI-27 → WI-28
WI-08 → WI-29
WI-27 → WI-30
WI-19 → WI-31
```

## Convenções

- **Definition of Done:** código revisto em PR contra `development`; `npm run typecheck`, `npm run lint` e `npm test` a passar; migrações com RLS; textos em `messages/pt.json`; testado em ambiente com WhatsApp real.
- Novos tipos de nó de flow exigem sempre: tipo em `src/lib/flows/types.ts`, caso no `engine.ts`, regra em `validate.ts`, formulário em `src/components/flows/forms`, testes.

---

# EP-00 · Ambiente e flow de teste (Meta Cloud API)

**Tipo:** Epic · **Prioridade:** P1 – Crítica

**Objetivo:** Ter o CRM a correr com uma ligação WhatsApp oficial (número de teste da Meta) e um flow simples validado de ponta a ponta, sem escrever código novo.

## WI-01 · Configurar variáveis de ambiente e segredo do cron

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P1 – Crítica | 1 | — | infra, config |

**Contexto**
O .env.local já tem Supabase, ENCRYPTION_KEY, META_APP_SECRET, NEXT_PUBLIC_SITE_URL e NEXT_PUBLIC_APP_LOCALE. Falta AUTOMATION_CRON_SECRET: sem ele /api/flows/cron e /api/automations/cron respondem 503, e execuções de flow abandonadas nunca expiram (bloqueiam novos flows para o mesmo contacto via idx_one_active_run_per_contact).

**O que fazer**
- [ ] Gerar AUTOMATION_CRON_SECRET (openssl rand -hex 32) e adicioná-lo ao .env.local e ao ambiente de produção.
- [ ] Adicionar META_APP_ID (opcional, necessário só para templates com header de imagem).
- [ ] Validar que ENCRYPTION_KEY tem 64 caracteres hex (encryption.ts agora lança erro se não tiver).
- [ ] Agendar chamadas GET a /api/flows/cron e /api/automations/cron a cada 5 min com header x-cron-secret (Vercel Cron, GitHub Actions ou pinger externo).
- [ ] Atualizar .env.local.example com os comentários relevantes.

**Critérios de aceitação**
- GET /api/flows/cron com o header correto devolve 200; sem header devolve 401.
- O agendamento está ativo e visível nos logs do provedor.
- npm run dev arranca sem erros de variáveis em falta.

## WI-02 · Aplicar migrações da base de dados no Supabase

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P1 – Crítica | 1 | — | infra, database |

**Contexto**
O repositório tem 39 migrações em supabase/migrations (001 a 039). É preciso garantir que o projeto Supabase usado no .env.local as tem todas aplicadas, incluindo buckets de storage (flow-media, chat-media) e extensões (vector, da 030).

**O que fazer**
- [ ] Ligar o Supabase CLI ao projeto (supabase link) e correr supabase db push.
- [ ] Confirmar que os buckets de storage criados pelas migrações existem.
- [ ] Confirmar que a extensão vector está ativa (migração 030).
- [ ] Criar o primeiro utilizador/conta via /signup e verificar que a conta fica ligada ao perfil.

**Critérios de aceitação**
- supabase migration list mostra 001–039 aplicadas no remoto.
- Login e navegação por /dashboard, /inbox, /flows e /settings funcionam sem erros de tabela em falta.

## WI-03 · Criar app Meta, número de teste e ligar ao CRM

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P1 – Crítica | 2 | WI-01, WI-02 | whatsapp, meta, config |

**Contexto**
O CRM só fala com a WhatsApp Cloud API oficial. A Meta oferece um número de teste gratuito que envia para até 5 destinatários verificados, suficiente para validar o fluxo. Os números atuais do Leona (UAZAPI) não podem ser usados aqui sem o EP-01.

**O que fazer**
- [ ] Em developers.facebook.com criar app do tipo Business e adicionar o produto WhatsApp.
- [ ] Anotar Phone Number ID e WhatsApp Business Account ID do número de teste.
- [ ] Criar System User no Business Manager e gerar token permanente com whatsapp_business_messaging e whatsapp_business_management.
- [ ] Adicionar os telemóveis da equipa como destinatários verificados.
- [ ] Em Settings → WhatsApp no CRM, guardar token, Phone Number ID, WABA ID e um verify token.

**Critérios de aceitação**
- Settings → WhatsApp mostra estado "connected".
- Envio manual de uma mensagem a partir do Inbox chega ao telemóvel verificado.

## WI-04 · Expor URL pública e subscrever webhook da Meta

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P1 – Crítica | 2 | WI-03 | whatsapp, meta, infra |

**Contexto**
A Meta não alcança localhost. O webhook está em /api/whatsapp/webhook (GET para verificação com hub.verify_token, POST com assinatura x-hub-signature-256 validada com META_APP_SECRET).

**O que fazer**
- [ ] Fazer deploy (Vercel ou Docker) ou abrir túnel (ngrok http 3000) para desenvolvimento.
- [ ] Na app Meta → WhatsApp → Configuration, definir Callback URL https://<host>/api/whatsapp/webhook e o mesmo verify token do WI-03.
- [ ] Subscrever os campos messages e message_template_status_update.
- [ ] Atualizar NEXT_PUBLIC_SITE_URL para o host público.

**Critérios de aceitação**
- Meta mostra o webhook como verificado.
- Mensagem enviada do telemóvel aparece no Inbox em menos de 5 segundos, com contacto criado automaticamente.
- Estados sent/delivered/read atualizam nas mensagens enviadas.

## WI-05 · Construir e validar flow de teste ponta a ponta

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P1 – Crítica | 2 | WI-04 | flows, qa |

**Contexto**
Validar o motor de flows existente (src/lib/flows/engine.ts) com os blocos que já existem: gatilho keyword, send_buttons, send_message, handoff, end.

**O que fazer**
- [ ] Criar flow "Teste – Boas-vindas" com gatilho keyword "oi" (match contains, case-insensitive).
- [ ] Bloco send_buttons: "Olá! Como posso ajudar?" com botões "Ver produtos" e "Falar com atendente".
- [ ] Ramo "Ver produtos": send_message com texto de produtos → end.
- [ ] Ramo "Falar com atendente": handoff (atribuição opcional).
- [ ] Ativar o flow e testar os dois ramos e a resposta inválida (fallback reprompt → handoff).
- [ ] Documentar o resultado com capturas em /flows/[id]/runs.

**Critérios de aceitação**
- Enviar "oi" dispara o flow e mostra os botões.
- Cada botão segue o ramo correto e o run termina como completed ou handed_off.
- Texto livre fora das opções gera reprompt e, após 2 tentativas, handoff.
- O cron marca como timed_out um run abandonado após o timeout configurado.

# EP-01 · Multi-provedor WhatsApp e múltiplas ligações (UAZAPI)

**Tipo:** Epic · **Prioridade:** P1 – Crítica

**Objetivo:** Permitir usar os números atuais (UAZAPI, +244) e ter várias ligações por conta, como no Leona, mantendo a Meta Cloud API como opção.

## WI-06 · Spike: documentar API UAZAPI e decidir arquitetura de provedores

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| Spike | P1 – Crítica | 3 | — | whatsapp, uazapi, arquitetura |

**Contexto**
A UAZAPI é não-oficial (WhatsApp Web). Antes de codificar é preciso mapear endpoints, formato do webhook, autenticação por instância, suporte a botões/listas (instáveis em APIs não-oficiais) e riscos de banimento.

**O que fazer**
- [ ] Mapear endpoints: criar/ligar instância (QR/pairing code), estado, enviar texto, media, áudio, botões, listas, reação, marcar como lido.
- [ ] Mapear payload do webhook de entrada (mensagens, estados, desconexão) e mecanismo de autenticação/assinatura.
- [ ] Comparar com os tipos de mensagem suportados pela Meta e listar diferenças.
- [ ] Propor interface WhatsAppProvider e modelo de dados de ligações (ADR em docs/).
- [ ] Levantar riscos: banimento, limites de envio, estabilidade de botões interativos.

**Critérios de aceitação**
- ADR aprovado com interface do provedor, esquema de tabela e fluxo de webhook.
- Tabela de compatibilidade de funcionalidades Meta vs UAZAPI.

## WI-07 · Suportar múltiplas ligações WhatsApp por conta

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P1 – Crítica | 8 | WI-06 | whatsapp, database, backend |

**Contexto**
Hoje whatsapp_config é uma linha por conta: a rota /api/whatsapp/config faz .eq("account_id").maybeSingle() e o webhook resolve a conta pelo phone_number_id. O Leona tem 4 números numa só conta.

**O que fazer**
- [ ] Migração: evoluir whatsapp_config para whatsapp_connections (id, account_id, name, provider "meta"|"uazapi", phone_number, credenciais encriptadas, status, active) sem perder dados existentes.
- [ ] Adicionar connection_id a conversations e messages (nullable + backfill com a ligação atual).
- [ ] Uma conversa pertence a (contacto, ligação): rever a unicidade da migração 036.
- [ ] Atualizar RLS para as novas tabelas/colunas.
- [ ] Atualizar rotas de config, envio (send-message.ts), broadcasts e engines para receber connection_id.
- [ ] Testes unitários para resolução de ligação e deduplicação de conversas.

**Critérios de aceitação**
- Uma conta consegue guardar 2+ ligações e ambas recebem mensagens.
- Resposta a partir do Inbox sai pelo mesmo número por onde entrou a conversa.
- Contas existentes continuam a funcionar após a migração sem reconfigurar.

## WI-08 · Criar camada de abstração WhatsAppProvider

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P1 – Crítica | 5 | WI-06 | whatsapp, backend, refactor |

**Contexto**
O envio chama src/lib/whatsapp/meta-api.ts diretamente a partir de send-message.ts, flows/meta-send.ts, automations/meta-send.ts e broadcast-core.ts.

**O que fazer**
- [ ] Definir interface: sendText, sendMedia, sendButtons, sendList, sendTemplate, sendReaction, getMedia, getStatus.
- [ ] Implementar MetaCloudProvider como wrapper do meta-api.ts atual (sem mudar comportamento).
- [ ] Criar factory getProvider(connection) que devolve a implementação certa.
- [ ] Migrar todos os pontos de envio para usar o provedor.
- [ ] Normalizar a entrada: o parsing de webhook devolve um InboundMessage comum, independente do provedor.

**Critérios de aceitação**
- Nenhum ficheiro fora de lib/whatsapp/providers importa meta-api.ts diretamente.
- npm test e npm run typecheck passam; comportamento Meta inalterado.

## WI-09 · Implementar adaptador UAZAPI (envio)

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P1 – Crítica | 5 | WI-08 | whatsapp, uazapi, backend |

**Contexto**
Implementação de WhatsAppProvider para UAZAPI segundo o ADR do WI-06.

**O que fazer**
- [ ] Implementar UazapiProvider: texto, imagem, vídeo, documento, áudio (PTT), botões, listas, reação.
- [ ] Fallback para texto numerado quando botões/listas não forem suportados.
- [ ] Tratamento de erros, retries e rate limit por instância.
- [ ] Guardar token da instância encriptado (encryption.ts).
- [ ] Testes unitários com respostas mockadas.

**Critérios de aceitação**
- Envio de texto, media e botões funciona a partir do Inbox, flows e automações numa ligação UAZAPI.
- Falhas de envio ficam registadas na mensagem com status failed e motivo.

## WI-10 · Implementar webhook de entrada UAZAPI

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P1 – Crítica | 5 | WI-07, WI-08 | whatsapp, uazapi, backend |

**Contexto**
O webhook atual (/api/whatsapp/webhook) é específico da Meta. A UAZAPI envia outro formato. Toda a lógica pós-parsing (contacto, conversa, idempotência, flows, automações, IA, webhooks públicos) deve ser reutilizada.

**O que fazer**
- [ ] Criar rota /api/whatsapp/webhook/uazapi/[connectionId] com validação por token/segredo.
- [ ] Parser UAZAPI → InboundMessage comum (texto, media, respostas a botões/listas, reações, estados).
- [ ] Extrair processMessage do route.ts da Meta para um módulo partilhado.
- [ ] Download e espelhamento de media para o bucket chat-media.
- [ ] Tratar eventos de desconexão (atualizar status da ligação e notificar admins).

**Critérios de aceitação**
- Mensagem recebida num número UAZAPI aparece no Inbox e dispara flows/automações.
- Reentregas do mesmo evento não duplicam mensagens.
- Desconexão da instância muda o estado da ligação para disconnected.

## WI-11 · UI de gestão de ligações (QR code, estado, seleção de número)

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P2 – Alta | 5 | WI-07, WI-09 | whatsapp, frontend |

**Contexto**
Settings → WhatsApp (components/settings/whatsapp-config.tsx) é hoje um formulário único para Meta.

**O que fazer**
- [ ] Lista de ligações com nome, número, provedor, estado e ações (ligar, desligar, remover).
- [ ] Assistente "Nova ligação": escolher Meta (formulário atual) ou UAZAPI (mostrar QR code/pairing code com polling de estado).
- [ ] Filtro por ligação no Inbox e indicador do número em cada conversa.
- [ ] Seleção de ligação em broadcasts e no gatilho dos flows ("aplica-se às ligações X, Y").
- [ ] Traduções em messages/pt.json.

**Critérios de aceitação**
- Admin liga um número UAZAPI lendo o QR code sem sair do CRM.
- Inbox filtra conversas por número.
- Um flow pode ser restrito a ligações específicas.

# EP-02 · Flow builder: blocos essenciais (paridade Leona)

**Tipo:** Epic · **Prioridade:** P2 – Alta

**Objetivo:** Trazer para o construtor de flows os blocos mais usados no Leona. Hoje existem: start, send_message, send_buttons, send_list, send_media, collect_input, condition, set_tag, handoff, end.

## WI-12 · Bloco Intervalo inteligente (espera por tempo ou até data)

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P1 – Crítica | 5 | WI-01 | flows, backend, frontend |

**Contexto**
As automações têm step wait, mas os flows não. Leona: smart_interval com schedule_type time|date.

**O que fazer**
- [ ] Novo node_type smart_interval em flows/types.ts: { mode: "duration"|"datetime", amount, unit, datetime, timezone, next_node_key }.
- [ ] Adicionar coluna resume_at em flow_runs (migração) e estado "waiting".
- [ ] Cron /api/flows/cron retoma runs com resume_at <= now().
- [ ] Não aplicar timeout de abandono enquanto o run espera.
- [ ] Formulário no builder, validação em flows/validate.ts e testes no engine.

**Critérios de aceitação**
- Flow com espera de 2 minutos envia a mensagem seguinte após ~2 min (margem do cron).
- Espera até data/hora respeita o fuso Africa/Luanda.
- Mensagem do cliente durante a espera não quebra o run.

## WI-13 · Bloco Aguardar resposta com timeout, validação e gravação em campo

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P1 – Crítica | 5 | WI-12 | flows, backend, frontend |

**Contexto**
collect_input guarda em flow_runs.vars, não tem timeout e ignora o campo validation (types.ts: "Reserved for v2").

**O que fazer**
- [ ] Implementar validação: any, email, phone, number, regex, com mensagem de erro e nº máximo de tentativas.
- [ ] Timeout opcional (ou indefinido) com ramo de saída "sem resposta" (reutiliza resume_at do WI-12).
- [ ] Opção de gravar a resposta num campo personalizado do contacto além de vars.
- [ ] Ramos de saída: resposta válida, inválida (após tentativas), timeout.
- [ ] Atualizar builder (novos handles), validador e testes.

**Critérios de aceitação**
- Email inválido gera mensagem de erro e nova tentativa.
- Sem resposta no tempo definido segue o ramo timeout.
- Valor fica visível no campo personalizado do contacto.

## WI-14 · Menu 2.0: ramos "outra resposta" e "timeout" e modo texto

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P2 – Alta | 5 | WI-12 | flows, backend, frontend |

**Contexto**
send_buttons/send_list dependem dos limites da Meta (3 botões, 10 linhas) e o fallback é global (fallback_policy). Leona: interactive_menu com saídas menu_option, menu_other e menu_timeout.

**O que fazer**
- [ ] Novo node_type interactive_menu com opções ilimitadas: renderiza botões (≤3), lista (≤10) ou texto numerado (>10 ou provedor sem suporte).
- [ ] Aceitar resposta por toque, número ("1") ou texto igual ao título.
- [ ] Saídas: uma por opção + "outra resposta" + "timeout".
- [ ] Opção de gravar a escolha em campo personalizado.
- [ ] Manter send_buttons/send_list por compatibilidade.

**Critérios de aceitação**
- Menu com 12 opções é enviado como texto numerado e responder "12" segue o ramo certo.
- Resposta fora das opções segue o ramo "outra resposta" em vez do fallback global.

## WI-15 · Bloco Mensagem completo (várias mensagens, áudio, contacto, atrasos)

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P2 – Alta | 5 | WI-08 | flows, backend, frontend |

**Contexto**
Hoje um nó envia uma única mensagem (send_message ou send_media image/video/document). Leona permite num bloco uma sequência: texto, media, áudio, contacto, ficheiro, sticker e atrasos entre elas.

**O que fazer**
- [ ] Novo node_type message com actions[]: text, image, video, document, audio (gravado/PTT), contact (vCard), sticker, delay (segundos).
- [ ] Indicador "a escrever…/a gravar…" durante atrasos quando o provedor suportar.
- [ ] Interpolação de variáveis ({{contact.name}}, {{vars.x}}, campos personalizados) em todos os textos.
- [ ] Upload de áudio para flow-media (reutilizar opus-recorder).
- [ ] Execução sequencial com delays curtos inline e longos via resume_at.

**Critérios de aceitação**
- Um bloco envia texto → atraso 3s → áudio → imagem, pela ordem certa.
- Variáveis são substituídas e variáveis vazias não deixam "{{...}}" visível.

## WI-16 · Condição com múltiplas regras (E/OU, horário, campos, atendente)

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P2 – Alta | 5 | — | flows, backend, frontend |

**Contexto**
ConditionNodeConfig avalia um único predicado (var|tag|contact_field; equals|contains|present|absent).

**O que fazer**
- [ ] Config com grupos de regras e operador AND/OR.
- [ ] Novos sujeitos: campo personalizado, horário/dia da semana (com fuso), estado da conversa, atendente atribuído, variável global da conta.
- [ ] Novos operadores: not_equals, greater_than, less_than, starts_with, in_list.
- [ ] Migração automática das condições atuais para o novo formato.
- [ ] Criar tabela de variáveis globais por conta (account_variables) e UI simples em Settings.

**Critérios de aceitação**
- Condição "horário entre 08:00 e 18:00 E dia útil" encaminha corretamente.
- Flows antigos com condição simples continuam a funcionar.

## WI-17 · Bloco Ligação entre flows (executar outro flow)

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P3 – Média | 3 | — | flows, backend |

**Contexto**
Leona: connection_flow termina o flow atual e inicia outro flow ativo da mesma conta.

**O que fazer**
- [ ] Novo node_type execute_flow { flow_id, carry_vars: boolean }.
- [ ] Terminar run atual com end_reason "chained" e criar novo run no nó de entrada do flow destino.
- [ ] Proteção contra ciclos (máx. N encadeamentos por contacto num intervalo).
- [ ] Seletor de flows ativos no builder; validar que o destino existe e está ativo.

**Critérios de aceitação**
- Flow A encaminha para Flow B e o histórico mostra os dois runs ligados.
- Ciclo A→B→A é interrompido e registado como falha.

## WI-18 · Bloco Integração HTTP com mapeamento de resposta

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P2 – Alta | 5 | — | flows, backend, frontend, integracao |

**Contexto**
As automações têm send_webhook (só saída). Leona: make_http_request com mapeamento da resposta para campos do contacto e ramos sucesso/falha.

**O que fazer**
- [ ] Novo node_type http_request { method, url, headers, query, body, timeout_ms, response_mapping[], next_success, next_failure }.
- [ ] Interpolação de variáveis em URL, headers e body.
- [ ] Mapeamento JSONPath simples (data.cliente.nome) → vars ou campo personalizado.
- [ ] Proteção SSRF: bloquear IPs privados/localhost, limitar tamanho da resposta.
- [ ] Botão "Testar pedido" no builder e registo do pedido/resposta em flow_run_events (sem segredos).

**Critérios de aceitação**
- Pedido GET a uma API pública grava um campo e segue o ramo sucesso.
- Erro 4xx/5xx ou timeout segue o ramo falha.
- URL http://127.0.0.1 é rejeitada.

## WI-19 · Bloco IA no flow (prompt + gravação em variável)

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P2 – Alta | 5 | — | flows, ia, backend |

**Contexto**
A IA já existe como resposta automática global (src/lib/ai: providers OpenAI/Anthropic, chave por conta, base de conhecimento, usage). Falta usá-la como passo dentro de um flow.

**O que fazer**
- [ ] Novo node_type ai { system_prompt, user_message (com variáveis), use_knowledge_base, model, save_to_var, send_to_customer: boolean, next_node_key }.
- [ ] Reutilizar lib/ai/generate.ts, context.ts e registo de usage.
- [ ] Opção de classificar a intenção e ramificar (saídas por categoria).
- [ ] Timeout e ramo de falha quando o provedor falhar ou a conta não tiver chave.

**Critérios de aceitação**
- Bloco IA responde ao cliente com base na base de conhecimento.
- Modo classificação encaminha "quero comprar" para o ramo "vendas".
- Consumo aparece em Settings → AI → Usage.

## WI-20 · Bloco Template (HSM) no flow com roteamento por quick reply

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P3 – Média | 3 | — | flows, meta, backend |

**Contexto**
send_template existe nas automações e o webhook já trata cliques em quick reply (case "button"). Necessário para iniciar conversas fora da janela de 24h (só Meta).

**O que fazer**
- [ ] Novo node_type send_template { template_id, variables, buttons[] com next_node_key }.
- [ ] Reutilizar template-send-builder.ts.
- [ ] Esconder/avisar quando a ligação não é Meta.

**Critérios de aceitação**
- Template aprovado é enviado com variáveis preenchidas e o clique no botão avança o flow.

# EP-03 · CRM e operação de atendimento

**Tipo:** Epic · **Prioridade:** P2 – Alta

**Objetivo:** Blocos e recursos de organização da equipa e do funil que o Leona tem e o CRM ainda não.

## WI-21 · Departamentos e atribuição de conversas por departamento

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P2 – Alta | 5 | — | crm, backend, frontend |

**Contexto**
Não existe conceito de departamento. Leona: set_department no flow.

**O que fazer**
- [ ] Migração: departments (id, account_id, name) e department_members; coluna department_id em conversations.
- [ ] CRUD em Settings → Departamentos com membros.
- [ ] Filtro por departamento no Inbox; membros veem as conversas do seu departamento.
- [ ] Node_type set_department no flow e step equivalente nas automações.

**Critérios de aceitação**
- Flow atribui a conversa ao departamento "Vendas" e só os membros desse departamento a veem no filtro.

## WI-22 · Bloco Distribuidor (round-robin entre saídas)

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P3 – Média | 3 | — | flows, backend |

**Contexto**
assign_conversation das automações tem round_robin de atendentes. Leona: distributor divide contactos por N saídas (ex.: teste A/B ou distribuir entre vendedores).

**O que fazer**
- [ ] Novo node_type distributor { outputs: [{ id, label, weight }] }.
- [ ] Contador atómico por nó (RPC no Postgres) para evitar corridas.
- [ ] Estatística de quantos contactos passaram por cada saída.

**Critérios de aceitação**
- Com 3 saídas de peso igual, 30 contactos são distribuídos 10/10/10.

## WI-23 · Bloco Kanban/Pipeline no flow (criar, mover, remover card)

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P2 – Alta | 3 | — | flows, crm, backend |

**Contexto**
Pipelines e deals existem (/pipelines) e as automações têm create_deal. Faltam as ações no flow e mover/remover.

**O que fazer**
- [ ] Node_type pipeline_card { action: create|move|remove, pipeline_id, stage_id, title_template, value }.
- [ ] Se o contacto já tem deal aberto no pipeline, "create" move-o em vez de duplicar.
- [ ] Seletores de pipeline/etapa no builder.

**Critérios de aceitação**
- Flow move o deal do contacto para "Proposta enviada" e o card aparece na coluna certa.

## WI-24 · Bloco Manipulador de campos personalizados (com operações)

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P3 – Média | 3 | — | flows, crm, backend |

**Contexto**
Campos personalizados existem (Settings → Fields). Automações têm update_contact_field. Leona permite operações matemáticas e alterar a data de criação.

**O que fazer**
- [ ] Node_type set_field { field_id, operation: set|add|subtract|multiply|clear, value (com variáveis) }.
- [ ] Validação de tipo (número, texto, data).

**Critérios de aceitação**
- Campo "pontos" soma +10 a cada passagem pelo bloco.

## WI-25 · Bloco Controlador de estado da conversa

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P3 – Média | 2 | — | flows, crm |

**Contexto**
ConversationStatus é open | pending | closed. handoff e close_conversation (automação) cobrem parte. Leona: change_chat_status (Em espera, Em atendimento, Resolvido).

**O que fazer**
- [ ] Node_type set_conversation_status { status }.
- [ ] Mapear nomes da UI em português para os estados existentes.

**Critérios de aceitação**
- Flow marca a conversa como resolvida e ela sai da lista de abertas.

## WI-26 · Bloco Notificação para a equipa (WhatsApp para número externo)

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P2 – Alta | 3 | WI-08 | flows, whatsapp, backend |

**Contexto**
Existe notificação interna (/notifications), mas não alerta por WhatsApp. Leona: send_notification para um número da equipa (ex.: "novo lead quente").

**O que fazer**
- [ ] Node_type notify_team { phone_numbers[], message (com variáveis), connection_id }.
- [ ] Não criar contacto/conversa para o número de destino.
- [ ] Na Meta, alertar que fora da janela 24h exige template.
- [ ] Opção de também criar notificação interna.

**Critérios de aceitação**
- Quando o flow chega ao bloco, o gestor recebe no WhatsApp "Novo lead: {{contact.name}} – {{contact.phone}}".

# EP-04 · Vendas, marketing e integrações avançadas

**Tipo:** Epic · **Prioridade:** P3 – Média

**Objetivo:** Registo de vendas, rastreamento de conversões e blocos de maior complexidade.

## WI-27 · Produtos e registo de vendas aprovadas

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P2 – Alta | 8 | — | vendas, backend, frontend |

**Contexto**
Não existe catálogo nem histórico de vendas. Leona: products, approved_sale no flow, sales history com editar/apagar.

**O que fazer**
- [ ] Migração: products (nome, preço, moeda – default da conta) e sales (contact_id, product_id, amount, currency, source, flow_run_id, created_at).
- [ ] CRUD de produtos e página de histórico de vendas com filtros e exportação CSV.
- [ ] Node_type register_sale { product_id, amount_template }.
- [ ] KPIs no dashboard: receita, nº de vendas, ticket médio.
- [ ] Evento de webhook público sale.created.

**Critérios de aceitação**
- Flow regista venda e ela aparece no histórico e no dashboard do dia.
- Admin edita e apaga uma venda com confirmação.

## WI-28 · Pixel Meta (Conversions API): eventos Lead e Purchase

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P3 – Média | 5 | WI-27 | marketing, meta, integracao |

**Contexto**
Leona: send_pixel_event com PixelConfig por conta. Útil para otimizar anúncios Click-to-WhatsApp.

**O que fazer**
- [ ] Tabela pixel_configs (pixel_id, access_token encriptado, test_event_code).
- [ ] Node_type send_pixel_event { pixel_config_id, event: Lead|Purchase, value, currency }.
- [ ] Enviar telefone/email com hash SHA-256 conforme a Meta; guardar ctwa_clid quando disponível.
- [ ] Registo de envio e erro.

**Critérios de aceitação**
- Evento aparece no Events Manager (Test Events) com correspondência de telefone.

## WI-29 · Bloco Carrossel

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| User Story | P4 – Baixa | 5 | WI-08 | flows, whatsapp |

**Contexto**
Leona: send_carousel (UAZAPI / Meta Cloud via template de carrossel).

**O que fazer**
- [ ] Node_type carousel { intro_text, cards[]: { image_url, title, body, buttons[] } }.
- [ ] Implementar nos provedores que suportam; fallback para sequência de imagens com legenda.

**Critérios de aceitação**
- Carrossel com 3 cards é recebido e o clique num botão avança o flow.

## WI-30 · Spike: pagamentos para Angola (substituto do PIX/XPag)

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| Spike | P3 – Média | 3 | WI-27 | vendas, pagamentos, spike |

**Contexto**
PIX e XPag do Leona servem Brasil/América Latina. Para +244 avaliar gateways locais (ex.: Multicaixa Express, referências de pagamento, EMIS/ProxyPay) e confirmação por webhook.

**O que fazer**
- [ ] Levantar gateways com API, custos, KYC e suporte a webhook de confirmação.
- [ ] Propor node_type create_payment com ramos "cobrança criada" e "pagamento aprovado".
- [ ] Estimar implementação.

**Critérios de aceitação**
- Documento com recomendação de gateway e estimativa aprovado pelo negócio.

## WI-31 · Spike: geração de media com IA (equivalente Kie.ai)

| Tipo | Prioridade | Story points | Dependências | Tags |
|---|---|---|---|---|
| Spike | P4 – Baixa | 2 | WI-19 | ia, spike |

**Contexto**
Leona: kieai_generate (áudio, imagem, música, vídeo). Baixa prioridade.

**O que fazer**
- [ ] Avaliar custo/benefício e provedores.
- [ ] Decidir se entra no roadmap.

**Critérios de aceitação**
- Decisão registada (fazer / não fazer) com justificação.
