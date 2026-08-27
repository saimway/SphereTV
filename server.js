const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const { URL } = require('url');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Keep-alive agents for faster upstream connections (reuses TCP sockets)
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;

// In-memory team logo cache
const logoCache = new Map();

// Enable CORS for all routes
app.use(cors());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// ─── Streamed API base URL ───────────────────────────────────────────────────
const STREAMED_API = 'https://streamed.pk';

// ─── Headers for upstream requests ───────────────────────────────────────────
function getUpstreamHeaders(referer) {
  let origin = 'https://embed.st';
  try {
    if (referer) {
      origin = new URL(referer).origin;
    }
  } catch (e) {}

  return {
    'Referer': referer || 'https://embed.st/',
    'Origin': origin,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

function buildProxyUrl(upstreamUrl, proxyBase) {
  const encoded = encodeURIComponent(upstreamUrl);
  if (upstreamUrl.endsWith('.m3u8') || upstreamUrl.includes('.m3u8?')) {
    return `${proxyBase}/proxy/m3u8?url=${encoded}`;
  }
  if (upstreamUrl.endsWith('.ts') || upstreamUrl.includes('.ts?')) {
    return `${proxyBase}/proxy/segment?url=${encoded}`;
  }
  return `${proxyBase}/proxy/key?url=${encoded}`;
}

function rewriteM3u8(body, playlistUrl, proxyBase) {
  const lines = body.split('\n');
  const rewritten = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Rewrite #EXT-X-KEY URI
    if (line.startsWith('#EXT-X-KEY') && line.includes('URI="')) {
      const replaced = line.replace(/URI="([^"]+)"/, (_, uri) => {
        const absolute = resolveUrl(playlistUrl, uri);
        const proxied = `${proxyBase}/proxy/key?url=${encodeURIComponent(absolute)}`;
        return `URI="${proxied}"`;
      });
      rewritten.push(replaced);
      continue;
    }

    // Rewrite #EXT-X-MAP URI
    if (line.startsWith('#EXT-X-MAP') && line.includes('URI="')) {
      const replaced = line.replace(/URI="([^"]+)"/, (_, uri) => {
        const absolute = resolveUrl(playlistUrl, uri);
        const proxied = `${proxyBase}/proxy/segment?url=${encodeURIComponent(absolute)}`;
        return `URI="${proxied}"`;
      });
      rewritten.push(replaced);
      continue;
    }

    if (line.startsWith('#') || line.trim() === '') {
      rewritten.push(line);
      continue;
    }

    // URI line (segment or sub-playlist)
    const absolute = resolveUrl(playlistUrl, line.trim());
    rewritten.push(buildProxyUrl(absolute, proxyBase));
  }

  return rewritten.join('\n');
}

function sanitizeEmbedHtml(rawHtml, sourceUrl, proxyBase) {
  let clean = rawHtml;

  // 1. Strip external ad/tracking script tags
  clean = clean.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, content) => {
    const isAdSrc = /src=["'](?:[^"']*(?:llvpn|therocketlanguages|optimserve|cdn4ads|cloudfront\.net\/IB|joesowvykmdi|awsojycgreaxzc|simpleanalyticscdn|adkeeper|propellerads|popads|clickadu|t48s7z|aclib|stats\.embedhd\.st|a\.cdn-lab\.shop|hilltopads|exposestrat\.com\/tag|richaudience|monetag|vidsrc-stream))/i.test(attrs);
    const isAdContent = /(?:dataset\.zone|popundersPerIP|topmostLayer|\/ad\.html|aclib\.runPop|zoneId|therocketlanguages|optimserve|plausible)/i.test(content);
    if (isAdSrc || isAdContent) {
      return '<!-- [AdShield] Ad script removed -->';
    }
    return match;
  });

  // 2. Neutralize anti-sandbox detection, anti-adblock alerts and anti-debuggers
  clean = clean.replace(/if\s*\(\s*hasSandbox\s*\)\s*{[\s\S]*?SANDBOX IFRAME NOT ALLOWED[\s\S]*?}/gi, '/* [AdShield] Sandbox check bypassed */');
  clean = clean.replace(/var\s+hasSandbox\s*=\s*false[\s\S]*?if\s*\(\s*hasSandbox\s*\)\s*{/gi, 'var hasSandbox = false; if (false) {');
  clean = clean.replace(/if\s*\([^)]*sandbox[^)]*\)\s*{[\s\S]*?(?:Remove sandbox attributes|SANDBOX IFRAME NOT ALLOWED)[\s\S]*?}/gi, '/* [AdShield] Sandbox check bypassed */');
  clean = clean.replace(/function\s+dbgCheck\s*\(\s*\)\s*{[\s\S]*?}/gi, 'function dbgCheck() { return false; }');
  clean = clean.replace(/\bdebugger\s*;?/gi, '');
  clean = clean.replace(/window\.stop\s*\(\s*\)/gi, '/* [AdShield] window.stop bypassed */');

  // 3. Remove ad iframes & ad comments
  clean = clean.replace(/<!--[\s\S]*?optimserve[\s\S]*?-->/gi, '');
  clean = clean.replace(/<iframe\b[^>]*src=["'][^"']*ad\.html[^"']*["'][^>]*>[\s\S]*?<\/iframe>/gi, '');

  // 4. Rewrite nested iframes to route through embed-proxy
  clean = clean.replace(/<iframe\b([^>]*?)src=["']([^"']+)["']([^>]*)>/gi, (match, before, src, after) => {
    if (src.includes('ad.html')) return '';
    const proxiedSrc = `${proxyBase}/api/embed-proxy?url=${encodeURIComponent(src)}`;
    return `<iframe ${before}src="${proxiedSrc}"${after}>`;
  });

  // 5. Inject safe, non-intrusive AdShield script
  const shieldScript = `
<script>
(function() {
  "use strict";
  // 1. Popup & Window Open Blocker
  window.open = function() {
    console.warn("[AdShield] Popup open blocked");
    return {
      closed: true,
      focus: function() {},
      blur: function() {},
      close: function() {},
      location: { href: "about:blank" }
    };
  };
  // 2. Safe Anti-Sandbox patch: Ensure hasAttribute('sandbox') returns false
  try {
    if (window.frameElement) {
      const origHasAttr = window.frameElement.hasAttribute ? window.frameElement.hasAttribute.bind(window.frameElement) : null;
      window.frameElement.hasAttribute = function(attr) {
        if (attr === "sandbox") return false;
        return origHasAttr ? origHasAttr(attr) : false;
      };
    }
  } catch(e) {}
})();
</script>
`;

  if (clean.includes('<head>')) {
    clean = clean.replace('<head>', '<head>' + shieldScript);
  } else if (clean.includes('<html')) {
    clean = clean.replace(/<html[^>]*>/i, '$&' + shieldScript);
  } else {
    clean = shieldScript + clean;
  }

  return clean;
}

/**
 * Enriches matches to ensure matches with "Team A vs Team B" have structured teams.home and teams.away.
 * Generates normalized badge IDs from team names for streamed.pk badge lookups.
 */
function enrichMatches(matches) {
  if (!Array.isArray(matches)) return matches;
  return matches.map((m) => {
    if (!m) return m;

    // Helper: generate a normalized badge ID from team name
    function makeBadgeId(name) {
      if (!name) return '';
      return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    // If teams already exist with names, ensure badges are set
    if (m.teams && m.teams.home && m.teams.away && m.teams.home.name && m.teams.away.name) {
      // Fill in missing badge IDs from team names
      if (!m.teams.home.badge) m.teams.home.badge = makeBadgeId(m.teams.home.name);
      if (!m.teams.away.badge) m.teams.away.badge = makeBadgeId(m.teams.away.name);
      return m;
    }

    // Parse "Team A vs Team B" from title
    if (m.title && typeof m.title === 'string') {
      const parts = m.title.split(/\s+(?:vs\.?|v\.?|@)\s+/i);
      if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
        const homeName = parts[0].trim();
        const awayName = parts[1].trim();
        return {
          ...m,
          teams: {
            home: { name: homeName, badge: makeBadgeId(homeName) },
            away: { name: awayName, badge: makeBadgeId(awayName) },
          },
        };
      }
    }
    return m;
  });
}

/**
 * Generates an SVG badge crest for any team as a fast, beautiful fallback.
 */
function generateTeamSvg(teamName) {
  const clean = (teamName || 'Team').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  let initials = '';
  if (words.length >= 2) {
    initials = (words[0][0] + words[1][0]).toUpperCase();
  } else if (clean.length > 0) {
    initials = clean.slice(0, 2).toUpperCase();
  } else {
    initials = 'T';
  }

  let hash = 0;
  for (let i = 0; i < clean.length; i++) {
    hash = (hash << 5) - hash + clean.charCodeAt(i);
    hash |= 0;
  }

  const hues = [
    ['#00e68a', '#00c2ff'],
    ['#ff4d5e', '#ff8a00'],
    ['#7928ca', '#ff0080'],
    ['#0070f3', '#00dfd8'],
    ['#f5a623', '#f8e71c'],
    ['#10b981', '#06b6d4'],
    ['#6366f1', '#a855f7'],
    ['#ec4899', '#f43f5e'],
  ];
  const colorPair = hues[Math.abs(hash) % hues.length];

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <defs>
    <linearGradient id="shieldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${colorPair[0]}"/>
      <stop offset="100%" stop-color="${colorPair[1]}"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.25"/>
    </filter>
  </defs>
  <path d="M48 6 C68 6 84 14 84 32 C84 62 48 88 48 88 C48 88 12 62 12 32 C12 14 28 6 48 6 Z"
        fill="url(#shieldGrad)" filter="url(#shadow)" stroke="rgba(255,255,255,0.3)" stroke-width="2"/>
  <path d="M48 12 C64 12 76 18 76 33 C76 57 48 78 48 78 C48 78 20 57 20 33 C20 18 32 12 48 12 Z"
        fill="rgba(0,0,0,0.18)"/>
  <text x="48" y="52"
        font-family="Space Grotesk, Inter, -apple-system, sans-serif"
        font-size="${initials.length > 2 ? '22' : '26'}"
        font-weight="800"
        fill="#ffffff"
        text-anchor="middle"
        letter-spacing="1">
    ${initials}
  </text>
</svg>`;
}

/**
 * Resolves a team logo URL using TheSportsDB free API with caching.
 */
async function resolveTeamLogoUrl(teamName) {
  if (!teamName || typeof teamName !== 'string') return null;
  const clean = teamName.trim();
  const cacheKey = clean.toLowerCase();

  if (logoCache.has(cacheKey)) {
    return logoCache.get(cacheKey);
  }

  // 1. Check TheSportsDB
  try {
    const res = await axios.get(
      `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(clean)}`,
      { timeout: 4000 }
    );
    const badge = res.data?.teams?.[0]?.strBadge;
    if (badge) {
      logoCache.set(cacheKey, badge);
      return badge;
    }
  } catch (e) {}

  // 2. Try simplified name (e.g. "Real Madrid CF" -> "Real Madrid")
  const simplified = clean
    .replace(/\b(fc|cf|sc|ac|bc|fk|afc|bk|sk|united|city|club)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (simplified && simplified.toLowerCase() !== cacheKey) {
    try {
      const res = await axios.get(
        `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(simplified)}`,
        { timeout: 4000 }
      );
      const badge = res.data?.teams?.[0]?.strBadge;
      if (badge) {
        logoCache.set(cacheKey, badge);
        return badge;
      }
    } catch (e) {}
  }

  logoCache.set(cacheKey, null);
  return null;
}

// ─── API Endpoints (streamed.pk proxy) ───────────────────────────────────────

/**
 * GET /api/sports — List all sports categories
 */
app.get('/api/sports', async (req, res) => {
  try {
    const response = await axios.get(`${STREAMED_API}/api/sports`, {
      headers: getUpstreamHeaders(),
      timeout: 15000,
    });
    res.json(response.data);
  } catch (err) {
    console.error('[api/sports] Error:', err.message);
    res.status(err.response?.status || 502).json({ error: err.message });
  }
});

/**
 * GET /api/matches/:sport/popular — List popular matches for a specific sport
 */
app.get('/api/matches/:sport/popular', async (req, res) => {
  try {
    const { sport } = req.params;
    const response = await axios.get(`${STREAMED_API}/api/matches/${sport}/popular`, {
      headers: getUpstreamHeaders(),
      timeout: 15000,
    });
    res.json(enrichMatches(response.data));
  } catch (err) {
    console.error(`[api/matches/${req.params.sport}/popular] Error:`, err.message);
    res.status(err.response?.status || 502).json({ error: err.message });
  }
});

/**
 * GET /api/matches/:sport — List matches for a sport
 */
app.get('/api/matches/:sport', async (req, res) => {
  try {
    const { sport } = req.params;
    const targetUrl =
      sport === 'all'
        ? `${STREAMED_API}/api/matches/all`
        : sport === 'all-today'
        ? `${STREAMED_API}/api/matches/all-today`
        : `${STREAMED_API}/api/matches/${sport}`;
    const response = await axios.get(targetUrl, {
      headers: getUpstreamHeaders(),
      timeout: 15000,
    });
    res.json(enrichMatches(response.data));
  } catch (err) {
    console.error(`[api/matches/${req.params.sport}] Error:`, err.message);
    res.status(err.response?.status || 502).json({ error: err.message });
  }
});

/**
 * GET /api/matches-all — List all matches
 */
app.get('/api/matches-all', async (req, res) => {
  try {
    const response = await axios.get(`${STREAMED_API}/api/matches/all-today`, {
      headers: getUpstreamHeaders(),
      timeout: 15000,
    });
    res.json(enrichMatches(response.data));
  } catch (err) {
    console.error('[api/matches/all] Error:', err.message);
    res.status(err.response?.status || 502).json({ error: err.message });
  }
});

/**
 * GET /api/matches-all/popular — List all popular matches
 */
app.get('/api/matches-all/popular', async (req, res) => {
  try {
    const response = await axios.get(`${STREAMED_API}/api/matches/all/popular`, {
      headers: getUpstreamHeaders(),
      timeout: 15000,
    });
    res.json(enrichMatches(response.data));
  } catch (err) {
    console.error('[api/matches/all/popular] Error:', err.message);
    res.status(err.response?.status || 502).json({ error: err.message });
  }
});

/**
 * GET /api/matches-live — List live matches
 */
app.get('/api/matches-live', async (req, res) => {
  try {
    const response = await axios.get(`${STREAMED_API}/api/matches/live`, {
      headers: getUpstreamHeaders(),
      timeout: 15000,
    });
    res.json(enrichMatches(response.data));
  } catch (err) {
    console.error('[api/matches/live] Error:', err.message);
    res.status(err.response?.status || 502).json({ error: err.message });
  }
});

/**
 * GET /api/stream/:source/:id — Get stream details (embed URLs)
 */
app.get('/api/stream/:source/:id', async (req, res) => {
  try {
    const { source, id } = req.params;
    const response = await axios.get(`${STREAMED_API}/api/stream/${source}/${id}`, {
      headers: getUpstreamHeaders(),
      timeout: 8000,
    });
    res.json(response.data);
  } catch (err) {
    console.error(`[api/stream] Error:`, err.message);
    res.status(err.response?.status || 502).json({ error: err.message });
  }
});

/**
 * GET /api/images/* — Proxy team badges, posters, and image assets from streamed.pk
 */
app.get('/api/images/*', async (req, res) => {
  try {
    let subPath = req.originalUrl.replace(/^\/api\/images\//, '');
    // If no file extension, append .webp (streamed.pk requires .webp for badges and proxies)
    if (!/\.(webp|png|jpg|jpeg|svg|gif)$/i.test(subPath)) {
      subPath += '.webp';
    }
    const targetUrl = `${STREAMED_API}/api/images/${subPath}`;
    const response = await axios.get(targetUrl, {
      headers: getUpstreamHeaders(),
      responseType: 'arraybuffer',
      timeout: 15000,
    });
    res.set({
      'Content-Type': response.headers['content-type'] || 'image/webp',
      'Cache-Control': 'public, max-age=86400',
    });
    res.send(Buffer.from(response.data));
  } catch (err) {
    console.error(`[api/images] Error fetching ${req.originalUrl}:`, err.message);
    res.status(404).send('Image Not Found');
  }
});

/**
 * GET /api/team-logo — Resolves real team logos (e.g. Real Madrid, Barcelona, Lyon) via TheSportsDB or generates custom SVG badge
 */
app.get('/api/team-logo', async (req, res) => {
  const teamName = req.query.name || req.query.team;
  if (!teamName) {
    return res.status(400).send('Missing "name" query parameter');
  }

  try {
    const logoUrl = await resolveTeamLogoUrl(teamName);
    if (logoUrl) {
      const imgRes = await axios.get(logoUrl, {
        responseType: 'arraybuffer',
        timeout: 5000,
      });
      res.set({
        'Content-Type': imgRes.headers['content-type'] || 'image/png',
        'Cache-Control': 'public, max-age=604800', // Cache 7 days
      });
      return res.send(Buffer.from(imgRes.data));
    }
  } catch (err) {
    // If fetching external image fails, proceed to SVG fallback
  }

  const svg = generateTeamSvg(teamName);
  res.set({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=86400',
  });
  res.send(svg);
});

// ─── HLS Proxy Endpoints ─────────────────────────────────────────────────────

/**
 * GET /proxy/m3u8?url=<encoded m3u8 URL>
 */
app.get('/proxy/m3u8', async (req, res) => {
  const url = req.query.url;
  const referer = req.query.referer;
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  try {
    console.log(`[m3u8] Fetching: ${url}`);
    const response = await axios.get(url, {
      headers: getUpstreamHeaders(referer),
      responseType: 'text',
      timeout: 15000,
    });

    const proxyBase = `${req.protocol}://${req.get('host')}`;
    const rewritten = rewriteM3u8(response.data, url, proxyBase);

    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache, no-store',
    });
    res.send(rewritten);
  } catch (err) {
    console.error(`[m3u8] Error fetching ${url}:`, err.message);
    const status = err.response?.status || 502;
    res.status(status).json({
      error: 'Failed to fetch playlist',
      upstream_status: err.response?.status,
      message: err.message,
    });
  }
});

/**
 * GET /proxy/segment?url=<encoded .ts segment URL>
 */
app.get('/proxy/segment', async (req, res) => {
  const url = req.query.url;
  const referer = req.query.referer;
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  try {
    const response = await axios.get(url, {
      headers: getUpstreamHeaders(referer),
      responseType: 'stream',
      timeout: 30000,
    });

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp2t',
      'Cache-Control': 'public, max-age=300',
    });
    if (response.headers['content-length']) {
      res.set('Content-Length', response.headers['content-length']);
    }
    response.data.pipe(res);
  } catch (err) {
    console.error(`[segment] Error fetching ${url}:`, err.message);
    const status = err.response?.status || 502;
    res.status(status).json({
      error: 'Failed to fetch segment',
      upstream_status: err.response?.status,
      message: err.message,
    });
  }
});

/**
 * GET /proxy/key?url=<encoded key URL>
 */
app.get('/proxy/key', async (req, res) => {
  const url = req.query.url;
  const referer = req.query.referer;
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  try {
    console.log(`[key] Fetching: ${url}`);
    const response = await axios.get(url, {
      headers: getUpstreamHeaders(referer),
      responseType: 'arraybuffer',
      timeout: 15000,
    });

    res.set({
      'Content-Type': response.headers['content-type'] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=300',
    });
    res.send(Buffer.from(response.data));
  } catch (err) {
    console.error(`[key] Error fetching ${url}:`, err.message);
    const status = err.response?.status || 502;
    res.status(status).json({
      error: 'Failed to fetch key',
      upstream_status: err.response?.status,
      message: err.message,
    });
  }
});

/**
 * GET /embed/* — Direct embed proxy to preserve exact URL pathname for stream players
 */
app.get('/embed/*', async (req, res) => {
  const targetUrl = `https://embed.st${req.originalUrl}`;
  try {
    console.log(`[embed] Fetching and sanitizing: ${targetUrl}`);
    const response = await axios.get(targetUrl, {
      headers: getUpstreamHeaders('https://rabbitmeow.online/'),
      responseType: 'text',
      timeout: 15000,
    });

    const proxyBase = `${req.protocol}://${req.get('host')}`;
    const sanitizedHtml = sanitizeEmbedHtml(response.data, targetUrl, proxyBase);

    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.send(sanitizedHtml);
  } catch (err) {
    console.error(`[embed] Error fetching ${targetUrl}:`, err.message);
    res.status(err.response?.status || 502).send(`
<!DOCTYPE html>
<html>
<body style="margin:0;background:#000;color:#ef4444;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,-apple-system,sans-serif;text-align:center;">
  <div>
    <h3 style="margin-bottom:0.5rem;">Failed to load stream embed</h3>
    <p style="color:#888;font-size:0.85rem;">${err.message}</p>
  </div>
</body>
</html>
`);
  }
});

/**
 * GET /source/* — Proxy for embedhd.st nested sources
 */
app.get('/source/*', async (req, res) => {
  const targetUrl = `https://embedhd.st${req.originalUrl}`;
  try {
    console.log(`[source] Fetching and sanitizing: ${targetUrl}`);
    const response = await axios.get(targetUrl, {
      headers: getUpstreamHeaders('https://embed.st/'),
      responseType: 'text',
      timeout: 15000,
    });

    const proxyBase = `${req.protocol}://${req.get('host')}`;
    const sanitizedHtml = sanitizeEmbedHtml(response.data, targetUrl, proxyBase);

    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.send(sanitizedHtml);
  } catch (err) {
    console.error(`[source] Error fetching ${targetUrl}:`, err.message);
    res.status(err.response?.status || 502).send(`
<!DOCTYPE html>
<html>
<body style="margin:0;background:#000;color:#ef4444;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,-apple-system,sans-serif;text-align:center;">
  <div>
    <h3 style="margin-bottom:0.5rem;">Failed to load source embed</h3>
    <p style="color:#888;font-size:0.85rem;">${err.message}</p>
  </div>
</body>
</html>
`);
  }
});

/**
 * GET /api/embed-proxy?url=<encoded embed URL> — Clean embed player proxy (Ad-Free & Sandbox-Free)
 */
app.get('/api/embed-proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).send('Missing "url" query parameter');
  }

  try {
    console.log(`[embed-proxy] Fetching and sanitizing: ${targetUrl}`);
    let referer = 'https://rabbitmeow.online/';
    try {
      const u = new URL(targetUrl);
      if (u.hostname.includes('embedhd.st')) {
        referer = 'https://embed.st/';
      } else if (u.hostname.includes('exposestrat.com')) {
        referer = 'https://embedhd.st/';
      }
    } catch(e) {}

    const response = await axios.get(targetUrl, {
      headers: getUpstreamHeaders(referer),
      responseType: 'text',
      timeout: 15000,
    });

    const proxyBase = `${req.protocol}://${req.get('host')}`;
    const sanitizedHtml = sanitizeEmbedHtml(response.data, targetUrl, proxyBase);

    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.send(sanitizedHtml);
  } catch (err) {
    console.error(`[embed-proxy] Error fetching ${targetUrl}:`, err.message);
    res.status(err.response?.status || 502).send(`
<!DOCTYPE html>
<html>
<body style="margin:0;background:#000;color:#ef4444;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,-apple-system,sans-serif;text-align:center;">
  <div>
    <h3 style="margin-bottom:0.5rem;">Failed to load stream embed</h3>
    <p style="color:#888;font-size:0.85rem;">${err.message}</p>
  </div>
</body>
</html>
`);
  }
});

// ─── Fallback: serve frontend ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
🎬 HLS Proxy Server running at http://localhost:${PORT}
`);
});
