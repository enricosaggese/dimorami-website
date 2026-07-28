// DIMORAMI — iscrizione Guida Bagno via Brevo (doppio opt-in)
// La chiave API va impostata su Netlify: Site settings → Environment variables → BREVO_API_KEY

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://dimorami.it',
  };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method' }) };
  }
  let data;
  try { data = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'json' }) }; }

  const email = String(data.email || '').trim();
  const nome = String(data.nome || '').trim();
  const telefono = String(data.telefono || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !nome || !telefono || !data.consent) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'campi' }) };
  }
  // honeypot: campo nascosto che gli umani non compilano
  if (data.azienda) {
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
    if (r1.status !== 201 && r1.status !== 204) {
      const err = await r1.text();
      console.error('Brevo create error', r1.status, err);
      return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'brevo-create' }) };
    }

    // PASSO 2 — aggiunge il contatto alla lista come operazione SEPARATA.
    // È questo evento "aggiunto a lista" che fa scattare l'automazione (l'aggiunta
    // contestuale alla creazione via listIds NON genera il trigger).
    const r2 = await fetch(`https://api.brevo.com/v3/contacts/lists/${LIST_ID}/contacts/add`, {
      method: 'POST',
      headers: brevoHeaders,
      body: JSON.stringify({ emails: [email] }),
    });
    // 201 = aggiunto (trigger scatta) · 204 = già presente (nessun nuovo trigger, ok comunque)
    if (r2.status === 201 || r2.status === 204) {
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
