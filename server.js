const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// ─── Streamed API base URL ───────────────────────────────────────────────────
const STREAMED_API = 'https://streamed.pk';

// ─── Headers for upstream requests ───────────────────────────────────────────
function getUpstreamHeaders(referer) {
  return {
    'Referer': referer || 'https://embed.st/',
    'Origin': referer ? new URL(referer).origin : 'https://embed.st',
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
 * GET /api/matches/:sport — List matches for a sport
 */
app.get('/api/matches/:sport', async (req, res) => {
  try {
    const response = await axios.get(`${STREAMED_API}/api/matches/${req.params.sport}`, {
      headers: getUpstreamHeaders(),
      timeout: 15000,
    });
    res.json(response.data);
  } catch (err) {
    console.error(`[api/matches/${req.params.sport}] Error:`, err.message);
    res.status(err.response?.status || 502).json({ error: err.message });
  }
});

/**
 * GET /api/matches/all — List all matches
 */
app.get('/api/matches-all', async (req, res) => {
  try {
    const response = await axios.get(`${STREAMED_API}/api/matches/all`, {
      headers: getUpstreamHeaders(),
      timeout: 15000,
    });
    res.json(response.data);
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
    res.json(response.data);
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
    res.json(response.data);
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
      timeout: 15000,
    });
    res.json(response.data);
  } catch (err) {
    console.error(`[api/stream] Error:`, err.message);
    res.status(err.response?.status || 502).json({ error: err.message });
  }
});

/**
 * GET /api/images/badge/:id — Proxy team badge images
 */
app.get('/api/images/badge/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const response = await axios.get(`${STREAMED_API}/api/images/badge/${id}`, {
      headers: getUpstreamHeaders(),
      responseType: 'stream',
      timeout: 10000,
    });
    res.set({
      'Content-Type': response.headers['content-type'] || 'image/webp',
      'Cache-Control': 'public, max-age=86400', // Cache badges for 1 day
    });
    response.data.pipe(res);
  } catch (err) {
    console.error(`[api/images/badge] Error fetching badge ${req.params.id}:`, err.message);
    res.status(404).send('Not Found');
  }
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

// ─── Fallback: serve frontend ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  🎬  HLS Proxy Server running at http://localhost:${PORT}\n`);
});
