// DIMORAMI — email di conferma automatica al cliente per i brief Remote
// Trigger: notifica "webhook in uscita" di Netlify Forms su "Any form submission"
//          (Impostazioni progetto → Notifiche → Aggiungi notifica → Webhook in uscita)
// Invia solo per i 4 form Remote con checkbox Condizioni Generali; ignora tutti gli altri
// (contatti, i 5 form On-Site) restituendo comunque 200 per non far apparire errori su Netlify.
//
// La chiave API va impostata su Netlify: Site settings → Environment variables → BREVO_API_KEY
// (stessa chiave già usata da netlify/functions/subscribe.js)
//
// NOTA PER CHI RIVEDE QUESTO FILE: la forma esatta del payload che Netlify manda ai webhook
// di notifica form non è stata verificata con una sottomissione reale in questa sessione —
// il parsing sotto è scritto in modo difensivo per coprire le due forme più plausibili
// (submission.data annidato, oppure campi in cima all'oggetto). Dopo il deploy, fare UNA
// sottomissione di prova su uno dei 4 form e controllare i log della funzione su Netlify
// (Functions → invia-conferma → Logs) per confermare che i campi vengano letti correttamente.

const SERVIZI = {
  'brief-audit-digitale': {
    nome: 'Dimora Audit Digitale',
    prezzo: '€199 (lancio) / €249 (regime)',
    consegna: 'entro 48 ore lavorative',
  },
  'brief-pre-acquisto': {
    nome: 'Dimora Pre-Acquisto',
    prezzo: '€249 (primo immobile, scala decrescente per immobili aggiuntivi)',
    consegna: 'entro 48–72 ore lavorative',
  },
  'brief-bagno-remote': {
    nome: 'Dimora Bagno Remote',
    prezzo: '€390–590 secondo metratura (oltre 12mq preventivo su misura)',
    consegna: 'entro pochi giorni lavorativi',
  },
  'brief-living-remote': {
    nome: 'Dimora Living Remote',
    prezzo: '€390–490 primo modulo (+ eventuali extra secondo scope)',
    consegna: 'entro pochi giorni lavorativi',
  },
};

function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return '';
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

  // Il payload Netlify può arrivare come { payload: {...} } o direttamente come submission.
  const sub = payload.payload || payload;
  const fields = sub.data || sub; // fallback: campi in cima all'oggetto

  const formName = pick(sub, 'form_name') || pick(fields, 'form-name', 'form_name');
  const servizio = SERVIZI[formName];

  if (!servizio) {
    console.log('invia-conferma: form_name non tra i 4 Remote con Condizioni ("' + formName + '"), nessuna email inviata');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'not-remote-form' }) };
  }

  const email = String(pick(fields, 'email')).trim();
  const nome = String(pick(fields, 'nome')).trim() || 'Cliente';
  const condizioniAccettate = pick(fields, 'condizioni_accettate');
  const condizioniVersione = pick(fields, 'condizioni_versione') || 'v1 — 08/09/2026';

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.log('invia-conferma: email mancante o non valida nel payload, nessuna email inviata', { formName, hasEmail: !!email });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'no-email' }) };
  }

  if (!condizioniAccettate) {
    console.log('invia-conferma: campo condizioni_accettate assente/vuoto per', formName, '— invio comunque, ma segnalo in log per controllo manuale');
  }

  const html = `
    <div style="font-family:Arial,sans-serif;color:#1A1714;max-width:560px;margin:0 auto;">
      <h2 style="font-weight:400;">DIMORAMI</h2>
      <p>Ciao ${nome},</p>
      <p>ho ricevuto la tua richiesta per <strong>${servizio.nome}</strong>.</p>
      <p>Prezzo di riferimento: ${servizio.prezzo}<br>
      Consegna prevista: ${servizio.consegna}</p>
      <p>Confermo di aver registrato la tua accettazione delle
      <a href="https://dimorami.it/condizioni-generali.html">Condizioni Generali di Servizio DIMORAMI</a>
      (${condizioniVersione}), comprensive del listino prezzi dei servizi Remote.</p>
      <p>Ti ricontatto personalmente via email o WhatsApp con i prossimi passi.</p>
      <p>A presto,<br>Enrico Saggese — DIMORAMI</p>
      <p style="font-size:12px;color:#888;margin-top:24px;">Questa email conferma la ricezione della tua richiesta e delle condizioni accettate il ${new Date().toLocaleDateString('it-IT')}. Per qualsiasi domanda: enrico@dimorami.it</p>
    </div>`;

  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'DIMORAMI — Enrico Saggese', email: 'enrico@dimorami.it' },
        to: [{ email, name: nome }],
        subject: `DIMORAMI — Conferma richiesta ${servizio.nome}`,
        htmlContent: html,
      }),
    });
    console.log('invia-conferma: Brevo send status', r.status, 'per', formName, email);
    if (r.status >= 200 && r.status < 300) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }
    const err = await r.text();
    console.error('invia-conferma: Brevo send error', r.status, err);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'brevo-send' }) };
  } catch (e) {
    console.error('invia-conferma: network error', e);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'network' }) };
  }
};
