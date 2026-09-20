const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// Remove variáveis que o Render pode injetar e que sobrescreveriam a config abaixo.
['DATABASE_URL', 'PGCONNECT_TIMEOUT', 'PGPASSWORD', 'PGDATABASE', 'PGUSER', 'PGHOST']
  .forEach((k) => delete process.env[k]);

const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // "não achei" expira em 7 dias e tenta de novo
const USER_AGENT = 'LyricATProxy/1.1 (github.com/agropescas/lyricat-server)';

const pool = new Pool({
  host: 'aws-0-sa-east-1.pooler.supabase.com',
  port: 6543,
  database: 'postgres',
  user: 'postgres.pmvoncwjjjbafmmieiaz',
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on('error', (err) => console.error('❌ Erro no pool:', err.message));

async function iniciarBanco() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cache_letras (
        id SERIAL PRIMARY KEY,
        track_id VARCHAR(255) UNIQUE,
        artist TEXT,
        track TEXT,
        synced_lyrics TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Banco de dados e tabela verificados com sucesso!');
  } catch (err) {
    console.error('❌ Erro fatal ao iniciar tabela no banco:', err.message);
  }
}

// ---------------------------------------------------------------- LRCLIB
const lrclib = axios.create({
  baseURL: 'https://lrclib.net/api',
  timeout: 5000,
  headers: { 'User-Agent': USER_AGENT },
  validateStatus: () => true // 404 é resposta normal ("não existe"), não exceção
});

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // Beyoncé == Beyonce
    .toLowerCase()
    .replace(/[-–—_.,:;!?()[\]{}/\\'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MARCADORES = ['remaster', 'remastered', 'deluxe', 'live', 'version', 'edit',
  'acoustic', 'feat.', 'feat ', 'ft.', 'with '];

function temMarcador(txt) {
  const b = txt.toLowerCase();
  return MARCADORES.some((m) => b.includes(m));
}

// Mesma ideia do limparTituloParaLetra() do firmware.
function limparTitulo(titulo) {
  let t = String(titulo || '').trim();
  for (let pass = 0; pass < 4; pass++) {
    const m = t.match(/[([]/);
    if (!m) break;
    const abre = m.index;
    const fechaChar = m[0] === '(' ? ')' : ']';
    const fecha = t.indexOf(fechaChar, abre + 1);
    if (fecha < 0) break;
    if (!temMarcador(t.substring(abre + 1, fecha))) break; // parênteses que fazem parte do título
    t = (t.substring(0, abre) + t.substring(fecha + 1)).trim();
  }
  const traco = t.indexOf(' - ');
  if (traco >= 0 && temMarcador(t.substring(traco + 3))) t = t.substring(0, traco);
  return t.trim();
}

// Só letras com timestamp real. `ctx.erro` marca falha transitória (timeout, 5xx, 429),
// para não confundir "LRCLIB caiu" com "a música não existe".
async function lrclibGet(track, artist, album, dur, ctx) {
  const params = { track_name: track, artist_name: artist };
  if (album) params.album_name = album;
  if (dur > 0) params.duration = dur;
  try {
    const r = await lrclib.get('/get', { params });
    if (r.status === 200) return String(r.data.syncedLyrics || '').trim();
    if (r.status !== 404) ctx.erro = true;
  } catch (e) {
    ctx.erro = true;
  }
  return '';
}

// Escolhe o melhor resultado da busca com a mesma validação do firmware antigo.
function melhorDaBusca(lista, track, artist, dur) {
  const t = norm(track);
  const a = norm(artist);
  let melhor = '';
  let melhorScore = -1;

  for (const it of lista) {
    const sync = String(it.syncedLyrics || '').trim();
    if (!sync) continue;

    const n = norm(it.trackName);
    const ar = norm(it.artistName);
    const d = Number(it.duration) || 0;

    const tEx = n === t;
    const tPar = !!n && !!t && (n.includes(t) || t.includes(n));
    const aEx = ar === a;
    const aPar = !!ar && !!a && (ar.includes(a) || a.includes(ar));
    if (!tEx && !tPar) continue;
    if (!aEx && !aPar) continue;

    let diff = 0;
    if (dur > 0 && d > 0) {
      diff = Math.abs(d - dur);
      if (diff > 10) continue; // single/live claramente diferente
    }

    let score = (tEx ? 100 : 45) + (aEx ? 70 : 30) + 35;
    if (dur > 0 && d > 0) {
      score += diff <= 1.5 ? 55 : diff <= 3 ? 45 : diff <= 5 ? 30 : 18;
    }
    if (score > melhorScore) {
      melhorScore = score;
      melhor = sync;
    }
  }
  return melhorScore >= 205 ? melhor : '';
}

async function lrclibSearch(params, track, artist, dur, ctx) {
  try {
    const r = await lrclib.get('/search', { params });
    if (r.status === 200 && Array.isArray(r.data)) return melhorDaBusca(r.data, track, artist, dur);
    if (r.status !== 404) ctx.erro = true;
  } catch (e) {
    ctx.erro = true;
  }
  return '';
}

// Cascata completa (antes rodava dentro do ESP32).
async function buscarLetra({ track, artist, album, dur, search }) {
  const ctx = { erro: false };
  const limpo = limparTitulo(track);

  const tentativas = [[track, album], [track, '']];
  if (limpo && limpo !== track) tentativas.push([limpo, album], [limpo, '']);
  const vistos = new Set();

  for (const [t, al] of tentativas) {
    const chave = `${t}|${al}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    const lyrics = await lrclibGet(t, artist, al, dur, ctx);
    if (lyrics) return { lyrics, source: 'lrclib-exact' };
  }

  if (search) {
    const termo = limpo || track;
    let lyrics = await lrclibSearch({ track_name: termo, artist_name: artist }, termo, artist, dur, ctx);
    if (lyrics) return { lyrics, source: 'lrclib-search' };
    lyrics = await lrclibSearch({ q: `${artist} ${termo}` }, termo, artist, dur, ctx);
    if (lyrics) return { lyrics, source: 'lrclib-search-broad' };
  }

  return { lyrics: '', erro: ctx.erro };
}

// Evita duas buscas simultâneas idênticas (ex.: ESP32 repete o pedido durante um cold start).
const emAndamento = new Map();

// ---------------------------------------------------------------- Rota
function tokenValido(recebido) {
  const esperado = process.env.LYRICAT_SECRET_TOKEN;
  if (!recebido || !esperado) return false;
  const a = Buffer.from(String(recebido));
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Respostas:
//   200 {syncedLyrics}            achou (cache ou LRCLIB)
//   404 {syncedLyrics:""}         não existe letra sincronizada (definitivo por 7 dias)
//   502 {syncedLyrics:""}         LRCLIB indisponível agora (NÃO vai pro cache; o firmware pode tentar direto)
app.get('/api/lyrics', async (req, res) => {
  if (!tokenValido(req.headers['x-lyricat-auth'])) {
    console.log('🚫 Acesso bloqueado: chave inválida ou ausente.');
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  const track_id = String(req.query.track_id || '').slice(0, 255);
  const track = String(req.query.track || '').trim();
  const artist = String(req.query.artist || '').trim();
  const album = String(req.query.album || '').trim();
  const dur = Math.max(0, parseInt(req.query.duration, 10) || 0);
  const search = req.query.search !== '0';

  if (!track_id || !track || !artist) {
    return res.status(400).json({ error: 'Faltam dados obrigatórios (track_id, track, artist)' });
  }

  // 1) Cache
  try {
    const r = await pool.query(
      'SELECT synced_lyrics, created_at FROM cache_letras WHERE track_id = $1', [track_id]);
    if (r.rows.length) {
      const row = r.rows[0];
      if (row.synced_lyrics) {
        console.log(`📦 Cache Hit: ${track}`);
        return res.json({ syncedLyrics: row.synced_lyrics, source: 'cache' });
      }
      const idade = Date.now() - new Date(row.created_at).getTime();
      if (idade < MISS_TTL_MS) {
        console.log(`📦 Cache Miss (negativo): ${track}`);
        return res.status(404).json({ syncedLyrics: '', source: 'cache-miss' });
      }
    }
  } catch (err) {
    console.error('❌ Erro lendo cache (seguindo sem ele):', err.message);
  }

  // 2) LRCLIB
  console.log(`🌐 Cache Miss: ${track} — ${artist}`);
  const chave = `${track_id}|${search}`;
  let tarefa = emAndamento.get(chave);
  if (!tarefa) {
    tarefa = buscarLetra({ track, artist, album, dur, search })
      .finally(() => emAndamento.delete(chave));
    emAndamento.set(chave, tarefa);
  }
  const r = await tarefa;

  // 3) Salvar só resultados confiáveis
  try {
    if (r.lyrics) {
      await pool.query(
        `INSERT INTO cache_letras (track_id, artist, track, synced_lyrics) VALUES ($1, $2, $3, $4)
         ON CONFLICT (track_id) DO UPDATE SET synced_lyrics = EXCLUDED.synced_lyrics, created_at = NOW()`,
        [track_id, artist, track, r.lyrics]);
    } else if (!r.erro && search) {
      await pool.query(
        `INSERT INTO cache_letras (track_id, artist, track, synced_lyrics) VALUES ($1, $2, $3, '')
         ON CONFLICT (track_id) DO UPDATE SET created_at = NOW() WHERE cache_letras.synced_lyrics = ''`,
        [track_id, artist, track]);
    }
  } catch (err) {
    console.error('❌ Erro salvando no cache:', err.message);
  }

  if (r.lyrics) return res.json({ syncedLyrics: r.lyrics, source: r.source });
  if (r.erro) {
    console.log(`⚠️ LRCLIB indisponível para: ${track}`);
    return res.status(502).json({ syncedLyrics: '' });
  }
  console.log(`⚠️ Sem letra sincronizada: ${track}`);
  return res.status(404).json({ syncedLyrics: '', source: 'lrclib' });
});

// Para monitor de uptime (evita o Render Free dormir) e checagem rápida.
app.get('/health', (req, res) => res.send('ok'));

if (require.main === module) {
  iniciarBanco();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('🚀 Servidor protegido rodando na porta ' + PORT));
}

module.exports = { norm, limparTitulo, melhorDaBusca, buscarLetra };
