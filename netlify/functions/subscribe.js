// DIMORAMI — iscrizione Guida Bagno via Brevo (doppio opt-in)
// La chiave API va impostata su Netlify: Site settings → Environment variables → BREVO_API_KEY

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://dimorami.it',
  };
  if (event.httpMethod !== 'POST') {
    console.log('subscribe: rifiutato, metodo', event.httpMethod);
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method' }) };
  }
  let data;
  try { data = JSON.parse(event.body || '{}'); }
  catch {
    console.log('subscribe: rifiutato, body non è JSON valido');
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'json' }) };
  }

  const email = String(data.email || '').trim();
  const nome = String(data.nome || '').trim();
  const telefono = String(data.telefono || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !nome || !telefono || !data.consent) {
    console.log('subscribe: validazione fallita', {
      emailOk: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email),
      hasNome: !!nome,
      hasTelefono: !!telefono,
      hasConsent: !!data.consent,
    });
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'campi' }) };
  }
  // honeypot: campo nascosto che gli umani non compilano (autofill del browser può innescarlo per errore)
  if (data.honeypot_ref) {
    console.log('subscribe: honeypot compilato, submit ignorato silenziosamente (falso ok)');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  const LIST_ID = 3;               // lista "Guida Bagno"
  const brevoHeaders = {
    'api-key': process.env.BREVO_API_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  try {
    // PASSO 1 — crea/aggiorna il contatto (SENZA lista).
    const r1 = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: brevoHeaders,
      body: JSON.stringify({
        email,
        attributes: {
          NOME: nome,
          TELEFONO: telefono,
          ZONA: String(data.zona || ''),
          STATO: String(data.stato || ''),
          BUDGET: String(data.budget || ''),
        },
        updateEnabled: true,   // se esiste già, aggiorna
      }),
    });
    console.log('subscribe: Brevo create status', r1.status);
    if (r1.status !== 201 && r1.status !== 204) {
      const err = await r1.text();
      console.error('Brevo create error', r1.status, err);
      return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'brevo-create' }) };
    }

    // PASSO 2 — aggiunge il contatto alla lista come operazione SEPARATA.
    // È questo evento "aggiunto a lista" che fa scattare l'automazione (l'aggiunta
    // contestuale alla creazione via listIds NON genera il trigger).
    let r2 = await fetch(`https://api.brevo.com/v3/contacts/lists/${LIST_ID}/contacts/add`, {
      method: 'POST',
      headers: brevoHeaders,
      body: JSON.stringify({ emails: [email] }),
    });
    console.log('subscribe: Brevo add-to-list status', r2.status);

    // 204 = il contatto era GIÀ in lista da prima (es. un tentativo precedente).
    // In questo caso Brevo NON genera un nuovo evento "aggiunto a lista", quindi
    // l'automazione non riparte mai. Forziamo un re-trigger: rimuovo e riaggiungo.
    if (r2.status === 204) {
      console.log('subscribe: contatto già in lista, forzo remove+re-add per far ripartire automazione');
      const rRemove = await fetch(`https://api.brevo.com/v3/contacts/lists/${LIST_ID}/contacts/remove`, {
        method: 'POST',
        headers: brevoHeaders,
        body: JSON.stringify({ emails: [email] }),
      });
      console.log('subscribe: remove-from-list status', rRemove.status);
      r2 = await fetch(`https://api.brevo.com/v3/contacts/lists/${LIST_ID}/contacts/add`, {
        method: 'POST',
        headers: brevoHeaders,
        body: JSON.stringify({ emails: [email] }),
      });
      console.log('subscribe: re-add-to-list status', r2.status);
    }

    if (r2.status === 201 || r2.status === 204) {
      console.log('subscribe: completato ok');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }
    const err2 = await r2.text();
    console.error('Brevo add-to-list error', r2.status, err2);
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'brevo-list' }) };
  } catch (e) {
    console.error('Network error', e);
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'network' }) };
  }
};
