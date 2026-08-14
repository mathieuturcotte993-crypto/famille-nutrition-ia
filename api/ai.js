// api/ai.js
// Endpoint IA de l'application "Famille Nutrition IA".
// Proxy vers l'API Anthropic.
//
// Objectifs de cette version :
//  - Aucune requete ne doit "casser" parce qu'elle est trop grosse.
//  - Streaming de bout en bout : la connexion ne reste jamais silencieuse,
//    donc pas de coupure par le proxy Vercel ni par le navigateur.
//  - Auto-continuation : si le modele atteint max_tokens, on relance
//    automatiquement la generation la ou elle s'est arretee et on recolle
//    le texte. Le client recoit une reponse complete.
//  - Gestion de stop_reason = "pause_turn" (recherche web longue).
//  - Retries avec backoff sur 429 / 5xx / erreurs reseau.
//  - Les erreurs sont TOUJOURS renvoyees en JSON (jamais une page HTML),
//    ce qui evite les "JSON error" cote client.
//
// La cle API peut venir du client (body.apiKey) ou de la variable
// d'environnement ANTHROPIC_API_KEY configuree sur le serveur.

var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
var API_VERSION = '2023-06-01';

var MAX_CONTINUATIONS = 8;   // relances automatiques apres max_tokens
var MAX_PAUSES = 6;          // relances automatiques apres pause_turn (web search)
var MAX_ATTEMPTS = 4;        // tentatives par appel (429 / 5xx / reseau)
var HEARTBEAT_MS = 10000;    // ping pour garder la connexion vivante

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function isRetriable(status) {
  return status === 408 || status === 409 || status === 429 ||
    status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
}

/* ---------------------------------------------------------------- *
 * Appel streaming vers Anthropic : renvoie les blocs de contenu     *
 * complets, le texte, stop_reason et l'usage.                       *
 * onDelta(texte) est appele au fil de l'eau.                        *
 * ---------------------------------------------------------------- */
async function callAnthropicStream(payload, apiKey, onDelta) {
  var response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION
    },
    body: JSON.stringify(Object.assign({}, payload, { stream: true }))
  });

  if (!response.ok) {
    var raw = '';
    try { raw = await response.text(); } catch (e) { raw = ''; }
    var msg = 'Erreur API ' + response.status;
    try {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.error && parsed.error.message) msg = parsed.error.message;
    } catch (e2) {
      if (raw) msg = msg + ' : ' + String(raw).slice(0, 300);
    }
    var err = new Error(msg);
    err.status = response.status;
    err.retriable = isRetriable(response.status);
    throw err;
  }

  var blocks = [];
  var text = '';
  var stopReason = null;
  var usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  var reader = response.body.getReader();
  var decoder = new TextDecoder();
  var buffer = '';

  function handleEvent(data) {
    var ev;
    try { ev = JSON.parse(data); } catch (e) { return; }
    var i;

    if (ev.type === 'message_start' && ev.message && ev.message.usage) {
      usage.input_tokens += ev.message.usage.input_tokens || 0;
      usage.cache_read_input_tokens += ev.message.usage.cache_read_input_tokens || 0;
      usage.cache_creation_input_tokens += ev.message.usage.cache_creation_input_tokens || 0;
      return;
    }
    if (ev.type === 'content_block_start') {
      i = ev.index;
      var b = JSON.parse(JSON.stringify(ev.content_block || {}));
      if (b.type === 'text' && typeof b.text !== 'string') b.text = '';
      if (b.type === 'thinking' && typeof b.thinking !== 'string') b.thinking = '';
      blocks[i] = b;
      return;
    }
    if (ev.type === 'content_block_delta') {
      i = ev.index;
      if (!blocks[i]) blocks[i] = { type: 'text', text: '' };
      var d = ev.delta || {};
      if (d.type === 'text_delta') {
        blocks[i].text = (blocks[i].text || '') + (d.text || '');
        text += d.text || '';
        if (onDelta && d.text) onDelta(d.text);
      } else if (d.type === 'input_json_delta') {
        blocks[i]._json = (blocks[i]._json || '') + (d.partial_json || '');
      } else if (d.type === 'thinking_delta') {
        blocks[i].thinking = (blocks[i].thinking || '') + (d.thinking || '');
      } else if (d.type === 'signature_delta') {
        blocks[i].signature = (blocks[i].signature || '') + (d.signature || '');
      } else if (d.type === 'citations_delta' && d.citation) {
        blocks[i].citations = (blocks[i].citations || []).concat([d.citation]);
      }
      return;
    }
    if (ev.type === 'content_block_stop') {
      i = ev.index;
      if (blocks[i] && typeof blocks[i]._json === 'string') {
        try { blocks[i].input = JSON.parse(blocks[i]._json || '{}'); } catch (e) { blocks[i].input = blocks[i].input || {}; }
        delete blocks[i]._json;
      }
      return;
    }
    if (ev.type === 'message_delta') {
      if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
      if (ev.usage) usage.output_tokens += ev.usage.output_tokens || 0;
      return;
    }
    if (ev.type === 'error') {
      var e2 = new Error((ev.error && ev.error.message) || 'Erreur de streaming');
      e2.retriable = true;
      throw e2;
    }
  }

  while (true) {
    var chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    var lines = buffer.split('\n');
    buffer = lines.pop();
    for (var k = 0; k < lines.length; k++) {
      var line = lines[k].trim();
      if (line.indexOf('data:') !== 0) continue;
      var data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      handleEvent(data);
    }
  }

  return {
    blocks: blocks.filter(Boolean),
    text: text,
    stop_reason: stopReason,
    usage: usage
  };
}

/* Appel avec retries (uniquement si rien n'a encore ete emis pour ce tour) */
async function callWithRetry(payload, apiKey, onDelta, onResetRound) {
  var attempt = 0;
  while (true) {
    attempt++;
    var emitted = false;
    try {
      return await callAnthropicStream(payload, apiKey, function (t) {
        emitted = true;
        if (onDelta) onDelta(t);
      });
    } catch (err) {
      var canRetry = attempt < MAX_ATTEMPTS && (err.retriable !== false);
      if (!canRetry) throw err;
      if (emitted && onResetRound) onResetRound();
      await sleep(Math.min(8000, 700 * Math.pow(2, attempt - 1)));
    }
  }
}

/* Nettoie les blocs avant de les renvoyer dans la conversation */
function sanitizeBlocks(blocks) {
  var out = [];
  for (var i = 0; i < blocks.length; i++) {
    var b = JSON.parse(JSON.stringify(blocks[i]));
    delete b._json;
    if (b.type === 'text') {
      if (typeof b.text !== 'string' || !b.text.length) continue;
      out.push(b);
    } else {
      out.push(b);
    }
  }
  // L'API refuse un dernier bloc texte se terminant par un espace.
  var last = out[out.length - 1];
  if (last && last.type === 'text') {
    last.text = last.text.replace(/\s+$/, '');
    if (!last.text.length) out.pop();
  }
  return out;
}

/* ---------------------------------------------------------------- *
 * Conversation complete avec auto-continuation                      *
 * ---------------------------------------------------------------- */
async function runConversation(opts, hooks) {
  var messages = opts.messages.slice();
  var full = '';
  var sources = [];
  var usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  var continuations = 0;
  var pauses = 0;
  var stopReason = null;

  function addSources(blocks) {
    blocks.forEach(function (b) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        b.content.forEach(function (item) {
          if (item && item.url && sources.length < 40) {
            sources.push({ title: item.title || item.url, url: item.url });
          }
        });
      }
    });
  }

  while (true) {
    var payload = {
      model: opts.model,
      max_tokens: opts.max_tokens,
      messages: messages
    };
    if (opts.system) payload.system = opts.system;
    if (typeof opts.temperature === 'number') payload.temperature = opts.temperature;
    if (opts.tools) payload.tools = opts.tools;

    var checkpoint = full;
    var round = await callWithRetry(
      payload,
      opts.apiKey,
      function (t) { full += t; if (hooks && hooks.onDelta) hooks.onDelta(t); },
      function () { full = checkpoint; if (hooks && hooks.onReset) hooks.onReset(full); }
    );

    addSources(round.blocks);
    usage.input_tokens += round.usage.input_tokens || 0;
    usage.output_tokens += round.usage.output_tokens || 0;
    usage.cache_read_input_tokens += round.usage.cache_read_input_tokens || 0;
    usage.cache_creation_input_tokens += round.usage.cache_creation_input_tokens || 0;
    stopReason = round.stop_reason;

    // Recherche web en cours : on relance le meme tour.
    if (stopReason === 'pause_turn' && pauses < MAX_PAUSES) {
      pauses++;
      messages = messages.concat([{ role: 'assistant', content: sanitizeBlocks(round.blocks) }]);
      if (hooks && hooks.onInfo) hooks.onInfo('recherche web en cours...');
      continue;
    }

    // Reponse tronquee : on continue automatiquement.
    if (stopReason === 'max_tokens' && opts.autoContinue !== false && continuations < MAX_CONTINUATIONS) {
      continuations++;
      var assistantBlocks = sanitizeBlocks(round.blocks);
      if (!assistantBlocks.length) break;
      messages = messages.concat([
        { role: 'assistant', content: assistantBlocks },
        {
          role: 'user',
          content: 'Continue EXACTEMENT la ou tu t as arrete, au caractere pres. ' +
            'Ne repete rien, n ajoute aucune introduction, aucun commentaire et aucun bloc de code. ' +
            'Poursuis simplement le JSON jusqu a ce qu il soit complet et valide.'
        }
      ]);
      if (hooks && hooks.onInfo) hooks.onInfo('suite de la reponse (' + continuations + ')...');
      continue;
    }

    break;
  }

  return {
    content: full.trim(),
    sources: sources,
    stop_reason: stopReason,
    continuations: continuations,
    usage: usage
  };
}

/* ---------------------------------------------------------------- *
 * Handler HTTP                                                      *
 * ---------------------------------------------------------------- */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-transform');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var streaming = false;
  var heartbeat = null;

  function send(obj) {
    try { res.write(JSON.stringify(obj) + '\n'); } catch (e) { /* connexion fermee */ }
  }

  try {
    var body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    var apiKey = body.apiKey || process.env.ANTHROPIC_API_KEY;
    var messages = (Array.isArray(body.messages) && body.messages.length > 0)
      ? body.messages
      : (body.message ? [{ role: 'user', content: body.message }] : null);

    if (!apiKey) return res.status(400).json({ error: 'Cle API manquante' });
    if (!messages) return res.status(400).json({ error: 'Aucun message fourni' });

    var opts = {
      apiKey: apiKey,
      model: body.model || 'claude-sonnet-5',
      max_tokens: Math.min(Math.max(parseInt(body.max_tokens, 10) || 8000, 1024), 64000),
      messages: messages,
      autoContinue: body.autoContinue !== false
    };
    if (body.system) opts.system = body.system;           // texte OU tableau de blocs (cache_control supporte)
    if (typeof body.temperature === 'number') opts.temperature = body.temperature;

    if (body.webSearch) {
      var tool = {
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
      opts.tools = [tool];
    }

    streaming = !!body.stream;

    if (!streaming) {
      var result = await runConversation(opts, null);
      return res.status(200).json(result);
    }

    // --- Mode streaming (NDJSON) ---
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    var lastWrite = Date.now();
    heartbeat = setInterval(function () {
      if (Date.now() - lastWrite > HEARTBEAT_MS) { send({ type: 'ping' }); lastWrite = Date.now(); }
    }, HEARTBEAT_MS);

    send({ type: 'start' });

    var out = await runConversation(opts, {
      onDelta: function (t) { lastWrite = Date.now(); send({ type: 'delta', text: t }); },
      onReset: function (content) { lastWrite = Date.now(); send({ type: 'reset', content: content }); },
      onInfo: function (m) { lastWrite = Date.now(); send({ type: 'info', message: m }); }
    });

    clearInterval(heartbeat); heartbeat = null;
    send({
      type: 'done',
      content: out.content,
      sources: out.sources,
      stop_reason: out.stop_reason,
      continuations: out.continuations,
      usage: out.usage
    });
    return res.end();
  } catch (error) {
    if (heartbeat) clearInterval(heartbeat);
    var message = (error && error.message) ? error.message : 'Erreur inconnue';
    if (streaming) {
      send({ type: 'error', error: message });
      try { return res.end(); } catch (e) { return; }
    }
    if (res.headersSent) { try { return res.end(); } catch (e) { return; } }
    return res.status(error && error.status && error.status >= 400 && error.status < 600 ? error.status : 500)
      .json({ error: message });
  }
};

// Vercel : duree maximale d'execution (300 s = maximum du plan Hobby).
module.exports.config = { maxDuration: 300 };
