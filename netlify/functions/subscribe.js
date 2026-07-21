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

  const payload = {
    email,
    attributes: {
      NOME: nome,
      TELEFONO: telefono,
      ZONA: String(data.zona || ''),
      STATO: String(data.stato || ''),
      BUDGET: String(data.budget || ''),
    },
    includeListIds: [3],           // lista "Guida Bagno"
    templateId: 1,                 // modello predefinito doppio opt-in
    redirectionUrl: 'https://dimorami.it/guida-confermata.html',
  };

  try {
    const r = await fetch('https://api.brevo.com/v3/contacts/doubleOptinConfirmation', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (r.status === 201 || r.status === 204) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }
    const err = await r.text();
    console.error('Brevo error', r.status, err);
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'brevo' }) };
  } catch (e) {
    console.error('Network error', e);
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'network' }) };
  }
};
