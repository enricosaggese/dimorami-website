// DIMORAMI — email di conferma + richiesta pagamento al cliente per i brief Remote,
// più registrazione automatica del lead su Brevo CRM (pipeline "DIMORAMI Pipeline", fase "Nuovo lead").
//
// Trigger: notifica "webhook in uscita" di Netlify Forms su "Any form submission"
//          (Project configuration → Notifications → Add notification → HTTP POST request)
// Invia solo per i 4 form Remote con checkbox Condizioni Generali; ignora tutti gli altri
// (contatti, i 5 form On-Site) restituendo comunque 200 per non far apparire errori su Netlify.
//
// La chiave API va impostata su Netlify: Site settings → Environment variables → BREVO_API_KEY
// (stessa chiave già usata da netlify/functions/subscribe.js)
//
// FLUSSO (per servizi a prezzo fisso, Audit Digitale / Pre-Acquisto):
//   1. Il cliente invia il brief → questa funzione scatta.
//   2. Email al cliente con riepilogo + link PayPal con importo precompilato.
//   3. Trattativa creata in automatico su Brevo CRM, fase "Nuovo lead" — Enrico non deve
//      inserirla a mano, ma resta lui a verificare il pagamento (nessuna API bancaria collegata)
//      e a far partire l'analisi SOLO dopo la conferma dell'incasso — mai prima.
// Per i servizi a prezzo variabile (Bagno Remote, Living Remote) l'importo esatto dipende dalla
// metratura: l'email indica la fascia di prezzo ma NON un link PayPal con cifra precompilata —
// Enrico conferma l'importo esatto al cliente prima dell'incasso.
//
// NOTA PER CHI RIVEDE QUESTO FILE:
// - Il parsing del payload Netlify è scritto in modo difensivo (submission.data annidato,
//   oppure campi in cima all'oggetto) — verificato con una sottomissione reale il 10/09/2026:
//   la forma è { payload: { form_name, data: {...campi...} } }, confermata nei log Netlify.
// - La chiamata alle API CRM di Brevo (pipeline/deals) NON è stata verificata con una
//   sottomissione reale in questa sessione (impossibilitato a consultare la documentazione
//   Brevo aggiornata). Dopo il deploy, fare UNA sottomissione di prova e controllare i log
//   della funzione (Functions → invia-conferma → Logs): se la trattativa non compare su
//   Brevo CRM, il problema è quasi certamente qui (nome campo pipeline/stage diverso da
//   quello atteso) — il resto della funzione (email cliente) non ne risente perché la
//   chiamata CRM è isolata in un try/catch che non blocca l'invio email.

const SERVIZI = {
  'brief-audit-digitale': {
    nome: 'Dimora Audit Digitale',
    prezzoLabel: '€199 (lancio)',
    prezzoNumerico: 199,
    consegna: 'entro 48 ore lavorative',
  },
  'brief-pre-acquisto': {
    nome: 'Dimora Pre-Acquisto',
    prezzoLabel: '€249 (primo immobile, scala decrescente per immobili aggiuntivi)',
    prezzoNumerico: 249,
    consegna: 'entro 48–72 ore lavorative',
  },
  'brief-bagno-remote': {
    nome: 'Dimora Bagno Remote',
    prezzoLabel: '€390–590 secondo metratura (oltre 12mq preventivo su misura)',
    prezzoNumerico: null,
    consegna: 'entro pochi giorni lavorativi',
  },
  'brief-living-remote': {
    nome: 'Dimora Living Remote',
    prezzoLabel: '€390–490 primo modulo (+ eventuali extra secondo scope)',
    prezzoNumerico: null,
    consegna: 'entro pochi giorni lavorativi',
  },
};

const PAYPAL_USERNAME = 'enricosaggese';

function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return '';
}

function blocPagamento(servizio) {
  if (servizio.prezzoNumerico) {
    const link = `https://paypal.me/${PAYPAL_USERNAME}/${servizio.prezzoNumerico}`;
    return `
      <div style="background:#F7F3EC;border:1px solid #E3D8C4;border-radius:4px;padding:18px 20px;margin:20px 0;">
        <p style="margin:0 0 12px;"><strong>Come procedere:</strong> il lavoro parte non appena ricevo la conferma del pagamento di <strong>${servizio.prezzoNumerico}€</strong>.</p>
        <p style="margin:0 0 10px;">— <a href="${link}" style="color:#8C6A43;font-weight:bold;">Paga con PayPal (${servizio.prezzoNumerico}€)</a> — scegli "Invia per un bene o servizio" per avere la Protezione Acquisti.</p>
        <p style="margin:0;">— Preferisci il bonifico? Rispondi a questa email e ti mando l'IBAN.</p>
      </div>`;
  }
  return `
    <div style="background:#F7F3EC;border:1px solid #E3D8C4;border-radius:4px;padding:18px 20px;margin:20px 0;">
      <p style="margin:0 0 10px;">L'importo esatto dipende dalla metratura indicata nel brief. Ti scrivo a breve per confermare la cifra precisa e le modalità di pagamento (PayPal o bonifico) — il lavoro parte non appena ricevo conferma dell'incasso.</p>
    </div>`;
}

// Crea/aggiorna il contatto su Brevo e restituisce il suo id numerico.
async function upsertContatto(email, nome, brevoHeaders) {
  const r = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: brevoHeaders,
    body: JSON.stringify({ email, attributes: { NOME: nome }, updateEnabled: true }),
  });
  if (r.status === 201) {
    const body = await r.json();
    return body.id;
  }
  if (r.status === 204) {
    // Contatto già esistente: recupero l'id con una GET dedicata.
    const rGet = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
      method: 'GET',
      headers: brevoHeaders,
    });
    if (rGet.ok) {
      const body = await rGet.json();
      return body.id;
    }
    console.error('invia-conferma: GET contatto esistente fallita', rGet.status);
    return null;
  }
  const err = await r.text();
  console.error('invia-conferma: upsert contatto fallito', r.status, err);
  return null;
}

// Trova pipeline + fase "Nuovo lead" e crea la trattativa collegata al contatto.
async function creaTrattativa({ servizio, nome, formName, fields, contactId, brevoHeaders }) {
  const rPipe = await fetch('https://api.brevo.com/v3/crm/pipeline/details/all', {
    method: 'GET',
    headers: brevoHeaders,
  });
  if (!rPipe.ok) {
    console.error('invia-conferma: lettura pipeline Brevo fallita', rPipe.status, await rPipe.text());
    return;
  }
  const pipelines = await rPipe.json();
  const lista = Array.isArray(pipelines) ? pipelines : (pipelines.pipelines || []);
  const pipeline = lista.find(p => /dimorami/i.test(p.pipeline_name || p.name || '')) || lista[0];
  if (!pipeline) {
    console.error('invia-conferma: nessuna pipeline trovata su Brevo CRM');
    return;
  }
  const stages = pipeline.stages || pipeline.deal_stage || [];
  const stage = stages.find(s => /nuovo lead/i.test(s.name || '')) || stages[0];
  if (!stage) {
    console.error('invia-conferma: nessuna fase trovata nella pipeline', pipeline.pipeline || pipeline.id);
    return;
  }
  const pipelineId = pipeline.pipeline || pipeline.id;
  const stageId = stage.id;

  const immobile = pick(fields, 'immobile');
  const scope = pick(fields, 'scope');
  const note = [immobile ? `Immobile/link: ${immobile}` : '', scope ? `Scope: ${scope}` : '']
    .filter(Boolean).join(' — ');

  const dealBody = {
    name: `${servizio.nome} — ${nome}`,
    attributes: {
      deal_stage: stageId,
      pipeline: pipelineId,
      ...(servizio.prezzoNumerico ? { amount: servizio.prezzoNumerico } : {}),
      ...(note ? { deal_description: note } : {}),
    },
    linkedContactsIds: contactId ? [contactId] : [],
  };

  const rDeal = await fetch('https://api.brevo.com/v3/crm/deals', {
    method: 'POST',
    headers: brevoHeaders,
    body: JSON.stringify(dealBody),
  });
  if (rDeal.status === 201) {
    console.log('invia-conferma: trattativa creata su Brevo CRM per', formName, nome);
  } else {
    console.error('invia-conferma: creazione trattativa fallita', rDeal.status, await rDeal.text());
  }
}

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch {
    console.log('invia-conferma: body non è JSON valido, ignoro');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'bad-json' }) };
  }

  // Il payload Netlify arriva come { payload: { form_name, data: {...} } }.
  const sub = payload.payload || payload;
  const fields = sub.data || sub; // fallback difensivo: campi in cima all'oggetto

  const formName = pick(sub, 'form_name') || pick(fields, 'form-name', 'form_name');
  const servizio = SERVIZI[formName];

  if (!servizio) {
    console.log('invia-conferma: form_name non tra i 4 Remote con Condizioni ("' + formName + '"), nessuna azione');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'not-remote-form' }) };
  }

  const email = String(pick(fields, 'email')).trim();
  const nome = String(pick(fields, 'nome')).trim() || 'Cliente';
  const condizioniAccettate = pick(fields, 'condizioni_accettate');
  const condizioniVersione = pick(fields, 'condizioni_versione') || 'v1 — 08/09/2026';

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.log('invia-conferma: email mancante o non valida nel payload, nessuna azione', { formName, hasEmail: !!email });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'no-email' }) };
  }

  if (!condizioniAccettate) {
    console.log('invia-conferma: campo condizioni_accettate assente/vuoto per', formName, '— procedo comunque, ma segnalo in log per controllo manuale');
  }

  const html = `
    <div style="font-family:Arial,sans-serif;color:#1A1714;max-width:560px;margin:0 auto;">
      <h2 style="font-weight:400;">DIMORAMI</h2>
      <p>Ciao ${nome},</p>
      <p>ho ricevuto la tua richiesta per <strong>${servizio.nome}</strong>.</p>
      <p>Prezzo di riferimento: ${servizio.prezzoLabel}<br>
      Consegna prevista: ${servizio.consegna} dalla conferma del pagamento</p>
      ${blocPagamento(servizio)}
      <p>Confermo di aver registrato la tua accettazione delle
      <a href="https://dimorami.it/condizioni-generali.html">Condizioni Generali di Servizio DIMORAMI</a>
      (${condizioniVersione}), comprensive del listino prezzi dei servizi Remote.</p>
      <p>A presto,<br>Enrico Saggese — DIMORAMI</p>
      <p style="font-size:12px;color:#888;margin-top:24px;">Questa email conferma la ricezione della tua richiesta e delle condizioni accettate il ${new Date().toLocaleDateString('it-IT')}. Per qualsiasi domanda: enrico@dimorami.it</p>
    </div>`;

  const brevoHeaders = {
    'api-key': process.env.BREVO_API_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  let emailOk = false;
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: brevoHeaders,
      body: JSON.stringify({
        sender: { name: 'DIMORAMI — Enrico Saggese', email: 'enrico@dimorami.it' },
        to: [{ email, name: nome }],
        subject: `DIMORAMI — Conferma richiesta ${servizio.nome}`,
        htmlContent: html,
      }),
    });
    console.log('invia-conferma: Brevo send status', r.status, 'per', formName, email);
    emailOk = r.status >= 200 && r.status < 300;
    if (!emailOk) {
      const err = await r.text();
      console.error('invia-conferma: Brevo send error', r.status, err);
    }
  } catch (e) {
    console.error('invia-conferma: network error invio email', e);
  }

  // Registrazione CRM: isolata, non deve mai far fallire la risposta al webhook Netlify.
  try {
    const contactId = await upsertContatto(email, nome, brevoHeaders);
    await creaTrattativa({ servizio, nome, formName, fields, contactId, brevoHeaders });
  } catch (e) {
    console.error('invia-conferma: errore registrazione CRM (email cliente non impattata)', e);
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: emailOk }) };
};
