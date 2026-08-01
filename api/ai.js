// api/ai.js
// Endpoint IA de l'application "Famille Nutrition IA".
// Proxy vers l'API Anthropic, avec recherche web optionnelle (circulaires / rabais).
// La cle API peut venir du client (body.apiKey) ou de la variable
// d'environnement ANTHROPIC_API_KEY configuree sur le serveur.
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const apiKey = body.apiKey || process.env.ANTHROPIC_API_KEY;
    const messages = (Array.isArray(body.messages) && body.messages.length > 0)
      ? body.messages
      : (body.message ? [{ role: 'user', content: body.message }] : null);

    if (!apiKey) return res.status(400).json({ error: 'Cle API manquante' });
    if (!messages) return res.status(400).json({ error: 'Aucun message fourni' });

    const payload = {
      model: body.model || 'claude-sonnet-4-5',
      max_tokens: Math.min(parseInt(body.max_tokens, 10) || 8000, 32000),
      messages: messages
    };
    if (body.system) payload.system = body.system;
    if (typeof body.temperature === 'number') payload.temperature = body.temperature;

    // Outil serveur de recherche web (execute cote Anthropic, aucune cle de plus)
    if (body.webSearch) {
      const tool = {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: Math.min(parseInt(body.maxSearches, 10) || 6, 12)
      };
      if (Array.isArray(body.allowedDomains) && body.allowedDomains.length > 0) {
        tool.allowed_domains = body.allowedDomains;
      }
      if (body.userLocation && typeof body.userLocation === 'object') {
        tool.user_location = body.userLocation;
      }
      payload.tools = [tool];
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: (data && data.error && data.error.message) || 'Erreur API',
        webSearchUsed: !!body.webSearch
      });
    }

    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks
      .filter(function (b) { return b.type === 'text' && typeof b.text === 'string'; })
      .map(function (b) { return b.text; })
      .join('\n')
      .trim();

    const sources = [];
    blocks.forEach(function (b) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        b.content.forEach(function (item) {
          if (item && item.url && sources.length < 25) {
            sources.push({ title: item.title || item.url, url: item.url });
          }
        });
      }
    });

    res.status(200).json({
      content: text,
      sources: sources,
      stop_reason: data.stop_reason || null,
      usage: data.usage || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
