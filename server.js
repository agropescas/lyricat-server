const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Remove variáveis que o Render pode injetar e que sobrescreveriam a config abaixo.
['DATABASE_URL', 'PGCONNECT_TIMEOUT', 'PGPASSWORD', 'PGDATABASE', 'PGUSER', 'PGHOST']
  .forEach((k) => delete process.env[k]);

// O LRCLIB pode passar a ter a música depois (serviço de busca em segundo plano),
// então "não achei" expira em 3 dias e a música é tentada de novo.
const MISS_TTL_S = 3 * 24 * 60 * 60;
// O LRCLIB exige identificar o cliente: nome, versão e link do projeto.
const USER_AGENT = 'LyricAT-Proxy v1.2 (https://github.com/agropescas/lyricat-server)';

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

// ---------------------------------------------------------------- Texto / chaves
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

// Chave independente do ID do Spotify: primeiro artista + título limpo.
// (O firmware manda só o primeiro artista; listas vindas de CSV separam por ";".)
function montarChave(artist, track) {
  const primeiro = String(artist || '').split(';')[0];
  return norm(primeiro) + '|' + norm(limparTitulo(track));
}

function isrcValido(s) {
  const v = String(s || '').trim().toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(v) ? v : '';
}

// ---------------------------------------------------------------- Banco
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
    // V1.2: colunas novas (seguro rodar várias vezes; linhas antigas continuam valendo).
    await pool.query(`
      ALTER TABLE cache_letras ADD COLUMN IF NOT EXISTS isrc VARCHAR(20);
      ALTER TABLE cache_letras ADD COLUMN IF NOT EXISTS chave TEXT;
      ALTER TABLE cache_letras ADD COLUMN IF NOT EXISTS duration INTEGER DEFAULT 0;
      ALTER TABLE cache_letras ADD COLUMN IF NOT EXISTS source VARCHAR(40);
      CREATE INDEX IF NOT EXISTS idx_cache_letras_isrc ON cache_letras (isrc);
      CREATE INDEX IF NOT EXISTS idx_cache_letras_chave ON cache_letras (chave);
    `);
    // Preenche a chave das linhas antigas (feitas na V1.1).
    for (;;) {
      const r = await pool.query(
        'SELECT id, artist, track FROM cache_letras WHERE chave IS NULL ORDER BY id LIMIT 500');
      if (!r.rows.length) break;
      for (const row of r.rows) {
        await pool.query('UPDATE cache_letras SET chave = $1 WHERE id = $2',
          [montarChave(row.artist, row.track), row.id]);
      }
    }
    console.log('✅ Banco de dados e tabela verificados com sucesso!');
  } catch (err) {
    console.error('❌ Erro fatal ao iniciar tabela no banco:', err.message);
  }
}

// Procura por: ID do Spotify, ISRC, ou artista+título (com duração parecida).
// Letras achadas vêm antes de registros "não achei".
const SQL_BUSCA = `
  SELECT synced_lyrics, EXTRACT(EPOCH FROM (NOW() - created_at))::float AS idade_s
  FROM cache_letras
  WHERE track_id = $1
     OR ($2::text <> '' AND isrc = $2::text)
     OR (chave = $3::text AND ($4::int = 0 OR duration IS NULL OR duration = 0
                               OR ABS(duration - $4::int) <= 3))
  ORDER BY (synced_lyrics <> '') DESC, (track_id = $1) DESC, created_at DESC
  LIMIT 1`;

const SQL_SALVAR = `
  INSERT INTO cache_letras (track_id, artist, track, synced_lyrics, isrc, chave, duration, source)
  VALUES ($1, $2, $3, $4, NULLIF($5::text, ''), $6, $7, $8)
  ON CONFLICT (track_id) DO UPDATE SET
    synced_lyrics = EXCLUDED.synced_lyrics,
    isrc = COALESCE(EXCLUDED.isrc, cache_letras.isrc),
    chave = EXCLUDED.chave,
    duration = EXCLUDED.duration,
    source = EXCLUDED.source,
    created_at = NOW()`;

const SQL_SALVAR_MISS = `
  INSERT INTO cache_letras (track_id, artist, track, synced_lyrics, isrc, chave, duration, source)
  VALUES ($1, $2, $3, '', NULLIF($4::text, ''), $5, $6, 'miss')
  ON CONFLICT (track_id) DO UPDATE SET created_at = NOW()
  WHERE cache_letras.synced_lyrics = ''`;

// ---------------------------------------------------------------- LRCLIB
const lrclib = axios.create({
  baseURL: 'https://lrclib.net/api',
  timeout: 5000,
  headers: { 'User-Agent': USER_AGENT },
  validateStatus: () => true // 404 é resposta normal ("não existe"), não exceção
});

// ---- Limitador de ritmo -------------------------------------------------
// TODAS as chamadas ao LRCLIB passam por aqui: uma por vez, com intervalo mínimo
// entre elas. Se o LRCLIB responder 429, todas as buscas pausam (sem chamar nada)
// pelo tempo do Retry-After (mínimo 30 s) e respondem "indisponível" sem cachear.
const INTERVALO_MIN_MS = 1200; // o LRCLIB pede 200-500 ms; usamos mais folga
let filaLrclib = Promise.resolve();
let ultimaChamada = 0;
let pausadoAte = 0;

function lrclibRequest(path, params) {
  const rodar = async () => {
    if (Date.now() < pausadoAte) return { status: 429, pausado: true };
    const espera = ultimaChamada + INTERVALO_MIN_MS - Date.now();
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    ultimaChamada = Date.now();
    const r = await lrclib.get(path, { params });
    if (r.status === 429) {
      const ra = parseInt(r.headers && r.headers['retry-after'], 10);
      pausadoAte = Date.now() + Math.max(30, ra || 0) * 1000; // obedece o Retry-After (mín. 30 s)
      console.log(`⛔ LRCLIB respondeu 429. Pausando buscas por ${Math.round((pausadoAte - Date.now()) / 1000)}s.`);
    }
    return r;
  };
  const p = filaLrclib.then(rodar, rodar);
  filaLrclib = p.catch(() => {}); // a fila nunca quebra por causa de uma falha
  return p;
}

// Só letras com timestamp real. `ctx.erro` marca falha transitória (timeout, 5xx, 429),
// para não confundir "LRCLIB caiu" com "a música não existe".
async function lrclibGet(track, artist, album, dur, ctx) {
  const params = { track_name: track, artist_name: artist };
  if (album) params.album_name = album;
  if (dur > 0) params.duration = dur;
  try {
    const r = await lrclibRequest('/get', params);
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
    const r = await lrclibRequest('/search', params);
    if (r.status === 200 && Array.isArray(r.data)) return melhorDaBusca(r.data, track, artist, dur);
    if (r.status !== 404) ctx.erro = true;
  } catch (e) {
    ctx.erro = true;
  }
  return '';
}

// Cascata ENXUTA: no máximo 3 chamadas ao LRCLIB por música nova
// (a versão antiga fazia até 8 e foi o que causou o ban).
async function buscarLetra({ track, artist, album, dur, search }) {
  const ctx = { erro: false };
  const limpo = limparTitulo(track) || track;

  // 1) match exato com álbum (ou sem, se o Spotify não mandou álbum)
  let lyrics = await lrclibGet(track, artist, album, dur, ctx);
  if (lyrics) return { lyrics, source: 'lrclib-exact' };
  if (ctx.erro) return { lyrics: '', erro: true }; // LRCLIB com problema: para aqui, não insiste

  // 2) título limpo, sem álbum (só se for diferente do que já tentamos)
  if (album || limpo !== track) {
    lyrics = await lrclibGet(limpo, artist, '', dur, ctx);
    if (lyrics) return { lyrics, source: 'lrclib-clean' };
    if (ctx.erro) return { lyrics: '', erro: true };
  }

  // 3) uma única busca ampla, validada localmente por título + artista + duração
  if (search) {
    lyrics = await lrclibSearch({ q: `${artist} ${limpo}` }, limpo, artist, dur, ctx);
    if (lyrics) return { lyrics, source: 'lrclib-search' };
  }

  return { lyrics: '', erro: ctx.erro };
}

// Evita duas buscas simultâneas idênticas (ex.: ESP32 repete o pedido durante um cold start).
const emAndamento = new Map();

// ---------------------------------------------------------------- Núcleo: cache + LRCLIB
// Devolve { estado: 'achou' | 'nao_existe' | 'erro', lyrics, source }.
// Usado pela rota do aparelho e pelo pré-carregamento.
async function obterLetra(q) {
  const { track_id, track, artist, album, dur, search } = q;
  const isrc = isrcValido(q.isrc);
  const chave = montarChave(artist, track);

  // 1) Cache
  try {
    const r = await pool.query(SQL_BUSCA, [track_id, isrc, chave, dur]);
    if (r.rows.length) {
      const row = r.rows[0];
      if (row.synced_lyrics) return { estado: 'achou', lyrics: row.synced_lyrics, source: 'cache' };
      if (row.idade_s < MISS_TTL_S) return { estado: 'nao_existe', lyrics: '', source: 'cache-miss' };
    }
  } catch (err) {
    console.error('❌ Erro lendo cache (seguindo sem ele):', err.message);
  }

  // 2) LRCLIB
  console.log(`🌐 Cache Miss: ${track} — ${artist}`);
  const chaveTarefa = `${chave}|${dur}|${search}`;
  let tarefa = emAndamento.get(chaveTarefa);
  if (!tarefa) {
    tarefa = buscarLetra({ track, artist, album, dur, search })
      .finally(() => emAndamento.delete(chaveTarefa));
    emAndamento.set(chaveTarefa, tarefa);
  }
  const r = await tarefa;

  // 3) Salvar só resultados confiáveis
  try {
    if (r.lyrics) {
      await pool.query(SQL_SALVAR, [track_id, artist, track, r.lyrics, isrc, chave, dur, r.source]);
    } else if (!r.erro && search) {
      await pool.query(SQL_SALVAR_MISS, [track_id, artist, track, isrc, chave, dur]);
    }
  } catch (err) {
    console.error('❌ Erro salvando no cache:', err.message);
  }

  if (r.lyrics) return { estado: 'achou', lyrics: r.lyrics, source: r.source };
  if (r.erro) return { estado: 'erro', lyrics: '', source: 'lrclib-erro' };
  return { estado: 'nao_existe', lyrics: '', source: 'lrclib' };
}

// ---------------------------------------------------------------- Autenticação
function tokenValido(recebido) {
  const esperado = process.env.LYRICAT_SECRET_TOKEN;
  if (!recebido || !esperado) return false;
  const a = Buffer.from(String(recebido));
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function exigirToken(req, res, next) {
  if (!tokenValido(req.headers['x-lyricat-auth'])) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }
  next();
}

// ---------------------------------------------------------------- Rota do aparelho
// Respostas:
//   200 {syncedLyrics}            achou (cache ou LRCLIB)
//   404 {syncedLyrics:""}         não existe letra sincronizada (cache negativo por 3 dias)
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

  const r = await obterLetra({ track_id, track, artist, album, dur, isrc: req.query.isrc, search });
  if (r.estado === 'achou') return res.json({ syncedLyrics: r.lyrics, source: r.source });
  if (r.estado === 'erro') {
    console.log(`⚠️ LRCLIB indisponível para: ${track}`);
    return res.status(502).json({ syncedLyrics: '' });
  }
  console.log(`⚠️ Sem letra sincronizada: ${track}`);
  return res.status(404).json({ syncedLyrics: '', source: r.source });
});

// ---------------------------------------------------------------- Pré-carregamento
// Recebe listas de músicas e vai enchendo o banco no ritmo seguro do LRCLIB.
// O estado fica em memória: se o Render reiniciar, é só enviar a lista de novo
// (o que já foi salvo é pulado, sem chamar o LRCLIB).
const FILA_MAX = 5000;
const prefill = {
  fila: [], rodando: false, total: 0, feitos: 0,
  achou: 0, jaTinha: 0, semLetra: 0, erro: 0, falhas: [], iniciouEm: null
};

function resetarPrefillSeOcioso() {
  if (prefill.rodando || prefill.fila.length) return;
  Object.assign(prefill, { total: 0, feitos: 0, achou: 0, jaTinha: 0, semLetra: 0, erro: 0, falhas: [], iniciouEm: null });
}

function normalizarItem(raw) {
  const track = String((raw && raw.track) || '').trim().slice(0, 300);
  const artist = String((raw && raw.artist) || '').trim().slice(0, 300);
  if (!track || !artist) return null;
  const dur = Math.max(0, Math.round(Number(raw.duration) || 0));
  const isrc = isrcValido(raw.isrc);
  const album = String(raw.album || '').trim().slice(0, 300);
  let track_id = String(raw.track_id || '').trim();
  if (!/^[A-Za-z0-9]{22}$/.test(track_id)) {
    // Sem ID do Spotify: ID sintético estável. O aparelho acha esta linha depois
    // pelo ISRC ou por artista+título+duração.
    track_id = 'n:' + crypto.createHash('sha1')
      .update(montarChave(artist, track) + '|' + dur).digest('hex').slice(0, 24);
  }
  return { track_id, track, artist, album, dur, isrc, search: true };
}

async function processarFila() {
  if (prefill.rodando) return;
  prefill.rodando = true;
  try {
    while (prefill.fila.length) {
      const item = prefill.fila.shift();
      // Se o LRCLIB mandou pausar (429), espera em vez de gastar a lista à toa.
      const espera = pausadoAte - Date.now();
      if (espera > 0) await new Promise((r) => setTimeout(r, espera + 1000));
      try {
        const r = await obterLetra(item);
        if (r.estado === 'achou') {
          if (r.source === 'cache') prefill.jaTinha++; else prefill.achou++;
        } else if (r.estado === 'nao_existe') {
          prefill.semLetra++;
        } else {
          prefill.erro++;
          if (prefill.falhas.length < 100) prefill.falhas.push(`${item.artist} - ${item.track}`);
        }
      } catch (e) {
        prefill.erro++;
        if (prefill.falhas.length < 100) prefill.falhas.push(`${item.artist} - ${item.track}`);
      }
      prefill.feitos++;
    }
  } finally {
    prefill.rodando = false;
  }
}

app.post('/api/prefill', exigirToken, (req, res) => {
  const itens = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!itens.length) return res.status(400).json({ error: 'Envie {items:[{artist, track, ...}]}' });
  if (itens.length > 500) return res.status(400).json({ error: 'No máximo 500 itens por envio.' });

  resetarPrefillSeOcioso();
  let aceitos = 0;
  let invalidos = 0;
  for (const raw of itens) {
    const it = normalizarItem(raw);
    if (!it) { invalidos++; continue; }
    if (prefill.fila.length >= FILA_MAX) break;
    prefill.fila.push(it);
    aceitos++;
  }
  prefill.total += aceitos;
  if (!prefill.iniciouEm) prefill.iniciouEm = new Date().toISOString();
  processarFila();
  res.status(202).json({ aceitos, invalidos, naFila: prefill.fila.length });
});

app.get('/api/prefill/status', exigirToken, (req, res) => {
  res.json({
    rodando: prefill.rodando,
    total: prefill.total,
    feitos: prefill.feitos,
    naFila: prefill.fila.length,
    novasLetras: prefill.achou,
    jaTinha: prefill.jaTinha,
    semLetra: prefill.semLetra,
    erros: prefill.erro,
    falhas: prefill.falhas,
    lrclibPausadoPorSegundos: Math.max(0, Math.round((pausadoAte - Date.now()) / 1000)),
    iniciouEm: prefill.iniciouEm
  });
});

app.post('/api/prefill/cancel', exigirToken, (req, res) => {
  const removidos = prefill.fila.length;
  prefill.fila = [];
  res.json({ cancelados: removidos });
});

// ---------------------------------------------------------------- Estatísticas e backup
app.get('/api/stats', exigirToken, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE synced_lyrics <> '')::int AS com_letra,
             count(*) FILTER (WHERE synced_lyrics = '')::int AS sem_letra,
             pg_size_pretty(pg_total_relation_size('cache_letras')) AS tamanho,
             pg_total_relation_size('cache_letras')::float AS bytes,
             max(created_at) AS ultima
      FROM cache_letras`);
    const s = r.rows[0];
    res.json({
      versao: '1.2',
      musicas: s.total,
      comLetra: s.com_letra,
      semLetra: s.sem_letra,
      tamanho: s.tamanho,
      percentualDe500MB: Math.round((s.bytes / (500 * 1024 * 1024)) * 1000) / 10,
      ultimaGravacao: s.ultima,
      lrclibPausadoPorSegundos: Math.max(0, Math.round((pausadoAte - Date.now()) / 1000)),
      servidorLigadoHaSegundos: Math.round(process.uptime())
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function csvCelula(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

// Backup em CSV (só músicas com letra). Vai lendo em blocos para não estourar a memória.
// As colunas têm os mesmos nomes da tabela: dá para reimportar no Table Editor do Supabase.
app.get('/api/export.csv', exigirToken, async (req, res) => {
  const colunas = ['track_id', 'artist', 'track', 'synced_lyrics', 'isrc', 'duration', 'source', 'created_at'];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lyricat-letras.csv"');
  res.write('﻿' + colunas.join(',') + '\n');
  try {
    let ultimoId = 0;
    for (;;) {
      const r = await pool.query(
        `SELECT id, ${colunas.join(', ')} FROM cache_letras
         WHERE id > $1 AND synced_lyrics <> '' ORDER BY id LIMIT 500`, [ultimoId]);
      if (!r.rows.length) break;
      for (const row of r.rows) {
        res.write(colunas.map((c) => csvCelula(row[c] instanceof Date ? row[c].toISOString() : row[c])).join(',') + '\n');
        ultimoId = row.id;
      }
    }
    res.end();
  } catch (err) {
    console.error('❌ Erro no export:', err.message);
    res.end('\n# ERRO: ' + err.message + '\n');
  }
});

// ---------------------------------------------------------------- Painel /admin
const ADMIN_HTML = String.raw`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LyricAT Server</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--mut:#666;--bd:#ccc;--card:#f5f5f5}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--mut:#999;--bd:#3a3a3a;--card:#1e1e1e}}
*{box-sizing:border-box}
body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;background:var(--bg);color:var(--fg);max-width:720px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:0 0 8px}
.sub{color:var(--mut);margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px;margin-bottom:14px}
input,textarea,button{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:8px 10px}
input[type=password]{width:100%}
textarea{width:100%;min-height:130px;font-family:ui-monospace,monospace;font-size:13px}
button{cursor:pointer}button:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px}.kv b{font-weight:600}
.mut{color:var(--mut);font-size:13px}
#msg{margin-top:8px;font-size:14px;white-space:pre-wrap}
</style>
</head>
<body>
<h1>LyricAT Server</h1>
<div class="sub">Painel do banco de letras</div>

<div class="card">
  <h2>Token</h2>
  <input id="tok" type="password" placeholder="Cole o LYRICAT_SECRET_TOKEN" autocomplete="off">
  <div class="mut">Fica só nesta aba do navegador.</div>
</div>

<div class="card">
  <h2>Estatísticas</h2>
  <div class="kv" id="stats"><span class="mut">Toque em Atualizar.</span></div>
  <div class="row"><button id="bStats">Atualizar</button></div>
</div>

<div class="card">
  <h2>Pré-carregar letras</h2>
  <div class="mut">Cole uma lista, uma música por linha, no formato <b>Artista - Música</b>,
  ou o conteúdo de um CSV exportado do Exportify (exportify.net). Também dá para escolher o arquivo CSV.</div>
  <textarea id="lista" placeholder="Queen - Bohemian Rhapsody&#10;Daft Punk - Get Lucky"></textarea>
  <div class="row">
    <input id="arq" type="file" accept=".csv,.txt">
    <button id="bEnviar">Enviar para o servidor</button>
    <button id="bCancelar">Cancelar fila</button>
  </div>
  <div class="mut">O servidor faz 1 consulta ao LRCLIB a cada ~1,2 s. Uma lista de 100 músicas leva uns 3 a 6 minutos. Pode fechar a página.</div>
  <div class="kv" id="pf" style="margin-top:10px"></div>
  <div id="msg"></div>
</div>

<div class="card">
  <h2>Backup</h2>
  <div class="mut">Baixa todas as músicas com letra em um CSV.</div>
  <div class="row"><button id="bBackup">Baixar CSV</button></div>
</div>

<script>
var $ = function (id) { return document.getElementById(id); };

function tok() { return $('tok').value.trim(); }
try { $('tok').value = sessionStorage.getItem('lyricatTok') || ''; } catch (e) {}
$('tok').addEventListener('input', function () {
  try { sessionStorage.setItem('lyricatTok', tok()); } catch (e) {}
});

function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'x-lyricat-auth': tok() }, opts.headers || {});
  return fetch(path, opts);
}
function say(t) { $('msg').textContent = t; }

function kv(el, pares) {
  el.textContent = '';
  pares.forEach(function (p) {
    var a = document.createElement('b'); a.textContent = p[0];
    var b = document.createElement('span'); b.textContent = p[1];
    el.appendChild(a); el.appendChild(b);
  });
}

function carregarStats() {
  api('/api/stats').then(function (r) {
    if (r.status === 401) throw new Error('Token incorreto.');
    return r.json();
  }).then(function (s) {
    if (s.error) throw new Error(s.error);
    kv($('stats'), [
      ['Músicas salvas', s.musicas + ' (' + s.comLetra + ' com letra, ' + s.semLetra + ' sem letra)'],
      ['Espaço usado', s.tamanho + ' (' + s.percentualDe500MB + '% dos 500 MB do plano Free)'],
      ['Última gravação', s.ultimaGravacao || '-'],
      ['LRCLIB', s.lrclibPausadoPorSegundos > 0 ? 'pausado por ' + s.lrclibPausadoPorSegundos + ' s' : 'ok'],
      ['Servidor ligado há', Math.round(s.servidorLigadoHaSegundos / 60) + ' min']
    ]);
  }).catch(function (e) { say('Erro: ' + e.message); });
}

function statusPrefill() {
  return api('/api/prefill/status').then(function (r) { return r.ok ? r.json() : null; })
  .then(function (s) {
    if (!s) return null;
    var pares = [
      ['Andamento', s.feitos + ' de ' + s.total + (s.rodando ? ' (rodando)' : '')],
      ['Novas letras', String(s.novasLetras)],
      ['Já estavam salvas', String(s.jaTinha)],
      ['Sem letra sincronizada', String(s.semLetra)],
      ['Erros temporários', String(s.erros)]
    ];
    if (s.lrclibPausadoPorSegundos > 0) pares.push(['LRCLIB', 'pausado por ' + s.lrclibPausadoPorSegundos + ' s']);
    kv($('pf'), pares);
    if (s.falhas && s.falhas.length) say('Falharam agora (envie de novo depois):\n' + s.falhas.slice(0, 15).join('\n'));
    return s;
  }).catch(function () { return null; });
}

var timer = null;
function acompanhar() {
  if (timer) clearInterval(timer);
  timer = setInterval(function () {
    statusPrefill().then(function (s) { if (s && !s.rodando && !s.naFila) { clearInterval(timer); timer = null; carregarStats(); } });
  }, 3000);
}

function parseCSV(texto) {
  var linhas = [], atual = [], campo = '', aspas = false, i, c;
  for (i = 0; i < texto.length; i++) {
    c = texto[i];
    if (aspas) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false; }
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ',') { atual.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      atual.push(campo); campo = '';
      if (atual.length > 1 || atual[0] !== '') linhas.push(atual);
      atual = [];
    } else campo += c;
  }
  if (campo !== '' || atual.length) { atual.push(campo); linhas.push(atual); }
  return linhas;
}

function interpretar(texto) {
  texto = texto.replace(/^﻿/, '');
  var primeira = (texto.split(/\r?\n/)[0] || '').toLowerCase();
  var itens = [];
  if (primeira.indexOf('track name') >= 0 || primeira.indexOf('track uri') >= 0) {
    var linhas = parseCSV(texto);
    var cab = linhas.shift().map(function (h) { return h.trim().toLowerCase(); });
    var col = function (nome) { return cab.indexOf(nome); };
    var iUri = col('track uri'), iNome = col('track name'), iAlb = col('album name'),
        iArt = col('artist name(s)'), iDur = col('duration (ms)'), iIsrc = col('isrc');
    linhas.forEach(function (l) {
      var uri = iUri >= 0 ? l[iUri] || '' : '';
      itens.push({
        track_id: uri.indexOf('spotify:track:') === 0 ? uri.slice(14) : '',
        track: iNome >= 0 ? l[iNome] : '',
        album: iAlb >= 0 ? l[iAlb] : '',
        artist: iArt >= 0 ? l[iArt] : '',
        duration: iDur >= 0 ? Math.round((parseInt(l[iDur], 10) || 0) / 1000) : 0,
        isrc: iIsrc >= 0 ? l[iIsrc] : ''
      });
    });
  } else {
    texto.split(/\r?\n/).forEach(function (l) {
      var k = l.indexOf(' - ');
      if (k > 0) itens.push({ artist: l.slice(0, k).trim(), track: l.slice(k + 3).trim() });
    });
  }
  return itens.filter(function (x) { return x.artist && x.track; });
}

function enviarLotes(itens, i) {
  if (i >= itens.length) { say('Enviado. O servidor está processando (' + itens.length + ' músicas).'); acompanhar(); return; }
  var lote = itens.slice(i, i + 200);
  api('/api/prefill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: lote }) })
    .then(function (r) {
      if (r.status === 401) throw new Error('Token incorreto.');
      if (!r.ok) throw new Error('Servidor respondeu ' + r.status);
      return r.json();
    })
    .then(function () { say('Enviando... ' + Math.min(i + 200, itens.length) + ' de ' + itens.length); enviarLotes(itens, i + 200); })
    .catch(function (e) { say('Erro: ' + e.message); });
}

$('bStats').onclick = carregarStats;
$('bEnviar').onclick = function () {
  var itens = interpretar($('lista').value);
  if (!itens.length) { say('Nada reconhecido. Use "Artista - Música", uma por linha, ou um CSV do Exportify.'); return; }
  say('Reconhecidas ' + itens.length + ' músicas.');
  enviarLotes(itens, 0);
};
$('bCancelar').onclick = function () {
  api('/api/prefill/cancel', { method: 'POST' }).then(function (r) { return r.json(); })
    .then(function (j) { say('Removidas da fila: ' + (j.cancelados || 0)); statusPrefill(); });
};
$('arq').onchange = function () {
  var f = this.files[0]; if (!f) return;
  var rd = new FileReader();
  rd.onload = function () { $('lista').value = rd.result; };
  rd.readAsText(f);
};
$('bBackup').onclick = function () {
  api('/api/export.csv').then(function (r) {
    if (r.status === 401) throw new Error('Token incorreto.');
    return r.blob();
  }).then(function (b) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = 'lyricat-letras.csv';
    document.body.appendChild(a); a.click(); a.remove();
  }).catch(function (e) { say('Erro: ' + e.message); });
};
if (tok()) { carregarStats(); statusPrefill(); }
</script>
</body>
</html>`;

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(ADMIN_HTML);
});

// Para monitor de uptime (evita o Render Free dormir) e checagem rápida.
app.get('/health', (req, res) => res.send('ok'));

if (require.main === module) {
  iniciarBanco();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('🚀 Servidor protegido rodando na porta ' + PORT));
}

module.exports = { norm, limparTitulo, montarChave, melhorDaBusca, buscarLetra, obterLetra, normalizarItem, ADMIN_HTML };
