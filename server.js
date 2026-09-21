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
const USER_AGENT = 'LyricAT-Proxy v1.4 (https://github.com/agropescas/lyricat-server)';

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
    // v1.5: clima da música (classificado por IA em segundo plano). NULL = ainda não classificada.
    await pool.query(`
      ALTER TABLE cache_letras ADD COLUMN IF NOT EXISTS clima SMALLINT;
      ALTER TABLE cache_letras ADD COLUMN IF NOT EXISTS clima_em TIMESTAMP;
      ALTER TABLE cache_letras ADD COLUMN IF NOT EXISTS clima_tent SMALLINT DEFAULT 0;
      ALTER TABLE cache_letras ADD COLUMN IF NOT EXISTS bpm SMALLINT;   -- 1.6: andamento da música (0 = a IA não soube); NULL = ainda não perguntado
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
    // v1.3b: o banco guarda só letras. Apaga as linhas vazias (cache negativo) de versões anteriores.
    const lim = await pool.query("DELETE FROM cache_letras WHERE synced_lyrics IS NULL OR synced_lyrics = ''");
    if (lim.rowCount) console.log('🧹 Removidas ' + lim.rowCount + ' linhas sem letra do banco.');
    console.log('✅ Banco de dados e tabela verificados com sucesso!');
  } catch (err) {
    console.error('❌ Erro fatal ao iniciar tabela no banco:', err.message);
  }
}

// Procura por: ID do Spotify, ISRC, ou artista+título (com duração parecida).
// Letras achadas vêm antes de registros "não achei".
const SQL_BUSCA = `
  SELECT synced_lyrics, clima, bpm, EXTRACT(EPOCH FROM (NOW() - created_at))::float AS idade_s
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
// "Sem letra" na memória (v1.3b). Chave = artista+título normalizados; vale por 6 h.
const MISS_MEM_MS = 6 * 60 * 60 * 1000;
const missMem = new Map();
function lembrarMiss(chave) {
  if (!chave) return;
  missMem.set(chave, Date.now() + MISS_MEM_MS);
  if (missMem.size > 5000) missMem.delete(missMem.keys().next().value);
}
function missRecente(chave) {
  const ate = missMem.get(chave);
  if (!ate) return false;
  if (Date.now() > ate) { missMem.delete(chave); return false; }
  return true;
}

async function obterLetra(q) {
  const { track_id, track, artist, album, dur, search } = q;
  const isrc = isrcValido(q.isrc);
  const chave = montarChave(artist, track);

  // 1) Cache
  try {
    const r = await pool.query(SQL_BUSCA, [track_id, isrc, chave, dur]);
    if (r.rows.length) {
      const row = r.rows[0];
      if (row.synced_lyrics) return { estado: 'achou', lyrics: row.synced_lyrics, source: 'cache', clima: row.clima, bpm: row.bpm };
      // v1.3b: linhas vazias antigas são ignoradas (e apagadas na inicialização). O banco só guarda letras.
    }
  } catch (err) {
    console.error('❌ Erro lendo cache (seguindo sem ele):', err.message);
  }

  // 1b) "Sem letra" lembrado só na memória do servidor (protege o LRCLIB de pedidos repetidos
  //     sem gravar linhas vazias no Supabase). Zera quando o Render reinicia.
  if (search && missRecente(chave)) return { estado: 'nao_existe', lyrics: '', source: 'miss-memoria' };

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
      lembrarMiss(chave); // v1.3b: NÃO grava linha vazia no Supabase
    }
  } catch (err) {
    console.error('❌ Erro salvando no cache:', err.message);
  }

  if (r.lyrics) return { estado: 'achou', lyrics: r.lyrics, source: r.source };
  if (r.erro) return { estado: 'erro', lyrics: '', source: 'lrclib-erro' };
  return { estado: 'nao_existe', lyrics: '', source: 'lrclib' };
}


// ---------------------------------------------------------------- Escritas para a tela (v1.3)
// O display só tem fontes bitmap. Antes de mandar a letra ao aparelho:
//  1) pontuação tipográfica/CJK que as fontes não têm vira ASCII (’ “ ” – … 、。「」 fullwidth...);
//  2) árabe é "ligado" (formas isolada/inicial/medial/final) e, junto com hebraico, reordenado
//     para a ordem visual (a fonte desenha da esquerda para a direita).
// O banco guarda a letra ORIGINAL; isto roda só na resposta. Use &raw=1 para ver o original.
// Tabela de formas: Unicode (blocos Arabic Presentation Forms), só glifos que a fonte do aparelho tem.
// [isolada, final, inicial, medial]
const AR_FORMS = {
  0x621: [0xFE80,0,0,0],
  0x622: [0xFE81,0xFE82,0,0],
  0x623: [0xFE83,0xFE84,0,0],
  0x624: [0xFE85,0xFE86,0,0],
  0x625: [0xFE87,0xFE88,0,0],
  0x626: [0xFE89,0xFE8A,0xFE8B,0xFE8C],
  0x627: [0xFE8D,0xFE8E,0,0],
  0x628: [0xFE8F,0xFE90,0xFE91,0xFE92],
  0x629: [0xFE93,0xFE94,0,0],
  0x62A: [0xFE95,0xFE96,0xFE97,0xFE98],
  0x62B: [0xFE99,0xFE9A,0xFE9B,0xFE9C],
  0x62C: [0xFE9D,0xFE9E,0xFE9F,0xFEA0],
  0x62D: [0xFEA1,0xFEA2,0xFEA3,0xFEA4],
  0x62E: [0xFEA5,0xFEA6,0xFEA7,0xFEA8],
  0x62F: [0xFEA9,0xFEAA,0,0],
  0x630: [0xFEAB,0xFEAC,0,0],
  0x631: [0xFEAD,0xFEAE,0,0],
  0x632: [0xFEAF,0xFEB0,0,0],
  0x633: [0xFEB1,0xFEB2,0xFEB3,0xFEB4],
  0x634: [0xFEB5,0xFEB6,0xFEB7,0xFEB8],
  0x635: [0xFEB9,0xFEBA,0xFEBB,0xFEBC],
  0x636: [0xFEBD,0xFEBE,0xFEBF,0xFEC0],
  0x637: [0xFEC1,0xFEC2,0xFEC3,0xFEC4],
  0x638: [0xFEC5,0xFEC6,0xFEC7,0xFEC8],
  0x639: [0xFEC9,0xFECA,0xFECB,0xFECC],
  0x63A: [0xFECD,0xFECE,0xFECF,0xFED0],
  0x641: [0xFED1,0xFED2,0xFED3,0xFED4],
  0x642: [0xFED5,0xFED6,0xFED7,0xFED8],
  0x643: [0xFED9,0xFEDA,0xFEDB,0xFEDC],
  0x644: [0xFEDD,0xFEDE,0xFEDF,0xFEE0],
  0x645: [0xFEE1,0xFEE2,0xFEE3,0xFEE4],
  0x646: [0xFEE5,0xFEE6,0xFEE7,0xFEE8],
  0x647: [0xFEE9,0xFEEA,0xFEEB,0xFEEC],
  0x648: [0xFEED,0xFEEE,0,0],
  0x649: [0xFEEF,0xFEF0,0,0],
  0x64A: [0xFEF1,0xFEF2,0xFEF3,0xFEF4],
  0x671: [0xFB50,0xFB51,0,0],
  0x679: [0xFB66,0xFB67,0xFB68,0xFB69],
  0x67A: [0xFB5E,0xFB5F,0xFB60,0xFB61],
  0x67B: [0xFB52,0xFB53,0xFB54,0xFB55],
  0x67E: [0xFB56,0xFB57,0xFB58,0xFB59],
  0x67F: [0xFB62,0xFB63,0xFB64,0xFB65],
  0x680: [0xFB5A,0xFB5B,0xFB5C,0xFB5D],
  0x683: [0xFB76,0xFB77,0xFB78,0xFB79],
  0x684: [0xFB72,0xFB73,0xFB74,0xFB75],
  0x686: [0xFB7A,0xFB7B,0xFB7C,0xFB7D],
  0x687: [0xFB7E,0xFB7F,0xFB80,0xFB81],
  0x688: [0xFB88,0xFB89,0,0],
  0x68C: [0xFB84,0xFB85,0,0],
  0x68D: [0xFB82,0xFB83,0,0],
  0x68E: [0xFB86,0xFB87,0,0],
  0x691: [0xFB8C,0xFB8D,0,0],
  0x698: [0xFB8A,0xFB8B,0,0],
  0x6A4: [0xFB6A,0xFB6B,0xFB6C,0xFB6D],
  0x6A6: [0xFB6E,0xFB6F,0xFB70,0xFB71],
  0x6A9: [0xFB8E,0xFB8F,0xFB90,0xFB91],
  0x6AF: [0xFB92,0xFB93,0xFB94,0xFB95],
  0x6B1: [0xFB9A,0xFB9B,0xFB9C,0xFB9D],
  0x6B3: [0xFB96,0xFB97,0xFB98,0xFB99],
  0x6BA: [0xFB9E,0xFB9F,0,0],
  0x6BB: [0xFBA0,0xFBA1,0xFBA2,0xFBA3],
  0x6BE: [0xFBAA,0xFBAB,0xFBAC,0xFBAD],
  0x6C0: [0xFBA4,0xFBA5,0,0],
  0x6C1: [0xFBA6,0xFBA7,0xFBA8,0xFBA9],
  0x6D2: [0xFBAE,0xFBAF,0,0],
  0x6D3: [0xFBB0,0xFBB1,0,0]
};
const AR_LIG = { // lam + alef: [isolada, final]
  '0020064b': [0xFE70,0,0,0],
  '0020064c': [0xFE72,0,0,0],
  '0020064d': [0xFE74,0,0,0],
  '0020064e': [0xFE76,0,0,0],
  '0020064f': [0xFE78,0,0,0],
  '00200650': [0xFE7A,0,0,0],
  '00200651': [0xFE7C,0,0,0],
  '00200652': [0xFE7E,0,0,0],
  '0640064b': [0,0,0,0xFE71],
  '0640064e': [0,0,0,0xFE77],
  '0640064f': [0,0,0,0xFE79],
  '06400650': [0,0,0,0xFE7B],
  '06400651': [0,0,0,0xFE7D],
  '06400652': [0,0,0,0xFE7F],
  '06440622': [0xFEF5,0xFEF6,0,0],
  '06440623': [0xFEF7,0xFEF8,0,0],
  '06440625': [0xFEF9,0xFEFA,0,0],
  '06440627': [0xFEFB,0xFEFC,0,0]
};
const AR_ALIAS = { 0x06CC: 0x064A, 0x06D2: 0x064A, 0x0649: 0x0649 }; // ی -> ي (a fonte não tem as formas persas de yeh)

const PONT_MAP = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '–': '-', '—': '-', '―': '-', '‒': '-', '−': '-',
  '…': '...', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '　': ' ',
  '、': ',', '。': '.', '「': '"', '」': '"', '『': '"', '』': '"',
  '【': '[', '】': ']', '〈': '<', '〉': '>', '《': '<', '》': '>',
  '〜': '~', '・': ' ', '•': '-', '●': '-', '○': '-',
  '​': '', '‌': '', '‍': '', '‎': '', '‏': '', '﻿': '',
  '♪': '', '♫': '', '♬': '', '♩': ''
};

function normalizarPontuacao(s) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xFF01 && cp <= 0xFF5E) out += String.fromCharCode(cp - 0xFEE0); // fullwidth -> ASCII
    else if (PONT_MAP[ch] !== undefined) out += PONT_MAP[ch];
    else out += ch;
  }
  return out;
}

const cpRTLArabe = (c) => (c >= 0x0600 && c <= 0x06FF) || (c >= 0x0750 && c <= 0x077F) ||
                          (c >= 0xFB50 && c <= 0xFDFF) || (c >= 0xFE70 && c <= 0xFEFF);
const cpRTLHebraico = (c) => (c >= 0x0590 && c <= 0x05FF) || (c >= 0xFB1D && c <= 0xFB4F);
const cpRTL = (c) => cpRTLArabe(c) || cpRTLHebraico(c);

function formasDe(cp) {
  return AR_FORMS[cp] || (AR_ALIAS[cp] && AR_FORMS[AR_ALIAS[cp]]) || null;
}

// Liga o árabe (ordem lógica -> formas contextuais, ainda em ordem lógica).
function ligarArabe(cps) {
  // remove sinais de vocalização (harakat): a fonte não os desenha bem
  const s = cps.filter((c) => !((c >= 0x064B && c <= 0x065F) || c === 0x0670 || (c >= 0x06D6 && c <= 0x06ED)));
  const out = [];
  let prevJuntaAdiante = false; // a letra anterior liga com a próxima?
  for (let i = 0; i < s.length; i++) {
    const cp = s[i];
    const f = formasDe(cp);
    const eTatweel = cp === 0x0640;
    if (!f && !eTatweel) { out.push(cp); prevJuntaAdiante = false; continue; }
    if (eTatweel) { out.push(cp); prevJuntaAdiante = true; continue; }

    // lam + alef vira ligadura única
    if (cp === 0x0644 && i + 1 < s.length) {
      const key = '0644' + s[i + 1].toString(16).toUpperCase().padStart(4, '0');
      const lg = AR_LIG[key];
      if (lg) {
        out.push((prevJuntaAdiante ? lg[1] : lg[0]) || lg[0] || lg[1]);
        prevJuntaAdiante = false; // alef não liga à esquerda
        i++;
        continue;
      }
    }
    const [iso, fin, ini, med] = f;
    const proxF = i + 1 < s.length ? (formasDe(s[i + 1]) || (s[i + 1] === 0x0640 ? [0, 1, 1, 1] : null)) : null;
    const proxAceita = !!(proxF && proxF[1]); // a próxima letra tem forma final = pode receber ligação
    const dual = !!(ini && med);
    let forma;
    if (dual) {
      if (prevJuntaAdiante && proxAceita) forma = med;
      else if (prevJuntaAdiante) forma = fin;
      else if (proxAceita) forma = ini;
      else forma = iso;
    } else {
      forma = prevJuntaAdiante ? fin : iso;
    }
    out.push(forma || iso || cp);
    prevJuntaAdiante = dual;
  }
  return out;
}

const ESPELHO = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };

// Bidi simplificado: ordem lógica -> ordem visual (esquerda para direita).
function reordenarBidi(cps) {
  const cls = cps.map((c) => {
    if (cpRTL(c)) return 'R';
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c >= 0x80) return 'L';
    return 'N';
  });
  const primeira = cls.find((k) => k !== 'N');
  const base = primeira === 'L' ? 'L' : 'R';
  // neutros entre duas letras da mesma classe herdam a classe; nas pontas, a direção base
  for (let i = 0; i < cls.length; i++) {
    if (cls[i] !== 'N') continue;
    let j = i;
    while (j < cls.length && cls[j] === 'N') j++;
    const antes = i > 0 ? cls[i - 1] : null;
    const depois = j < cls.length ? cls[j] : null;
    const k = antes && depois && antes === depois ? antes : base;
    for (let m = i; m < j; m++) cls[m] = k;
    i = j - 1;
  }
  const runs = [];
  for (let i = 0; i < cps.length; i++) {
    const ult = runs[runs.length - 1];
    if (ult && ult.k === cls[i]) ult.c.push(cps[i]);
    else runs.push({ k: cls[i], c: [cps[i]] });
  }
  if (base === 'R') runs.reverse();
  const out = [];
  for (const r of runs) {
    if (r.k === 'R') {
      for (let i = r.c.length - 1; i >= 0; i--) {
        const ch = String.fromCodePoint(r.c[i]);
        out.push(ESPELHO[ch] ? ESPELHO[ch].codePointAt(0) : r.c[i]);
      }
    } else out.push(...r.c);
  }
  return out;
}

function prepararTextoParaTela(txt) {
  let s = normalizarPontuacao(txt);
  if (!/[֐-׿؀-ۿݐ-ݿיִ-﷿ﹰ-﻿]/.test(s)) return s.trim();
  let cps = Array.from(s, (ch) => ch.codePointAt(0));
  if (cps.some(cpRTLArabe)) cps = ligarArabe(cps);
  cps = reordenarBidi(cps);
  return String.fromCodePoint(...cps).trim();
}

// Aplica a cada linha LRC, preservando os carimbos [mm:ss.xx].
function prepararLetraParaTela(lrc) {
  lrc = String(lrc).replace(/\r\n?/g, '\n');
  if (!/[^\x00-\x7F]/.test(lrc)) return lrc; // só ASCII: nada a fazer
  // v1.3: aceita \r\n (CRLF) e separadores Unicode. Antes, "." não casava com \r e a linha
  // dava match nulo -> exceção -> o aparelho nunca recebia a letra (bug do Non-Stop).
  return lrc.replace(/\r\n?/g, '\n').split('\n').map((linha) => {
    try {
      const m = linha.match(/^((?:\[[^\]]*\])*)(\s*)([\s\S]*)$/);
      if (!m) return linha;
      return m[1] + (m[3] ? m[2] + prepararTextoParaTela(m[3]) : m[2]);
    } catch (e) {
      return linha; // nunca derruba a resposta por causa de uma linha estranha
    }
  }).join('\n');
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

// ---------------------------------------------------------------- Aparelhos (v1.4)
// Cada LyricAT gera no 1º boot um id e um segredo (32 hex cada) e se registra aqui. O servidor guarda só o
// SHA-256 do segredo, um contador e as datas. NÃO guarda nome, e-mail, IP nem o que o aparelho ouve.
// Permite: bloquear um aparelho, limitar pedidos por aparelho e saber quantos estão ativos.
// LYRICAT_SECRET_TOKEN = administrador (/admin). LYRICAT_REGISTER_KEY (opcional) = chave que vai no firmware
// só para se registrar; sem ela vale o SECRET_TOKEN. LYRICAT_LEGACY_OFF=1 desliga o token único dos firmwares antigos.
const aparelhos = new Map();       // id -> { hash, bloq, criado, ultimo, pedidos, versao, sujo }
const MAX_APARELHOS = 50000;
const regRate = new Map();
const devRate = new Map();

function hashSegredo(sec) { return crypto.createHash('sha256').update(String(sec)).digest('hex'); }
function iguaisSeguro(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function chaveRegistroValida(recebido) {
  const k = process.env.LYRICAT_REGISTER_KEY;
  return !!recebido && ((k && iguaisSeguro(recebido, k)) || tokenValido(recebido));
}

async function iniciarAparelhos() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aparelhos (
        id CHAR(32) PRIMARY KEY,
        secret_hash CHAR(64) NOT NULL,
        criado_em TIMESTAMPTZ DEFAULT NOW(),
        ultimo_contato TIMESTAMPTZ,
        versao TEXT,
        pedidos BIGINT DEFAULT 0,
        bloqueado BOOLEAN DEFAULT FALSE
      );`);
    const r = await pool.query('SELECT id, secret_hash, criado_em, ultimo_contato, versao, pedidos, bloqueado FROM aparelhos LIMIT 100000');
    for (const x of r.rows) {
      aparelhos.set(String(x.id).trim(), {
        hash: String(x.secret_hash).trim(), bloq: !!x.bloqueado,
        criado: x.criado_em ? new Date(x.criado_em).getTime() : 0,
        ultimo: x.ultimo_contato ? new Date(x.ultimo_contato).getTime() : 0,
        pedidos: Number(x.pedidos) || 0, versao: x.versao || '', sujo: false
      });
    }
    console.log('📟 Aparelhos carregados: ' + aparelhos.size);
  } catch (err) {
    console.error('❌ Erro ao iniciar tabela de aparelhos:', err.message);
  }
}

// Grava contadores e "último contato" a cada 5 min (uma única consulta), não a cada pedido.
async function salvarAparelhosSujos() {
  const sujos = [];
  for (const [id, a] of aparelhos) if (a.sujo) sujos.push([id, a]);
  if (!sujos.length) return;
  try {
    for (let i = 0; i < sujos.length; i += 200) {
      const lote = sujos.slice(i, i + 200);
      const ids = lote.map((p) => p[0]);
      const ult = lote.map((p) => new Date(p[1].ultimo).toISOString());
      const ped = lote.map((p) => p[1].pedidos);
      const ver = lote.map((p) => p[1].versao || '');
      await pool.query(
        `UPDATE aparelhos a SET ultimo_contato = v.u::timestamptz, pedidos = v.p, versao = v.ver
           FROM (SELECT unnest($1::text[]) AS id, unnest($2::text[]) AS u, unnest($3::bigint[]) AS p, unnest($4::text[]) AS ver) v
          WHERE a.id = v.id`, [ids, ult, ped, ver]);
      lote.forEach((p) => { p[1].sujo = false; });
    }
  } catch (err) {
    console.error('⚠️ salvar aparelhos:', err.message);
  }
}
if (require.main === module) setInterval(salvarAparelhosSujos, 5 * 60 * 1000).unref();

// Aparelhos sem contato há mais de 90 dias (e não bloqueados) saem da lista, para a tabela não crescer à toa.
const APARELHO_INATIVO_MS = 90 * 24 * 3600 * 1000;
async function limparAparelhosInativos() {
  const limite = Date.now() - APARELHO_INATIVO_MS;
  let removidos = 0;
  for (const [id, a] of aparelhos) {
    if (!a.bloq && a.ultimo < limite) { aparelhos.delete(id); removidos++; }
  }
  try {
    await pool.query("DELETE FROM aparelhos WHERE NOT bloqueado AND ultimo_contato < NOW() - INTERVAL '90 days'");
  } catch (err) {
    console.error('⚠️ limpar aparelhos inativos:', err.message);
  }
  if (removidos) console.log('🧹 Aparelhos inativos removidos: ' + removidos + ' · total ' + aparelhos.size);
  return removidos;
}
if (require.main === module) {
  setTimeout(limparAparelhosInativos, 2 * 60 * 1000).unref();
  setInterval(limparAparelhosInativos, 24 * 3600 * 1000).unref();
}

function limiteChave(mapa, chave, maxPorMin) {
  const agora = Date.now();
  let r = mapa.get(chave);
  if (!r || agora > r.reinicia) { r = { n: 0, reinicia: agora + 60000 }; mapa.set(chave, r); }
  r.n++;
  if (mapa.size > 60000) mapa.clear();
  return r.n <= maxPorMin;
}

// Autoriza um pedido do aparelho. Devolve { ok, id, motivo }.
function autorizarAparelho(req, maxPorMin) {
  const id = String(req.headers['x-lyricat-device'] || '').toLowerCase();
  const sec = String(req.headers['x-lyricat-secret'] || '');
  if (/^[0-9a-f]{32}$/.test(id) && /^[0-9a-f]{32}$/.test(sec)) {
    const a = aparelhos.get(id);
    if (!a) return { ok: false, motivo: 'desconhecido' };
    if (a.bloq) return { ok: false, motivo: 'bloqueado' };
    if (!iguaisSeguro(hashSegredo(sec), a.hash)) return { ok: false, motivo: 'segredo' };
    if (!limiteChave(devRate, id, maxPorMin)) return { ok: false, motivo: 'limite' };
    a.pedidos++; a.ultimo = Date.now(); a.sujo = true;
    // Versão do firmware vem no User-Agent ("LyricAT-ESP32 v1.8b (...)"): mantém a lista sempre atual após atualizações.
    const mv = /LyricAT-ESP32 v([\w.\-]{1,30})/.exec(String(req.headers['user-agent'] || ''));
    if (mv && mv[1] !== a.versao) a.versao = mv[1];
    return { ok: true, id };
  }
  // Firmwares antigos (1.7x): token único compartilhado, enquanto LYRICAT_LEGACY_OFF não for 1.
  if (process.env.LYRICAT_LEGACY_OFF !== '1' && tokenValido(req.headers['x-lyricat-auth'])) return { ok: true, id: null };
  return { ok: false, motivo: 'sem credencial' };
}

function negarAparelho(res, aut) {
  if (aut.motivo === 'limite') return res.status(429).json({ ok: 0, error: 'devagar' });
  // "desconhecido" faz o firmware se registrar de novo (ex.: tabela apagada).
  return res.status(401).json({ ok: 0, error: 'Não autorizado.', registrar: aut.motivo === 'desconhecido' ? 1 : 0 });
}

app.post('/api/device/register', async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || '?';
  if (!limiteChave(regRate, ip, 20)) return res.status(429).json({ ok: 0, error: 'devagar' });
  if (!chaveRegistroValida(req.headers['x-lyricat-auth'])) return res.status(401).json({ ok: 0, error: 'Não autorizado.' });
  const b = req.body || {};
  const id = String(b.id || '').toLowerCase();
  const sec = String(b.secret || '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{32}$/.test(sec)) return res.status(400).json({ ok: 0, error: 'id/segredo inválidos' });
  const versao = limparTexto(b.versao, 40);
  const hash = hashSegredo(sec);
  const ja = aparelhos.get(id);
  if (ja) {
    if (!iguaisSeguro(hash, ja.hash)) return res.status(409).json({ ok: 0, error: 'id em uso' });
    if (ja.bloq) return res.status(403).json({ ok: 0, error: 'bloqueado' });
    ja.versao = versao || ja.versao; ja.ultimo = Date.now(); ja.sujo = true;
    return res.json({ ok: 1, ja: 1 });
  }
  if (aparelhos.size >= MAX_APARELHOS) return res.status(503).json({ ok: 0, error: 'cheio' });
  try {
    await pool.query('INSERT INTO aparelhos (id, secret_hash, ultimo_contato, versao) VALUES ($1, $2, NOW(), $3) ON CONFLICT (id) DO NOTHING', [id, hash, versao]);
  } catch (err) {
    console.error('⚠️ registrar aparelho:', err.message);
    return res.status(502).json({ ok: 0, error: 'banco indisponível' });
  }
  aparelhos.set(id, { hash, bloq: false, criado: Date.now(), ultimo: Date.now(), pedidos: 0, versao, sujo: false });
  console.log('📟 Novo aparelho ' + id.slice(0, 6) + '… (' + versao + ') · total ' + aparelhos.size);
  return res.json({ ok: 1 });
});

// O próprio aparelho se apaga da lista (reset de fábrica). Exige id + segredo dele.
app.post('/api/device/unregister', async (req, res) => {
  const aut = autorizarAparelho(req, 10);
  if (!aut.ok) return negarAparelho(res, aut);
  if (!aut.id) return res.status(400).json({ ok: 0, error: 'precisa de id do aparelho' });
  try { await pool.query('DELETE FROM aparelhos WHERE id = $1', [aut.id]); }
  catch (err) { return res.status(502).json({ ok: 0, error: 'banco indisponível' }); }
  aparelhos.delete(aut.id);
  console.log('🗑️ Aparelho removido (reset) ' + aut.id.slice(0, 6) + '… · total ' + aparelhos.size);
  return res.json({ ok: 1 });
});

// Administração: apagar um aparelho da lista (ex.: restos de resets antigos).
app.delete('/api/admin/aparelhos/:id', exigirToken, async (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  if (!aparelhos.has(id)) return res.status(404).json({ error: 'aparelho não encontrado' });
  try { await pool.query('DELETE FROM aparelhos WHERE id = $1', [id]); }
  catch (err) { return res.status(502).json({ error: err.message }); }
  aparelhos.delete(id);
  return res.json({ ok: 1 });
});

// Administração: lista e bloqueio (só com o token de administrador).
app.get('/api/admin/aparelhos', exigirToken, (req, res) => {
  const agora = Date.now();
  const lista = [];
  let a24 = 0, a7 = 0, bloqueados = 0;
  for (const [id, a] of aparelhos) {
    if (agora - a.ultimo < 86400000) a24++;
    if (agora - a.ultimo < 7 * 86400000) a7++;
    if (a.bloq) bloqueados++;
    lista.push({ id, versao: a.versao, criado: a.criado, ultimo: a.ultimo, pedidos: a.pedidos, bloqueado: a.bloq });
  }
  lista.sort((x, y) => y.ultimo - x.ultimo);
  res.json({ total: aparelhos.size, ativos24h: a24, ativos7d: a7, bloqueados, aparelhos: lista.slice(0, 200) });
});

app.post('/api/admin/aparelhos/:id/bloquear', exigirToken, async (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  const a = aparelhos.get(id);
  if (!a) return res.status(404).json({ error: 'aparelho não encontrado' });
  a.bloq = !!(req.body && req.body.bloqueado);
  try { await pool.query('UPDATE aparelhos SET bloqueado = $2 WHERE id = $1', [id, a.bloq]); }
  catch (err) { return res.status(502).json({ error: err.message }); }
  return res.json({ ok: 1, bloqueado: a.bloq });
});

// ---------------------------------------------------------------- Rota do aparelho
// Respostas:
//   200 {syncedLyrics}            achou (cache ou LRCLIB)
//   404 {syncedLyrics:""}         não existe letra sincronizada (cache negativo por 3 dias)
//   502 {syncedLyrics:""}         LRCLIB indisponível agora (NÃO vai pro cache; o firmware pode tentar direto)
app.get('/api/lyrics', async (req, res) => {
  const aut = autorizarAparelho(req, 90);
  if (!aut.ok) {
    console.log('🚫 Acesso bloqueado (' + aut.motivo + ').');
    return negarAparelho(res, aut);
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

  try {
    const r = await obterLetra({ track_id, track, artist, album, dur, isrc: req.query.isrc, search });
    if (r.estado === 'achou') {
      let paraTela = r.lyrics;
      if (req.query.raw !== '1') {
        try { paraTela = prepararLetraParaTela(r.lyrics); }
        catch (e) { console.error('❌ prepararLetraParaTela falhou (enviando original):', e.message); }
      }
      // fmt=txt: corpo texto puro (a letra direto). O aparelho lê sem montar JSON, gastando
      // bem menos memória em músicas longas. Sem fmt=txt continua o JSON de sempre.
      if (req.query.fmt === 'txt') {
        res.set('X-Lyricat-Source', String(r.source || ''));
        if (r.clima !== null && r.clima !== undefined) res.set('X-Lyricat-Clima', Number(r.clima).toString(16));   // 1.5k: hexadecimal, 1 caractere para 0-15
        if (r.bpm) res.set('X-Lyricat-Bpm', String(Number(r.bpm)));   // 1.6: BPM (o gato dança no tempo)
        return res.type('text/plain; charset=utf-8').send(paraTela);
      }
      return res.json({ syncedLyrics: paraTela, source: r.source, clima: (r.clima === undefined ? null : r.clima), bpm: (r.bpm || null) });
    }
    if (r.estado === 'erro') {
      console.log(`⚠️ LRCLIB indisponível para: ${track}`);
      return res.status(502).json({ syncedLyrics: '' });
    }
    console.log(`⚠️ Sem letra sincronizada: ${track}`);
    return res.status(404).json({ syncedLyrics: '', source: r.source });
  } catch (err) {
    console.error('❌ Erro em /api/lyrics:', err && err.stack || err);
    return res.status(500).json({ syncedLyrics: '', error: 'erro interno' });
  }
});


// ---------------------------------------------------------------- Clima da música (IA, em segundo plano)
// O gato reage ao "clima" da música. O aparelho só sabe contar palavras da letra; aqui o Gemini lê a letra
// (e conhece a música pelo título/artista) e devolve um clima, guardado em cache_letras.clima.
// Sem GEMINI_API_KEY nada disso roda e o aparelho usa as regras dele. Só o clima é guardado, nunca a resposta inteira.
// Códigos (iguais no firmware): 0 neutro, 1 alegre, 2 chorão, 3 melancólico, 4 assustado, 5 calmo, 6 agitado, 7 raiva.
const CLIMAS = ['neutro', 'alegre', 'chorao', 'melancolico', 'assustado', 'calmo', 'agitado', 'raiva', 'apaixonado', 'determinado', 'sensual', 'sonhador', 'festeiro', 'zoeira', 'epico', 'sombrio'];
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_MAX_DIA = Math.max(1, parseInt(process.env.GEMINI_MAX_DIA, 10) || 400);   // limite grátis do modelo pode ter mudado: confira no AI Studio
const GEMINI_INTERVALO_MS = Math.max(2000, parseInt(process.env.GEMINI_INTERVALO_MS, 10) || 5000);
const clima = { dia: '', usados: 0, ok: 0, falhas: 0, pausadoAte: 0, ultimoErro: '', ocupado: false, ultimoTitulo: '' };

const PROMPT_CLIMA = `Classify the mood of a song for a cat mascot. Use the lyrics and what you know about the real song; watch for irony.
Pick the single best label. Avoid "neutro": use it only if no other label fits at all.
alegre (truly upbeat, joyful)
chorao (heartbreak, grief; a song people cry to)
melancolico (sad, nostalgic, bittersweet, not weeping)
assustado (sounds cheerful but is lyrically dark, eerie or disturbing, e.g. Pumped Up Kicks, Hey Ya!)
calmo (soft, peaceful, tender)
agitado (high energy, hype or party, not angry)
raiva (angry, furious, aggressive)
apaixonado (love song, romance, longing or desire for someone)
determinado (empowerment, resilience, triumph, confidence, "I will survive" energy; strong but not angry)
sensual (smooth, seductive, slow groove, sexy)
sonhador (dreamy, hazy, ethereal, psychedelic, floaty)
festeiro (club/party dance music made to dance to)
zoeira (funny, silly, quirky, comedic, novelty)
epico (cinematic, anthemic, grand, triumphant build-up)
sombrio (dark, brooding, heavy, gothic; not fake-cheerful)
neutro (last resort)

Also give "bpm": the tempo of the real song in beats per minute, an integer from 40 to 220, from what you know about the song (0 if you really do not know).`;

function textoParaClima(lrc) {
  const vistas = new Set();
  const linhas = [];
  for (const bruta of String(lrc || '').split('\n')) {
    const l = bruta.replace(/\[[^\]]*\]/g, '').trim();   // tira [mm:ss.xx]
    if (!l) continue;
    const k = l.toLowerCase();
    if (vistas.has(k)) continue;   // refrões repetidos não gastam tokens
    vistas.add(k);
    linhas.push(l);
  }
  return linhas.join('\n').slice(0, 2800);   // ~700 tokens: basta para captar o tom (o refrão repetido já foi removido)
}

function diaDoGemini() { return new Date(Date.now() - 8 * 3600 * 1000).toISOString().slice(0, 10); }   // o Google zera à meia-noite do Pacífico (≈ UTC-8)

async function classificarClima(artist, track, lrc) {
  const corpo = {
    systemInstruction: { parts: [{ text: PROMPT_CLIMA }] },
    contents: [{ role: 'user', parts: [{ text: artist + ' - ' + track + '\n' + textoParaClima(lrc) }] }],
    // o esquema com "enum" obriga o Gemini a responder UM dos climas ({"clima":"assustado"}, ~8 tokens)
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 300,   // 1.5h: o Gemini 3.x gasta parte disso "pensando"; com 20 a resposta vinha cortada ({\n \")
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { clima: { type: 'STRING', enum: CLIMAS }, bpm: { type: 'INTEGER' } }, required: ['clima', 'bpm'] }
    }
  };
  const r = await axios.post(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(GEMINI_MODEL) + ':generateContent',
    corpo,
    { headers: { 'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json' }, timeout: 25000, validateStatus: () => true });
  if (r.status !== 200) {
    const e = new Error('Gemini HTTP ' + r.status + ': ' + JSON.stringify(r.data && r.data.error && r.data.error.message || '').slice(0, 200));
    e.status = r.status;
    throw e;
  }
  const partes = (r.data && r.data.candidates && r.data.candidates[0] && r.data.candidates[0].content && r.data.candidates[0].content.parts) || [];
  const txt = partes.filter((p) => p && !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  console.log('🎭 resposta bruta do Gemini: ' + JSON.stringify(txt).slice(0, 120));
  let palavra = String(txt || '');
  let bpm = 0;
  try { const j = JSON.parse(palavra); palavra = String(j.clima || palavra); bpm = Math.round(Number(j.bpm) || 0); } catch (e) { /* texto puro: cai no includes abaixo */ }
  if (bpm < 40 || bpm > 220) bpm = 0;   // 1.6: fora do razoável = desconhecido
  palavra = palavra.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();   // "chorão" -> "chorao"
  let cod = CLIMAS.findIndex((c) => palavra.includes(c));
  if (cod < 0) throw new Error('Resposta incompleta ou fora da lista (' + palavra.slice(0, 40).replace(/\s+/g, ' ') + ')');   // 1.5h: não grava neutro no escuro; conta como tentativa e tenta de novo
  return { cod, bpm };
}

// Uma música por vez: a mais recente sem clima (as pedidas agora vêm primeiro; o resto do banco vai sendo preenchido).
async function trabalharClima() {
  if (!GEMINI_KEY || clima.ocupado) return;
  if (Date.now() < clima.pausadoAte) return;
  const hoje = diaDoGemini();
  if (clima.dia !== hoje) { clima.dia = hoje; clima.usados = 0; }
  if (clima.usados >= GEMINI_MAX_DIA) return;
  clima.ocupado = true;
  let linha = null;
  try {
    const r = await pool.query(`
      SELECT id, artist, track, synced_lyrics FROM cache_letras
      WHERE (clima IS NULL OR bpm IS NULL) AND COALESCE(clima_tent, 0) < 3 AND synced_lyrics IS NOT NULL AND synced_lyrics <> ''
      ORDER BY (clima IS NULL) DESC, id DESC LIMIT 1`);   // 1.6: primeiro as sem clima; depois as antigas sem BPM
    if (!r.rows.length) return;
    linha = r.rows[0];
    clima.usados++;
    const { cod, bpm } = await classificarClima(linha.artist, linha.track, linha.synced_lyrics);
    await pool.query('UPDATE cache_letras SET clima = COALESCE(clima, $1), clima_em = COALESCE(clima_em, NOW()), bpm = $2 WHERE id = $3', [cod, bpm, linha.id]);
    clima.ok++; clima.seguidas = 0;
    clima.ultimoTitulo = linha.artist + ' - ' + linha.track + ' → ' + CLIMAS[cod];
    console.log('🎭 Clima: ' + clima.ultimoTitulo);
  } catch (e) {
    clima.falhas++;
    clima.ultimoErro = String(e.message || e).slice(0, 240);
    console.error('❌ Clima (Gemini):', clima.ultimoErro);
    if (e.status === 429) clima.pausadoAte = Date.now() + 90 * 1000;                              // limite por minuto: espera
    else if (e.status === 400 || e.status === 401 || e.status === 403 || e.status === 404) clima.pausadoAte = Date.now() + 30 * 60 * 1000;   // chave inválida/sem permissão/modelo inexistente: para de tentar por um tempo (sem queimar as tentativas das músicas)
    else if ((clima.seguidas = (clima.seguidas || 0) + 1) >= 3) { clima.pausadoAte = Date.now() + 10 * 60 * 1000; clima.seguidas = 0; }   // 1.5f: 3 falhas seguidas (Gemini fora do ar?): pausa em vez de gastar as tentativas do banco
    else if (linha) { try { await pool.query('UPDATE cache_letras SET clima_tent = COALESCE(clima_tent, 0) + 1 WHERE id = $1', [linha.id]); } catch (e2) {} }
  } finally {
    clima.ocupado = false;
  }
}

function iniciarClima() {
  if (!GEMINI_KEY) { console.log('🎭 Clima por IA desligado (sem GEMINI_API_KEY): o aparelho usa as regras dele.'); return; }
  console.log('🎭 Clima por IA ligado: ' + GEMINI_MODEL + ', até ' + GEMINI_MAX_DIA + '/dia.');
  setInterval(() => { trabalharClima().catch(() => {}); }, GEMINI_INTERVALO_MS);
}

// Só o clima de uma música (o aparelho usa quando a letra veio do cache dele e não passou por /api/lyrics).
// 200 com um dígito (0-6) se já foi classificada; 404 se ainda não.
app.get('/api/clima', async (req, res) => {
  const aut = autorizarAparelho(req, 90);
  if (!aut.ok) return negarAparelho(res, aut);
  const track_id = String(req.query.track_id || '').slice(0, 255);
  const track = String(req.query.track || '').trim();
  const artist = String(req.query.artist || '').trim();
  if (!track_id && !(track && artist)) return res.status(400).send('');
  try {
    const r = await pool.query(
      'SELECT clima, bpm FROM cache_letras WHERE clima IS NOT NULL AND (track_id = $1 OR chave = $2) ORDER BY (track_id = $1) DESC LIMIT 1',
      [track_id, montarChave(artist, track)]);
    if (!r.rows.length) return res.status(404).send('');
    if (r.rows[0].bpm) res.set('X-Lyricat-Bpm', String(Number(r.rows[0].bpm)));
    return res.type('text/plain').send(Number(r.rows[0].clima).toString(16));
  } catch (err) {
    console.error('❌ Erro em /api/clima:', err.message);
    return res.status(500).send('');
  }
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
    const c = await pool.query(`
      SELECT count(*) FILTER (WHERE clima IS NOT NULL)::int AS classificadas,
             count(*) FILTER (WHERE clima IS NULL AND COALESCE(clima_tent, 0) < 3 AND synced_lyrics <> '')::int AS pendentes,
             count(*) FILTER (WHERE clima IS NULL AND COALESCE(clima_tent, 0) >= 3)::int AS sem_sucesso
      FROM cache_letras`);
    const cl = { classificadas: c.rows[0].classificadas, pendentes: c.rows[0].pendentes, semSucesso: c.rows[0].sem_sucesso };
    res.json({
      versao: '1.6',
      musicas: s.total,
      comLetra: s.com_letra,
      semLetra: s.sem_letra,
      tamanho: s.tamanho,
      percentualDe500MB: Math.round((s.bytes / (500 * 1024 * 1024)) * 1000) / 10,
      ultimaGravacao: s.ultima,
      lrclibPausadoPorSegundos: Math.max(0, Math.round((pausadoAte - Date.now()) / 1000)),
      servidorLigadoHaSegundos: Math.round(process.uptime()),
      clima: {
        ligado: !!GEMINI_KEY, modelo: GEMINI_MODEL, hoje: clima.usados, limiteDia: GEMINI_MAX_DIA,
        classificadas: cl.classificadas, pendentes: cl.pendentes, semSucesso: cl.semSucesso,
        pausadoPorSegundos: Math.max(0, Math.round((clima.pausadoAte - Date.now()) / 1000)),
        ultimo: clima.ultimoTitulo, ultimoErro: clima.ultimoErro
      }
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
  <h2>Aparelhos</h2>
  <div class="mut">Cada LyricAT se registra sozinho com um id aleatório (sem dados pessoais). Bloquear corta o acesso dele.</div>
  <div class="row"><button id="bAparelhos">Atualizar</button></div>
  <div class="kv" id="apStats" style="margin-top:10px"></div>
  <div id="apLista" style="margin-top:10px;font-size:13px"></div>
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
      ['Clima (IA)', s.clima.ligado ? (s.clima.classificadas + ' classificadas, ' + s.clima.pendentes + ' na fila · hoje ' + s.clima.hoje + '/' + s.clima.limiteDia + (s.clima.pausadoPorSegundos > 0 ? ' · pausado ' + s.clima.pausadoPorSegundos + ' s' : '')) : 'desligado (falta GEMINI_API_KEY)'],
      ['Último clima', s.clima.ultimo || '-'],
      ['Erro do clima', s.clima.ultimoErro || '-'],
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

function ha(ms) {
  var m = Math.round((Date.now() - ms) / 60000);
  if (m < 2) return 'agora';
  if (m < 120) return m + ' min';
  if (m < 2880) return Math.round(m / 60) + ' h';
  return Math.round(m / 1440) + ' dias';
}
function carregarAparelhos() {
  api('/api/admin/aparelhos').then(function (r) {
    if (r.status === 401) throw new Error('Token incorreto.');
    return r.json();
  }).then(function (j) {
    kv($('apStats'), [['Registrados', String(j.total)], ['Ativos 24 h', String(j.ativos24h)], ['Ativos 7 dias', String(j.ativos7d)], ['Bloqueados', String(j.bloqueados)]]);
    var box = $('apLista'); box.textContent = '';
    j.aparelhos.forEach(function (a) {
      var linha = document.createElement('div');
      linha.style.cssText = 'display:flex;gap:8px;align-items:center;padding:4px 0;border-top:1px solid rgba(128,128,128,.25)';
      var t = document.createElement('span'); t.style.flex = '1';
      t.textContent = a.id.slice(0, 8) + ' · v' + (a.versao || '?') + ' · visto ' + ha(a.ultimo) + ' · ' + a.pedidos + ' pedidos' + (a.bloqueado ? ' · BLOQUEADO' : '');
      var b = document.createElement('button');
      b.textContent = a.bloqueado ? 'Desbloquear' : 'Bloquear';
      b.onclick = function () {
        api('/api/admin/aparelhos/' + a.id + '/bloquear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bloqueado: !a.bloqueado }) })
          .then(function () { carregarAparelhos(); });
      };
      var d = document.createElement('button');
      d.textContent = 'Apagar';
      d.onclick = function () {
        if (!confirm('Apagar ' + a.id.slice(0, 8) + ' da lista? Se o aparelho ainda existir, ele se registra de novo sozinho.')) return;
        api('/api/admin/aparelhos/' + a.id, { method: 'DELETE' }).then(function () { carregarAparelhos(); });
      };
      linha.appendChild(t); linha.appendChild(b); linha.appendChild(d); box.appendChild(linha);
    });
  }).catch(function (e) { say('Erro: ' + e.message); });
}
$('bAparelhos').onclick = carregarAparelhos;
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
if (tok()) { carregarStats(); statusPrefill(); carregarAparelhos(); }
</script>
</body>
</html>`;

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(ADMIN_HTML);
});

// ---------------------------------------------------------------- Ponte "agora tocando" (v1.3)
// Qualquer "ponte" (extensão do navegador, app Android...) avisa aqui o que está tocando; o LyricAT
// pergunta aqui em vez de depender do Spotify. Isso serve YouTube Music, Spotify, Apple Music etc.,
// sem OAuth por usuário (o modo de desenvolvimento do Spotify agora limita a 5 usuários).
//   POST /api/np   ponte -> servidor   (header x-lyricat-code: código de pareamento do aparelho)
//   GET  /api/np   aparelho -> servidor (headers x-lyricat-auth + x-lyricat-code)
//   GET  /api/cover?u=...              capa (só hosts do Google/YouTube), sempre JPEG com Content-Length
// O estado fica só na memória (é efêmero); o cache de letras continua no Supabase.
const NP_MAX_SLOTS = 5000;
const NP_TTL_MS = 30 * 60 * 1000;      // slot sem novidade por 30 min é apagado
const NP_ONLINE_MS = 45 * 1000;        // sem sinal da ponte há mais que isso = ponte offline
const npSlots = new Map();             // código -> estado
const npRate = new Map();              // ip -> {n, reinicia}

function normalizarCodigo(c) {
  return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}
// Alfabeto sem 0/1/I/L/O (evita confusão ao digitar). 12 caracteres ~ 60 bits.
function codigoValido(c) { return /^[A-HJKMNP-Z2-9]{12}$/.test(c); }

function limiteIp(req, maxPorMin) {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || '?';
  const agora = Date.now();
  let r = npRate.get(ip);
  if (!r || agora > r.reinicia) { r = { n: 0, reinicia: agora + 60000 }; npRate.set(ip, r); }
  r.n++;
  if (npRate.size > 20000) npRate.clear();
  return r.n <= maxPorMin;
}

function limparTexto(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }

// Capas do YouTube Music: pede um JPEG baseline pequeno (o aparelho decodifica em 64x64).
// Retorna { url, w, h } ou null se o host não for permitido.
function ajustarCapa(u) {
  let url;
  try { url = new URL(String(u)); } catch (e) { return null; }
  if (url.protocol !== 'https:') return null;
  const h = url.hostname.toLowerCase();
  if (/^(lh\d+|yt\d+)\.(googleusercontent|ggpht)\.com$/.test(h)) {
    // .../<id>=w544-h544-l90-rj  ->  =w128-h128-l80-rj-c  (JPEG baseline, recorte quadrado)
    const base = url.href.replace(/=[wsh]\d.*$/i, '');
    return { url: base + '=w128-h128-l80-rj-c', w: 128, h: 128 };
  }
  if (h === 'i.ytimg.com' || h === 'img.youtube.com') {
    const m = url.pathname.match(/^\/vi(?:_webp)?\/([\w-]{6,20})\//);
    if (!m) return null;
    return { url: 'https://i.ytimg.com/vi/' + m[1] + '/default.jpg', w: 120, h: 90 };
  }
  if (h === 'i.scdn.co') {                       // Spotify Web: troca o prefixo pelo da versão 64x64
    const m = url.pathname.match(/^\/image\/ab67616d0000(?:b273|1e02|4851)([0-9a-f]{24})$/);
    if (!m) return null;
    return { url: 'https://i.scdn.co/image/ab67616d00004851' + m[1], w: 64, h: 64 };
  }
  if (/^is\d*-ssl\.mzstatic\.com$/.test(h)) {   // Apple Music: .../512x512bb.jpg -> 128x128bb.jpg
    if (!/\/\d+x\d+[a-z]*\.(jpg|jpeg)$/i.test(url.pathname)) return null;
    return { url: url.origin + url.pathname.replace(/\/\d+x\d+[a-z]*\.(jpg|jpeg)$/i, '/128x128bb.jpg'), w: 128, h: 128 };
  }
  if (/^(e-)?cdn?s?-images\.dzcdn\.net$/.test(h) || h === 'cdn-images.dzcdn.net' || h === 'e-cdns-images.dzcdn.net') {
    if (!/\/\d+x\d+[\w-]*\.jpg$/i.test(url.pathname)) return null;   // Deezer
    return { url: url.origin + url.pathname.replace(/\/\d+x\d+[\w-]*\.jpg$/i, '/120x120-000000-80-0-0.jpg'), w: 120, h: 120 };
  }
  if (/^i\d\.sndcdn\.com$/.test(h)) {           // SoundCloud: -t500x500.jpg -> -large.jpg (100x100)
    if (!/-(t\d+x\d+|large|crop|original|badge|small|tiny|mini)\.(jpg|jpeg)$/i.test(url.pathname)) return null;
    return { url: url.origin + url.pathname.replace(/-(t\d+x\d+|large|crop|original|badge|small|tiny|mini)\.(jpg|jpeg)$/i, '-large.jpg'), w: 100, h: 100 };
  }
  return null;
}

// Última vez que um aparelho leu cada código (para a extensão avisar "código sem aparelho").
const codigoVisto = new Map();
// IP local do aparelho (informado por ele mesmo a cada consulta) para o app abrir o painel na rede de casa.
const codigoIp = new Map();           // código -> {ip, ts}
function guardarIpLocal(codigo, ip) {
  if (!/^(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$/.test(ip)) return;
  if (codigoIp.size > 20000) codigoIp.clear();
  codigoIp.set(codigo, { ip, ts: Date.now() });
}

function marcarCodigoVisto(codigo) {
  const agora = Date.now();
  if (codigoVisto.size > 5000) for (const [k, v] of codigoVisto) if (agora - v > 600000) codigoVisto.delete(k);
  if (codigoVisto.size <= 20000) codigoVisto.set(codigo, agora);
}

// ---- Capa enviada pelo app Android (o Android entrega a imagem, não uma URL) ----
// Uma capa por código (a da música atual), JPEG baseline pequeno; no máximo CAPAS_APP_MAX códigos em memória.
const capasApp = new Map();            // código -> {k, buf, ver, w, h, ts}
const CAPAS_APP_MAX = 400;
let capaAppVer = 0;
function chaveCapaApp(t, a) { return limparTexto(t, 300) + '|' + limparTexto(a, 300); }

function receberCapaApp(req, res) {
  const codigo = normalizarCodigo(req.headers['x-lyricat-code']);
  if (!codigoValido(codigo)) return res.status(401).json({ ok: 0, error: 'código inválido' });
  if (!limiteIp(req, 120)) return res.status(429).json({ ok: 0, error: 'devagar' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 200 || buf.length > 60000) return res.status(400).json({ ok: 0, error: 'imagem inválida' });
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return res.status(400).json({ ok: 0, error: 'não é JPEG' });
  for (let i = 2; i < buf.length - 1; i++) { if (buf[i] === 0xFF && buf[i + 1] === 0xC2) return res.status(400).json({ ok: 0, error: 'JPEG progressivo' }); }
  const w = Math.max(16, Math.min(parseInt(req.query.w, 10) || 128, 256));
  const h = Math.max(16, Math.min(parseInt(req.query.h, 10) || 128, 256));
  if (!capasApp.has(codigo) && capasApp.size >= CAPAS_APP_MAX) {
    const velho = capasApp.keys().next().value;   // o mais antigo (ordem de inserção)
    capasApp.delete(velho);
  }
  capasApp.delete(codigo);                        // reinsere no fim (mais recente)
  capasApp.set(codigo, { k: chaveCapaApp(req.query.t, req.query.a), buf, ver: ++capaAppVer, w, h, ts: Date.now() });
  return res.json({ ok: 1 });
}

function servirCapaApp(req, res) {
  if (!limiteIp(req, 240)) return res.status(429).end();
  const codigo = normalizarCodigo(req.params.codigo);
  const ca = capasApp.get(codigo);
  if (!codigoValido(codigo) || !ca || String(ca.ver) !== String(req.params.ver)) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Content-Length': String(ca.buf.length), 'Cache-Control': 'no-store' });
  return res.end(ca.buf);
}

function slotAtual(codigo) {
  const s = npSlots.get(codigo);
  if (!s) return null;
  if (Date.now() - s.ts > NP_TTL_MS) { npSlots.delete(codigo); return null; }
  return s;
}

function idSintetico(artist, track, durSeg) {
  return 'n:' + crypto.createHash('sha1').update(montarChave(artist, track) + '|' + durSeg).digest('hex').slice(0, 24);
}

// Melhor fonte entre as pontes ativas: quem está TOCANDO ganha. 1.8i: com empate (as duas pausadas, ou as duas
// tocando) a fonte que já estava sendo usada continua (slot.sel); antes ganhava sempre a "mais recente", e com a
// extensão e o app pausados a escolha ficava trocando a cada aviso, o aparelho via "música nova" toda hora e o gato
// comentava sem parar.
function melhorFonte(slot, agora) {
  const vivas = [];
  for (const e of Object.values(slot.f)) {
    if (agora - e.ts > NP_ONLINE_MS || !e.t) continue;
    vivas.push(e);
  }
  if (!vivas.length) { slot.sel = ''; return null; }
  const tocando = vivas.filter((e) => e.pl);
  const grupo = tocando.length ? tocando : vivas;
  let melhor = grupo.find((e) => e.src === slot.sel) || null;
  if (!melhor) for (const e of grupo) if (!melhor || e.ts > melhor.ts) melhor = e;
  slot.sel = melhor.src;
  return melhor;
}

function receberNp(req, res) {
  const codigo = normalizarCodigo(req.headers['x-lyricat-code']);
  if (!codigoValido(codigo)) return res.status(401).json({ ok: 0, error: 'código inválido' });
  if (!limiteIp(req, 240)) return res.status(429).json({ ok: 0, error: 'devagar' });
  const b = req.body || {};
  const agora = Date.now();
  if (!npSlots.has(codigo) && npSlots.size >= NP_MAX_SLOTS) {
    for (const [k, v] of npSlots) if (agora - v.ts > NP_TTL_MS) npSlots.delete(k);
    if (npSlots.size >= NP_MAX_SLOTS) return res.status(503).json({ ok: 0, error: 'cheio' });
  }
  const titulo = limparTexto(b.title, 300);
  const artista = limparTexto(b.artist, 300);
  const dur = Math.max(0, Math.min(Math.round(Number(b.duration_ms) || 0), 6 * 3600 * 1000));
  const pos = Math.max(0, Math.min(Math.round(Number(b.position_ms) || 0), dur || 6 * 3600 * 1000));
  const capa = ajustarCapa(b.cover);
  const src = /^[a-z0-9-]{2,24}$/.test(String(b.source || '')) ? String(b.source) : 'ponte';
  let slot = npSlots.get(codigo);
  if (!slot) { slot = { f: {}, ts: agora }; npSlots.set(codigo, slot); }
  if (!slot.f[src] && Object.keys(slot.f).length >= 6) return res.status(400).json({ ok: 0, error: 'fontes demais' });
  slot.f[src] = {
    t: titulo, a: artista, al: limparTexto(b.album, 300),
    d: dur, p: pos, pl: b.playing === true || b.playing === 1,
    v: b.is_video === true || b.is_video === 1,
    c: capa, src, ts: agora, lb: limparTexto(b.label, 20),
    k: Math.max(0, ['music', 'podcast', 'video', 'ad'].indexOf(String(b.kind || 'music')))
  };
  slot.ts = agora;
  const visto = codigoVisto.get(codigo);
  // aparelho = segundos desde que um LyricAT leu este código (-1 = nenhum leu ainda)
  return res.json({ ok: 1, aparelho: visto ? Math.round((agora - visto) / 1000) : -1 });
}

// 1.8u: gênero da música (Deezer, sem chave) para o gato escolher falas dos avisos instrumentais. Tudo em segundo plano e com cache.
const generoCache = new Map();   // "artista|titulo" -> tag ('' = não achou)
const generoBusca = new Set();
function tagGenero(nome) {
  const n = String(nome || '').toLowerCase();
  if (/metal|hard rock|punk|hardcore/.test(n)) return 'metal';
  if (/rock|alternativ|indie|grunge/.test(n)) return 'rock';
  if (/rap|hip.?hop|trap/.test(n)) return 'rap';
  if (/dance|electro|eletr|house|techno|edm|trance/.test(n)) return 'eletro';
  if (/jazz|blues|classic|clássic|soul|opera|ópera|instrumental/.test(n)) return 'jazz';
  if (/reggae|ska|dub/.test(n)) return 'reggae';
  if (/brasil|brazil|sertanej|samba|pagode|mpb|funk|forr|axé|axe|bossa|country|folk/.test(n)) return 'br';
  if (/pop|k-pop|r&b|latin|latina/.test(n)) return 'pop';
  return '';
}
async function buscarGenero(chave, t, a) {
  try {
    const q = 'track:"' + t.replace(/["]/g, ' ') + '" artist:"' + a.replace(/["]/g, ' ') + '"';
    const r1 = await axios.get('https://api.deezer.com/search', { params: { limit: 1, q }, timeout: 6000 });
    const alb = r1.data && r1.data.data && r1.data.data[0] && r1.data.data[0].album && r1.data.data[0].album.id;
    let tag = '';
    if (alb) {
      const r2 = await axios.get('https://api.deezer.com/album/' + alb, { timeout: 6000 });
      const gs = (r2.data && r2.data.genres && r2.data.genres.data) || [];
      for (const g of gs) { tag = tagGenero(g.name); if (tag) break; }
    }
    generoCache.set(chave, tag);
  } catch (e) {
    generoCache.set(chave, '');
  } finally {
    generoBusca.delete(chave);
    if (generoCache.size > 500) generoCache.delete(generoCache.keys().next().value);
  }
}
function generoDe(t, a) {
  if (!t) return '';
  const chave = (a + '|' + t).toLowerCase().slice(0, 200);
  if (generoCache.has(chave)) return generoCache.get(chave);
  if (!generoBusca.has(chave) && generoBusca.size < 4) { generoBusca.add(chave); buscarGenero(chave, t, a); }
  return '';
}

function lerNp(req, res) {
  const aut = autorizarAparelho(req, 150);
  if (!aut.ok) return negarAparelho(res, aut);
  const codigo = normalizarCodigo(req.headers['x-lyricat-code']);
  if (!codigoValido(codigo)) return res.status(400).json({ ok: 0, error: 'código inválido' });
  if (!limiteIp(req, 240)) return res.status(429).json({ ok: 0 });
  marcarCodigoVisto(codigo);
  guardarIpLocal(codigo, String(req.headers['x-lyricat-ip'] || '').trim());
  // 1.7: comando pendente do app (controle remoto) e pedido de "manda a sua configuração"
  const extra = {};
  const cm = tomarCmd(codigo);
  if (cm) extra.cmd = cm;
  if (cfgQuer.delete(codigo)) extra.cfg = 1;
  const enviar = (o) => res.json(Object.assign(o, extra));
  const slot = slotAtual(codigo);
  if (!slot) return enviar({ ok: 0, off: 1, n: 5000 });          // nenhuma ponte falou ainda
  const agora = Date.now();
  const s = melhorFonte(slot, agora);
  if (!s) return enviar({ ok: 0, off: 1, n: 5000, age: Math.round((agora - slot.ts) / 1000) });
  const idade = agora - s.ts;
  const ca = capasApp.get(codigo);
  const capaDoApp = ca && ca.k === chaveCapaApp(s.t, s.a) ? ca : null;
  const pos = s.pl ? Math.min(s.d || Infinity, s.p + idade) : s.p;   // compensa o tempo desde o último aviso
  const base = (req.get('x-forwarded-proto') || req.protocol || 'https') + '://' + req.get('host');
  return enviar({
    ok: 1,
    id: idSintetico(s.a, s.t, Math.round(s.d / 1000)),
    t: s.t, a: s.a, al: s.al, d: s.d, p: Math.round(pos), pl: s.pl ? 1 : 0, v: s.v ? 1 : 0,
    c: capaDoApp ? base + '/api/ucover/' + codigo + '/' + capaDoApp.ver : (s.c ? base + '/api/cover?u=' + encodeURIComponent(s.c.url) : ''),
    cw: capaDoApp ? capaDoApp.w : (s.c ? s.c.w : 0), ch: capaDoApp ? capaDoApp.h : (s.c ? s.c.h : 0),
    src: s.src, lb: s.lb || '', k: s.k | 0, age: Math.round(idade / 1000),
    gn: s.k === 0 ? generoDe(s.t, s.a) : '',
    n: s.pl ? 0 : 3500      // dica de próxima consulta (ms): pausado/ocioso consulta menos; 0 = intervalo normal
  });
}

// Cache pequeno de capas (LRU simples) para não bater no Google a cada música repetida.
const capaCache = new Map();
const CAPA_CACHE_MAX = 60;
async function servirCapa(req, res) {
  try {
    if (!limiteIp(req, 240)) return res.status(429).end();
    const aj = ajustarCapa(req.query.u);
    if (!aj || aj.url !== String(req.query.u)) return res.status(400).end();
    let buf = capaCache.get(aj.url);
    if (!buf) {
      const r = await axios.get(aj.url, {
        responseType: 'arraybuffer', timeout: 8000, maxRedirects: 0, maxContentLength: 300000,
        validateStatus: (s) => s === 200, headers: { 'User-Agent': USER_AGENT }
      });
      buf = Buffer.from(r.data);
      // JPEG progressivo (marcador SOF2 = FFC2) o decodificador do aparelho não lê.
      if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return res.status(502).end();
      for (let i = 2; i < buf.length - 1; i++) { if (buf[i] === 0xFF && buf[i + 1] === 0xC2) return res.status(502).end(); }
      capaCache.set(aj.url, buf);
      if (capaCache.size > CAPA_CACHE_MAX) capaCache.delete(capaCache.keys().next().value);
    }
    res.set({ 'Content-Type': 'image/jpeg', 'Content-Length': String(buf.length), 'Cache-Control': 'public, max-age=86400' });
    return res.end(buf);
  } catch (err) {
    console.error('⚠️ capa:', err.message);
    return res.status(502).end();
  }
}


// ---- Controle remoto pelo app (funciona fora de casa, via 4G) ----
// O app grava um comando aqui; o aparelho o recebe na próxima consulta normal (/api/np) e devolve a sua
// configuração em /api/device/cfg. Só ajustes de aparência/comportamento: nada de Wi-Fi, senha ou reset.
const cmdPend = new Map();    // código -> { set, ts }
const cfgSnap = new Map();    // código -> { cfg, ts }
const cfgQuer = new Map();    // código -> ts (o app pediu uma configuração fresca)
const CMD_FAIXAS = { blPct: [10, 100], font: [0, 9], humor: [0, 12], fala: [0, 2], anim: [0, 4], offG: [-1000, 4000], instrIc: [0, 5], pausa: [0, 60],
  gato: [0, 2], tela: [0, 1], acao: [0, 16], acc: [0, 8191], soneca: [0, 240],
  modo: [0, 1], perfil: [1, 2], idleD: [0, 60], idleK: [0, 60], tz: [-12, 14], fb: [0, 2], fbMask: [0, 31] };
const CMD_BOOLS = ['brain', 'ink', 'bat', 'cSoft', 'lyrS', 'vidL', 'instr', 'gLetra'];
const CMD_TEXTOS = { nome: 24, fbText: 180, iT0: 40, iT1: 40, iT2: 40, iT3: 40 };   // texto livre: sem caracteres de controle, tamanho limitado
function validarCmd(b) {
  const out = {};
  if (!b || typeof b !== 'object') return out;
  for (const [k, [lo, hi]] of Object.entries(CMD_FAIXAS)) {
    if (b[k] === undefined) continue;
    const n = Math.round(Number(b[k]));
    if (Number.isFinite(n)) out[k] = Math.max(lo, Math.min(hi, n));
  }
  for (const k of CMD_BOOLS) if (b[k] !== undefined) out[k] = b[k] === true || b[k] === 1 || b[k] === '1';
  for (const [k, max] of Object.entries(CMD_TEXTOS)) {
    if (typeof b[k] === 'string') out[k] = b[k].replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  }
  if (Array.isArray(b.cores) && (b.cores.length === 12 || b.cores.length === 13) && b.cores.every((c) => /^#?[0-9a-fA-F]{6}$/.test(String(c)))) {
    out.cores = b.cores.map((c) => '#' + String(c).replace('#', '').toUpperCase());
  }
  return out;
}
function tomarCmd(codigo) {
  const c = cmdPend.get(codigo);
  if (!c) return null;
  cmdPend.delete(codigo);
  return Date.now() - c.ts > 10 * 60 * 1000 ? null : c.set;     // comando velho demais não vale mais
}
app.post('/api/app/cmd', (req, res) => {
  const codigo = normalizarCodigo(req.headers['x-lyricat-code']);
  if (!codigoValido(codigo)) return res.status(401).json({ ok: 0, error: 'código inválido' });
  if (!limiteIp(req, 90)) return res.status(429).json({ ok: 0, error: 'devagar' });
  const set = validarCmd(req.body);
  if (!Object.keys(set).length) return res.status(400).json({ ok: 0, error: 'nada para aplicar' });
  const ant = cmdPend.get(codigo);
  if (ant) {                                                     // junta comandos: o mais novo substitui
    Object.assign(ant.set, set);
    ant.ts = Date.now();
  } else {
    if (cmdPend.size > 5000) cmdPend.clear();
    cmdPend.set(codigo, { set, ts: Date.now() });
  }
  cfgQuer.set(codigo, Date.now());                               // e já pede a configuração nova de volta
  const visto = codigoVisto.get(codigo);
  return res.json({ ok: 1, aparelho: visto ? Math.round((Date.now() - visto) / 1000) : -1 });
});
app.get('/api/app/cfg', (req, res) => {
  const codigo = normalizarCodigo(req.headers['x-lyricat-code']);
  if (!codigoValido(codigo)) return res.status(401).json({ ok: 0, error: 'código inválido' });
  if (!limiteIp(req, 180)) return res.status(429).json({ ok: 0, error: 'devagar' });
  const agora = Date.now();
  const visto = codigoVisto.get(codigo);
  const aparelho = visto ? Math.round((agora - visto) / 1000) : -1;
  const c = cfgSnap.get(codigo);
  if (!c || agora - c.ts > 20000) { if (cfgQuer.size > 5000) cfgQuer.clear(); cfgQuer.set(codigo, agora); }
  if (!c) return res.json({ ok: 0, aparelho });
  return res.json({ ok: 1, cfg: c.cfg, age: Math.round((agora - c.ts) / 1000), aparelho, pend: cmdPend.has(codigo) });
});
app.post('/api/device/cfg', (req, res) => {
  const aut = autorizarAparelho(req, 60);
  if (!aut.ok) return negarAparelho(res, aut);
  const codigo = normalizarCodigo(req.headers['x-lyricat-code']);
  if (!codigoValido(codigo)) return res.status(400).json({ ok: 0, error: 'código inválido' });
  const b = req.body;
  if (!b || typeof b !== 'object' || JSON.stringify(b).length > 3000) return res.status(400).json({ ok: 0 });
  if (cfgSnap.size > 5000) cfgSnap.clear();
  cfgSnap.set(codigo, { cfg: b, ts: Date.now() });
  return res.json({ ok: 1 });
});


// ---- Página de controle remoto (iPhone e qualquer navegador): https://SERVIDOR/remoto ----
// Mesma interface da aba "Controle" da extensão (fonte: lyricat-extension/remoto.js). Usa os mesmos comandos do app.
const REMOTO_HTML = "<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<title>LyricAT Remoto</title>\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\"><meta name=\"mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-title\" content=\"LyricAT\"><meta name=\"apple-mobile-web-app-status-bar-style\" content=\"default\">\n<link rel=\"apple-touch-icon\" href=\"/remoto/icon.png\"><link rel=\"icon\" href=\"/remoto/icon.png\">\n<style>\n:root{--papel:#EFEDE5;--cartao:#FFFDF7;--secao:#fff;--bege:#F7F4EA;--tinta:#111;--cinza:#6A6963}\n@media (prefers-color-scheme:dark){:root{--papel:#141412;--cartao:#1D1D1A;--secao:#252521;--bege:#2C2C27;--tinta:#EFEDE5;--cinza:#A5A399}}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--papel);color:var(--tinta);font:14px ui-monospace,Menlo,Consolas,monospace;padding:max(14px,env(safe-area-inset-top)) 14px 40px}\n.cartao{max-width:520px;margin:0 auto;background:var(--cartao);border:2px solid var(--tinta);box-shadow:6px 6px 0 var(--tinta);padding:14px}\n.topo{display:flex;align-items:center;gap:10px;margin-bottom:10px}.topo img{width:40px;height:40px;border:2px solid var(--tinta);padding:2px}\nh1{font-size:19px;margin:0}.sub{font-size:11px;color:var(--cinza)}\ninput.cod{width:100%;padding:10px;border:1px solid var(--tinta);background:var(--secao);color:var(--tinta);font:16px ui-monospace,Menlo,monospace;letter-spacing:1px;text-transform:uppercase;border-radius:0}\nbutton.principal{margin-top:10px;width:100%;padding:11px;border:1px solid var(--tinta);background:var(--tinta);color:var(--cartao);font:700 14px ui-monospace,Menlo,monospace;border-radius:0}\na.troca{display:block;margin-top:14px;color:var(--cinza);font-size:12px}\n.lr .b{padding:10px 11px;font-size:13px}\n</style></head><body><div class=\"cartao\">\n<div class=\"topo\"><img src=\"/remoto/icon.png\" alt=\"\"><div><h1>LyricAT Remoto</h1><div class=\"sub\">controle do aparelho pelo navegador</div></div></div>\n<div id=\"entrada\" style=\"display:none\"><label>Código de pareamento<br><small class=\"sub\">está no painel lyricat.local ou no app</small></label><br><br>\n<input class=\"cod\" id=\"cod\" maxlength=\"14\" placeholder=\"XXXX-XXXX-XXXX\" autocomplete=\"off\" spellcheck=\"false\"><button class=\"principal\" id=\"ok\" type=\"button\">Entrar</button>\n<p class=\"sub\" style=\"margin-top:14px\">No iPhone: toque em Compartilhar e depois em \"Adicionar à Tela de Início\" para virar um app.</p></div>\n<div id=\"painel\" style=\"display:none\"><div id=\"remoto\"></div><a class=\"troca\" id=\"troca\" href=\"#\">Trocar de código</a></div>\n</div>\n<script>\n// LyricAT Remoto: controle do aparelho pelo servidor (mesmos comandos do app Android).\n// Usado pelo popup da extensão (aba \"Controle\") e pela página /remoto do servidor (iPhone e qualquer navegador).\n// LyricRemoto.iniciar(elemento, { base: () => 'https://...', codigo: () => 'XXXXXXXXXXXX' })\n(function () {\n  var HUMORES = ['Auto', 'Calmo', 'Sarcástico', 'Sonolento', 'Energético', 'DJ', 'Caótico', 'Nerd', 'Dramático', 'Rabugento', 'Fofo', 'Gremlin', 'Secretário'];\n  var ACOES = ['Dançar', 'Bocejar', 'Acenar', 'Dormir', 'Alongar', 'Fone', 'Lamber pata', 'Coçar orelha', 'Caçar cauda', 'Relógio', 'Bater o pé', 'Caixote', 'Cantar', 'Guitarra', 'Bateria', 'DJ', 'Café'];\n  var SONECAS = [['Desligada', 0], ['15 min', 15], ['30 min', 30], ['60 min', 60], ['90 min', 90], ['2 horas', 120], ['4 horas', 240]];\n  var ROSTO = ['Nenhum', 'Óculos escuros', 'Óculos redondos', 'Bigode', 'Monóculo', 'Tapa-olho', 'Nariz de palhaço', 'Cavanhaque', 'Óculos de coração', 'Máscara de herói', 'Bigode de guidão', 'Óculos coloridos'];\n  var PESCOCO = ['Nenhum', 'Gravata borboleta', 'Cachecol', 'Medalha', 'Bandana', 'Capa de ombro', 'Gravata', 'Colar de pérolas', 'Coleira com sino', 'Colar havaiano', 'Fita', 'Estetoscópio', 'Corrente de ouro'];\n  var CABECA = ['Nenhum', 'Cartola', 'Coroa', 'Gorro de festa', 'Boné', 'Chapéu de bruxa', 'Chapéu de cowboy', 'Gorro de lã', 'Chapéu de chef', 'Boina', 'Auréola', 'Chifrinhos', 'Laço na orelha', 'Coroa de flores', 'Sombrero', 'Capacete viking'];\n  var LOOKS = [['Cowboy', 0, 5, 6], ['Chique', 3, 1, 1], ['Rockstar', 1, 3, 4], ['Realeza', 2, 2, 2]];\n  var PRESETS = [[\"Synthwave\",\"120a2b|ff3cac|2de2e6|b967ff|fff3fd|8e7cc3|ff3cac|2de2e6|ff3cac|2de2e6|1a0b3d|ff6ec7|ff3cac\"],[\"Cyberpunk\",\"0a0a0f|fcee0a|00f0ff|ff2a6d|fcee0a|7a7a8c|00f0ff|ff2a6d|fcee0a|00f0ff|0a0a0f|fcee0a|fcee0a\"],[\"Matrix\",\"000a00|00ff41|00cc33|008f26|39ff14|007a1f|00ff41|00ff41|008f26|39ff14|001a00|00ff41|00cc33\"],[\"Game Boy\",\"9bbc0f|0f380f|306230|306230|0f380f|306230|0f380f|0f380f|0f380f|0f380f|0f380f|9bbc0f|306230\"],[\"Sunset\",\"2b1055|ffb86b|ff6b6b|f7797d|fff1e0|c084fc|ff6b6b|ffb86b|ffb86b|ffd6a5|2b1055|ffb86b|c084fc\"],[\"Vaporwave\",\"2d1e5f|ff71ce|01cdfe|05ffa1|fffb96|b967ff|01cdfe|ff71ce|05ffa1|ff71ce|2d1e5f|01cdfe|05ffa1\"],[\"Dracula\",\"282a36|bd93f9|ff79c6|8be9fd|f8f8f2|6272a4|bd93f9|50fa7b|6272a4|ffb86c|282a36|f8f8f2|8be9fd\"],[\"Nord\",\"2e3440|88c0d0|81a1c1|5e81ac|eceff4|7b88a1|88c0d0|a3be8c|81a1c1|ebcb8b|2e3440|eceff4|88c0d0\"],[\"Solarized\",\"002b36|b58900|2aa198|268bd2|eee8d5|586e75|93a1a1|cb4b16|2aa198|d33682|002b36|fdf6e3|fdf6e3\"],[\"Terminal âmbar\",\"100800|ffb000|ff8c00|cc7000|ffcc33|995400|ffb000|ffb000|ff8c00|ffb000|100800|ffb000|ffcc33\"],[\"Sakura\",\"fff0f5|d81b60|ec407a|f48fb1|4a1c2f|b06a83|d81b60|ec407a|f06292|d81b60|4a1c2f|fff0f5|4a1c2f\"],[\"Oceano\",\"031e2e|4dd0e1|26c6da|80deea|e0f7fa|4f8a9c|4dd0e1|00e5ff|26c6da|ffcc80|03253a|4dd0e1|00e5ff\"],[\"Lava\",\"1a0000|ff3b00|ff7a00|ffb300|fff0d0|8a2b0a|ff3b00|ffb300|ff7a00|ffdd00|1a0000|ff7a00|fff0d0\"],[\"Halloween\",\"100a1a|ff7518|b026ff|39ff14|ffe8d0|6b4b8a|ff7518|b026ff|ff7518|39ff14|100a1a|ff7518|ffe8d0\"],[\"Menta\",\"e6fff5|00695c|00897b|26a69a|0b3d34|6aa89e|00897b|00bfa5|26a69a|00695c|0b3d34|e6fff5|0b3d34\"],[\"Sépia\",\"f4e4c1|5b3a1a|8b5a2b|a67c52|3e2410|8b7355|5b3a1a|8b5a2b|5b3a1a|5b3a1a|3e2410|f4e4c1|8b5a2b\"],[\"Barbie\",\"ffe0f0|e0218a|ff4fb0|ff85c8|6a0f47|c76a9d|e0218a|ff1493|e0218a|e0218a|6a0f47|ffe0f0|6a0f47\"],[\"AMOLED azul\",\"000000|ffffff|8ab4f8|5f8dd3|e8eaed|80868b|8ab4f8|8ab4f8|5f6368|8ab4f8|000000|ffffff|ffffff\"],[\"Arco-íris\",\"111111|ff4d4d|ffd24d|4dff88|4dd2ff|c44dff|ffd24d|4dff88|ff4d4d|c44dff|3a0ca3|f72585|4dff88\"],[\"Ouro e preto\",\"0b0b0b|d4af37|f1d27a|b8902d|fff3c4|7a6420|d4af37|d4af37|b8902d|f1d27a|0b0b0b|d4af37|b8902d\"],[\"Gelo\",\"eaf6ff|0d47a1|1976d2|42a5f5|0b2545|7ba3cc|1976d2|0d47a1|90caf9|1976d2|0b2545|eaf6ff|0b2545\"],[\"Lua de sangue\",\"0d0000|ff1a1a|c40000|8b0000|ffd6d6|5a1a1a|ff1a1a|c40000|8b0000|ff1a1a|0d0000|ff1a1a|ffd6d6\"],[\"Algodão-doce\",\"fdf2ff|7c4dff|ff6ec7|6ec6ff|3d2c6b|9a8cc2|7c4dff|ff6ec7|6ec6ff|ff6ec7|3d2c6b|ffd1f0|3d2c6b\"],[\"Clássico branco\",\"ffffff|000000|000000|000000|000000|000000|000000|000000|000000|000000|000000|ffffff|7f7f7f\"],[\"Papel\",\"fff7ef|000000|000000|000000|000000|636163|000000|000000|000000|000000|000000|fff7ef|636163\"],[\"Cinza claro\",\"eff3ef|000000|000000|000000|000000|636163|000000|000000|000000|000000|000000|eff3ef|636163\"],[\"Clássico escuro\",\"101010|ffffff|ffffff|ffffff|ffffff|ffffff|ffffff|ffffff|ffffff|ffffff|101010|ffffff|878787\"]];\n  function montar(r, p, c) { return (r & 15) | ((p & 15) << 4) | ((c & 31) << 8); }\n\n  var CSS = '.lr{font:13px ui-monospace,Menlo,Consolas,monospace;color:var(--tinta,#111)}' +\n    '.lr .st{padding:8px 10px;border:1px dashed var(--tinta,#111);background:var(--bege,#F7F4EA);margin-bottom:8px;line-height:1.4}' +\n    '.lr h3{margin:14px 0 6px;font-size:13px}' +\n    '.lr .fila{display:flex;flex-wrap:wrap;gap:5px}' +\n    '.lr .b{margin:0;width:auto;padding:7px 9px;font:12px ui-monospace,Menlo,Consolas,monospace;border:1px solid var(--tinta,#111);background:var(--secao,#fff);color:var(--tinta,#111);cursor:pointer;border-radius:0}' +\n    '.lr .b.on{background:var(--tinta,#111);color:var(--cartao,#FFFDF7);font-weight:700}' +\n    '.lr .b.g{flex:1 1 auto;text-align:center}' +\n    '.lr select{width:100%;padding:8px;margin:0 0 6px;border:1px solid var(--tinta,#111);background:var(--secao,#fff);color:var(--tinta,#111);font:13px ui-monospace,Menlo,monospace;text-transform:none;letter-spacing:0;border-radius:0}' +\n    '.lr .sw{display:inline-block;width:38px;height:22px;vertical-align:middle;border:1px solid var(--tinta,#111)}' +\n    '.lr .sw i{display:inline-block;width:25%;height:100%}' +\n    '.lr input[type=range]{width:100%;padding:0;margin:4px 0;text-transform:none;letter-spacing:0;border:0}' +\n    '.lr .p{font-size:11px;color:var(--cinza,#6A6963);margin-top:4px}';\n\n  function iniciar(raiz, opc) {\n    if (!document.getElementById('lr-css')) { var s = document.createElement('style'); s.id = 'lr-css'; s.textContent = CSS; document.head.appendChild(s); }\n    raiz.className = 'lr';\n    raiz.innerHTML = '';\n    var S = { gato: false, acao: -1, letra: true, modo: 0, humor: 0, soneca: 0, acc: 0, cores: [], nome: 'Meu LyricAT', bl: 100, bat: false, aparelho: -1, tem: false, erro: '' };\n    var bloq = {};\n    var reflexos = [];   // funções que repintam os botões conforme o estado\n    var pollTimer = null, blTimer = null;\n\n    var st = document.createElement('div'); st.className = 'st'; raiz.appendChild(st);\n\n    function base() { return String(opc.base()).replace(/\\/+$/, ''); }\n    function head(extra) { var h = { 'x-lyricat-code': opc.codigo() }; for (var k in (extra || {})) h[k] = extra[k]; return h; }\n    function trava(chaves) { chaves.forEach(function (k) { bloq[k] = Date.now() + 6000; }); }\n\n    function enviar(obj) {\n      trava(Object.keys(obj));\n      return fetch(base() + '/api/app/cmd', { method: 'POST', headers: head({ 'Content-Type': 'application/json' }), body: JSON.stringify(obj) })\n        .then(function (r) {\n          if (r.status === 429) { S.erro = 'Muitos comandos, aguarde um instante.'; pintar(); return; }\n          if (!r.ok) { S.erro = 'Servidor respondeu ' + r.status; pintar(); return; }\n          S.erro = '';\n          setTimeout(consultar, 1800); setTimeout(consultar, 5000);\n        }).catch(function () { S.erro = 'Sem conexão com o servidor.'; pintar(); });\n    }\n\n    function livre(k) { return !(bloq[k] && Date.now() < bloq[k]); }\n\n    function consultar() {\n      if (!opc.codigo() || opc.codigo().length !== 12) { st.textContent = 'Digite o código de pareamento na aba Música.'; return; }\n      fetch(base() + '/api/app/cfg', { headers: head() }).then(function (r) { return r.json(); }).then(function (j) {\n        S.aparelho = typeof j.aparelho === 'number' ? j.aparelho : -1;\n        if (j.ok === 1 && j.cfg && (j.age || 0) <= 20) {\n          var c = j.cfg; S.tem = true; S.nome = c.nome || S.nome;\n          if (livre('gato')) S.gato = c.gato === 1;\n          if (livre('soneca')) S.soneca = c.sn | 0;\n          if (livre('acao')) S.acao = typeof c.ac === 'number' ? c.ac : -1;\n          if (livre('gLetra')) S.letra = c.gLetra !== false;\n          if (livre('modo')) S.modo = c.modo === 1 ? 1 : 0;\n          if (livre('humor')) S.humor = c.humor | 0;\n          if (livre('acc')) S.acc = (c.acc | 0) & 8191;\n          if (livre('bat')) S.bat = c.bat === true;\n          if (livre('blPct') && typeof c.blPct === 'number') S.bl = c.blPct;\n          if (livre('cores') && Array.isArray(c.cores)) S.cores = c.cores.map(function (x) { return String(x).replace('#', '').toLowerCase(); });\n        }\n        S.erro = ''; pintar();\n      }).catch(function () { S.erro = 'Sem conexão com o servidor.'; pintar(); });\n    }\n\n    function botao(txt, aoClicar, ativo, extraCls) {\n      var b = document.createElement('button'); b.type = 'button'; b.className = 'b ' + (extraCls || ''); b.textContent = txt;\n      b.addEventListener('click', aoClicar);\n      reflexos.push(function () { b.classList.toggle('on', !!ativo()); });\n      return b;\n    }\n    function titulo(t) { var h = document.createElement('h3'); h.textContent = t; raiz.appendChild(h); }\n    function fila() { var f = document.createElement('div'); f.className = 'fila'; raiz.appendChild(f); return f; }\n\n    // Modo\n    titulo('Orientação');\n    var f = fila();\n    ['Desktop', 'Chaveiro'].forEach(function (n, i) {\n      f.appendChild(botao(n, function () { S.modo = i; enviar({ modo: i }); pintar(); }, function () { return S.modo === i; }, 'g'));\n    });\n    // Gato\n    titulo('Gato');\n    f = fila();\n    f.appendChild(botao('Trocar para o gato / voltar', function () { S.gato = !S.gato; enviar({ gato: 2 }); pintar(); }, function () { return S.gato; }, 'g'));\n    f.appendChild(botao('Letra no gato', function () { S.letra = !S.letra; enviar({ gLetra: S.letra }); pintar(); }, function () { return S.letra; }, 'g'));\n    titulo('Fazer o gato...');\n    f = fila();\n    ACOES.forEach(function (n, i) {\n      f.appendChild(botao(n, function () { S.gato = true; S.acao = i; enviar({ acao: i }); pintar(); }, function () { return S.acao === i; }));\n    });\n    titulo('Humor');\n    f = fila();\n    HUMORES.forEach(function (n, i) { f.appendChild(botao(n, function () { S.humor = i; enviar({ humor: i }); pintar(); }, function () { return S.humor === i; })); });\n    titulo('Soneca: apagar a tela em...');\n    f = fila();\n    SONECAS.forEach(function (p) { f.appendChild(botao(p[0], function () { S.soneca = p[1]; enviar({ soneca: p[1] }); pintar(); }, function () { return S.soneca === p[1]; })); });\n\n    // Vestir\n    titulo('Vestir o gato');\n    function seletor(lista, get, set) {\n      var sel = document.createElement('select');\n      lista.forEach(function (n, i) { var o = document.createElement('option'); o.value = i; o.textContent = n; sel.appendChild(o); });\n      sel.addEventListener('change', function () { set(parseInt(sel.value, 10)); S.acc = montar(S.acc & 15, (S.acc >> 4) & 15, (S.acc >> 8) & 31); });\n      reflexos.push(function () { if (document.activeElement !== sel) sel.value = get(); });\n      raiz.appendChild(sel);\n    }\n    function aplicarAcc(r, p, c) { S.acc = montar(r, p, c); enviar({ acc: S.acc }); pintar(); }\n    var lb = document.createElement('div'); lb.className = 'p'; lb.textContent = 'Cabeça'; raiz.appendChild(lb);\n    seletor(CABECA, function () { return (S.acc >> 8) & 31; }, function (v) { aplicarAcc(S.acc & 15, (S.acc >> 4) & 15, v); });\n    lb = document.createElement('div'); lb.className = 'p'; lb.textContent = 'Rosto'; raiz.appendChild(lb);\n    seletor(ROSTO, function () { return S.acc & 15; }, function (v) { aplicarAcc(v, (S.acc >> 4) & 15, (S.acc >> 8) & 31); });\n    lb = document.createElement('div'); lb.className = 'p'; lb.textContent = 'Pescoço'; raiz.appendChild(lb);\n    seletor(PESCOCO, function () { return (S.acc >> 4) & 15; }, function (v) { aplicarAcc(S.acc & 15, v, (S.acc >> 8) & 31); });\n    f = fila();\n    LOOKS.forEach(function (l) { f.appendChild(botao(l[0], function () { aplicarAcc(l[1], l[2], l[3]); }, function () { return S.acc === montar(l[1], l[2], l[3]); })); });\n    f.appendChild(botao('Tirar tudo', function () { aplicarAcc(0, 0, 0); }, function () { return false; }));\n\n    // Cores\n    titulo('Tema de cores');\n    f = fila();\n    PRESETS.forEach(function (p) {\n      var cs = p[1].split('|');\n      var b = botao(p[0], function () {\n        S.cores = cs.slice(); enviar({ cores: cs.map(function (x) { return '#' + x; }) }); pintar();\n      }, function () { return S.cores.length >= 12 && S.cores.slice(0, 12).join('|') === cs.slice(0, 12).join('|'); });\n      var sw = document.createElement('span'); sw.className = 'sw'; sw.style.marginRight = '6px';\n      [cs[0], cs[1], cs[2], cs[9]].forEach(function (x) { var i = document.createElement('i'); i.style.background = '#' + x; sw.appendChild(i); });\n      b.insertBefore(sw, b.firstChild);\n      f.appendChild(b);\n    });\n\n    // Brilho\n    titulo('Brilho da tela');\n    var rg = document.createElement('input'); rg.type = 'range'; rg.min = 10; rg.max = 100; rg.step = 5; rg.value = 100;\n    rg.addEventListener('input', function () {\n      S.bl = parseInt(rg.value, 10); trava(['blPct']);\n      clearTimeout(blTimer); blTimer = setTimeout(function () { enviar({ blPct: S.bl }); }, 350);\n    });\n    reflexos.push(function () { if (document.activeElement !== rg) rg.value = S.bl; });\n    raiz.appendChild(rg);\n    titulo('Energia');\n    f = fila();\n    f.appendChild(botao('Modo bateria', function () { S.bat = !S.bat; enviar({ bat: S.bat }); pintar(); }, function () { return S.bat; }, 'g'));\n    var nb = document.createElement('div'); nb.className = 'p'; nb.textContent = 'Brilho máx. 40%, tela apaga em 2 min, Wi-Fi econômico.'; raiz.appendChild(nb);\n    var nota = document.createElement('div'); nota.className = 'p'; nota.textContent = 'Os comandos passam pelo servidor e chegam ao aparelho em alguns segundos. Wi-Fi, senha e reset ficam só no painel lyricat.local.'; raiz.appendChild(nota);\n\n    function pintar() {\n      var on = S.aparelho >= 0 && S.aparelho <= 30;\n      st.textContent = S.erro ? ('! ' + S.erro) : (S.aparelho < 0 ? '● nenhum aparelho leu este código ainda' : (on ? '● online · ' + S.nome : '● offline · ' + S.nome + ' (última consulta há ' + S.aparelho + ' s)'));\n      reflexos.forEach(function (fn) { fn(); });\n    }\n    pintar();\n    consultar();\n    pollTimer = setInterval(consultar, 4000);\n    return { parar: function () { clearInterval(pollTimer); }, atualizar: consultar };\n  }\n  window.LyricRemoto = { iniciar: iniciar };\n})();\n\n</script>\n<script>\n(function(){\n  function limpar(c){return String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,12)}\n  function fmt(c){return limpar(c).replace(/(.{4})(?=.)/g,'$1-')}\n  function ler(){try{return limpar(localStorage.getItem('lyricatCodigo'))}catch(e){return ''}}\n  var codigo=ler(),ativo=null;\n  var m=(location.hash||'').match(/lyricat=([A-Za-z0-9-]+)/);\n  if(m&&limpar(m[1]).length===12){codigo=limpar(m[1]);try{localStorage.setItem('lyricatCodigo',codigo)}catch(e){}history.replaceState(null,'',location.pathname)}\n  function mostrar(){\n    var tem=codigo.length===12;\n    document.getElementById('entrada').style.display=tem?'none':'';\n    document.getElementById('painel').style.display=tem?'':'none';\n    if(ativo){ativo.parar();ativo=null;document.getElementById('remoto').innerHTML=''}\n    if(tem)ativo=LyricRemoto.iniciar(document.getElementById('remoto'),{base:function(){return location.origin},codigo:function(){return codigo}});\n  }\n  document.getElementById('cod').addEventListener('input',function(e){e.target.value=fmt(e.target.value)});\n  document.getElementById('ok').addEventListener('click',function(){\n    var c=limpar(document.getElementById('cod').value);\n    if(c.length!==12){alert('O código tem 12 letras/números.');return}\n    codigo=c;try{localStorage.setItem('lyricatCodigo',c)}catch(e){}mostrar();\n  });\n  document.getElementById('troca').addEventListener('click',function(e){e.preventDefault();codigo='';try{localStorage.removeItem('lyricatCodigo')}catch(x){}mostrar()});\n  mostrar();\n})();\n</script></body></html>";
const REMOTO_ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAWfmNhQlgAABZ+anVtYgAAAB5qdW1kYzJwYQARABCAAACqADibcQNjMnBhAAAAFlhqdW1iAAAAR2p1bWRjMm1hABEAEIAAAKoAOJtxA3VybjpjMnBhOjIzNTFhNzE5LWFjNGItNDQ4MS04ZDU2LWVjNjgxZGE2Zjk1OAAAAAOTanVtYgAAAClqdW1kYzJhcwARABCAAACqADibcQNjMnBhLmFzc2VydGlvbnMAAAAAuGp1bWIAAABEanVtZGNib3IAEQAQgAAAqgA4m3ETYzJwYS5pbmdyZWRpZW50LnYzAAAAABhjMnNoe4eA3SXf2Y6u1BbEJLRe1wAAAGxjYm9yo2lkYzpmb3JtYXRpaW1hZ2UvcG5namluc3RhbmNlSUR4LHhtcDppaWQ6NjA5OTgwM2QtZTJjNi00MTgwLWE4N2YtODgwZWIyMWJjOGE5bHJlbGF0aW9uc2hpcGhwYXJlbnRPZgAAAeJqdW1iAAAAQWp1bWRjYm9yABEAEIAAAKoAOJtxE2MycGEuYWN0aW9ucy52MgAAAAAYYzJzaNgFWdWcF+1dXnR4rTxxYmoAAAGZY2JvcqJnYWN0aW9uc4KiZmFjdGlvbmtjMnBhLm9wZW5lZGpwYXJhbWV0ZXJzoWtpbmdyZWRpZW50c4GiY3VybHgtc2VsZiNqdW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5pbmdyZWRpZW50LnYzZGhhc2hYIDKlh7BsCCAujEZiQ1d7UqY61I/T9Rsgblw9juMHzu0/pGZhY3Rpb254HWNvbS5hbnRocm9waWMuY2xhdWRlLnByb3ZpZGVkanBhcmFtZXRlcnOheB9jb20uYW50aHJvcGljLm9yaWdpbi1jb25maWRlbmNlZ3Vua25vd25rZGVzY3JpcHRpb254ZkNsYXVkZSBwcm92aWRlZCB0aGlzIGZpbGUgYXQgdGhlIHJlcXVlc3Qgb2YgYSB1c2VyIGFuZCBtYXkgaGF2ZSBjcmVhdGVkIG9yIG1vZGlmaWVkIHRoZSBmaWxlIGNvbnRlbnRzLm1zb2Z0d2FyZUFnZW50oWRuYW1lZkNsYXVkZXJhbGxBY3Rpb25zSW5jbHVkZWT1AAAAyGp1bWIAAABAanVtZGNib3IAEQAQgAAAqgA4m3ETYzJwYS5oYXNoLmRhdGEAAAAAGGMyc2hBZGMHMBP+TkofK4It9ZO+AAAAgGNib3KlY2FsZ2ZzaGEyNTZjcGFkTQAAAAAAAAAAAAAAAABkaGFzaFgg9THv+OWPjRyYc/HAe+Oro3bejLOxOPNAUsBP7uT60oVkbmFtZW5qdW1iZiBtYW5pZmVzdGpleGNsdXNpb25zgaJlc3RhcnQYIWZsZW5ndGgZFooAAAI+anVtYgAAACdqdW1kYzJjbAARABCAAACqADibcQNjMnBhLmNsYWltLnYyAAAAAg9jYm9ypWNhbGdmc2hhMjU2aXNpZ25hdHVyZXhNc2VsZiNqdW1iZj0vYzJwYS91cm46YzJwYToyMzUxYTcxOS1hYzRiLTQ0ODEtOGQ1Ni1lYzY4MWRhNmY5NTgvYzJwYS5zaWduYXR1cmVqaW5zdGFuY2VJRHgseG1wOmlpZDphZDY2MWMyNS05MmE1LTQ3MWEtOWUxZi1jZGIxODdkZDk2NzFyY3JlYXRlZF9hc3NlcnRpb25zg6JjdXJseC1zZWxmI2p1bWJmPWMycGEuYXNzZXJ0aW9ucy9jMnBhLmluZ3JlZGllbnQudjNkaGFzaFggMqWHsGwIIC6MRmJDV3tSpjrUj9P1GyBuXD2O4wfO7T+iY3VybHgqc2VsZiNqdW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5hY3Rpb25zLnYyZGhhc2hYINsdHbgieAs53ftNSbDsibAyCChu2IfBNYShyvOH8BO6omN1cmx4KXNlbGYjanVtYmY9YzJwYS5hc3NlcnRpb25zL2MycGEuaGFzaC5kYXRhZGhhc2hYIH8CXLrPCvbcJJpyRG/j883JNEiwWpk9E2wji7/PRfG2dGNsYWltX2dlbmVyYXRvcl9pbmZvo2RuYW1lb0FudGhyb3BpYyBGaWxlc2d2ZXJzaW9uZTEuMC4wa3NwZWNWZXJzaW9uZTIuNC4wAAAQOGp1bWIAAAAoanVtZGMyY3MAEQAQgAAAqgA4m3EDYzJwYS5zaWduYXR1cmUAAAAQCGNib3LShFkCEqIBJhghWQIKMIICBjCCAY2gAwIBAgIUQOWgCu7COdC+uIP6BkIFPWdVEwAwCgYIKoZIzj0EAwMwSTEXMBUGA1UEChMOQW50aHJvcGljLCBQQkMxLjAsBgNVBAMTJUFudGhyb3BpYyBDb250ZW50IENyZWRlbnRpYWxzIFJvb3QgQ0EwHhcNMjYwODA3MTg0MzU2WhcNMjgwODA2MTk0MzU2WjBEMRcwFQYDVQQKEw5BbnRocm9waWMsIFBCQzEpMCcGA1UEAxMgQW50aHJvcGljIENsYXVkZSBDb250ZW50IFNpZ25pbmcwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASYegpry1AYBRTVNL1CpTlbROnY3dey+UrsF9C3phYrATN3ZHf93Mo8RQN0KOUuOn19P4oWNFWe5n2/She9N7eTo1gwVjAOBgNVHQ8BAf8EBAMCB4AwFQYDVR0lBA4wDAYKKwYBBAGD6F4CATAMBgNVHRMBAf8EAjAAMB8GA1UdIwQYMBaAFM5R4gSBTmRbI/jjxM+aPpzB11zCMAoGCCqGSM49BAMDA2cAMGQCMDFzHRSeAXrSy1WOzkbhPZ6Km2wGTmZ/2gK18k8BQGXyqz88Rdrz6CTX9flAnYNVxgIwcF9c3fVhqmJKpi+UhasNUMko69cyX6STPfta3Q8EjyzDjzoyrol46FP6VFHhvUcJoWNwYWRZDZ4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2WEBzCwJPXUKFaPMWqNrB3dr8Geiyc8mfwvByPtoY77TnUn+tK560PiL/nErlUCqJiXXpNHeMb8jJur1OeLgHrwR3TcJsqwAABDxJREFUeJztnEtypEAMRNUdc4F2eOX7n21WDnOEmYWjHDTmo4KqVmYp324mbBDKVwK6DTfrwOPx+Ndju9mZpunWeptNNqjAY2ghxKUNKHgMrohw6hcVPCZnRKj6BQXPQY0Id+8PKnwearJyCaDw+fBmdiiAwufFk92uAAqfn6MMNwVQ+OOwl+WqAAp/PLYy/SWAwh+XtWzdt4FiTJ4E0Oofn2XGmgDJ+RFAqz8P86w1AZJzN9Pqz0jJXBMgORQCfH3+jS6hGpaaKQQw42moGVetN/Tz/7KZb+8fQZX4YKuXZgIUkFcXcm1b0Akg2gItwNaKQlxpTLXOgRZgD6TGItVSC60AZhiNR6jhCtQCmMUG4N03siSwAtQ0LaLByKHWACtALa8MZJTwzQYSAB1UaSAFONusVzQZNcizQApwhZ4BjRa+2YACmPUJqsU2EQWCE6BVk1o2GzG4VsAJ0BLEVYsm09ACmF1rOFpYPYASoFfDz2w3Q/hmYAJkAUmuNAKgf7QcBYwAKB/iZArfDEiAV7EXcMbvE/5EFxABSvMRSDcBxDMQAmRdkQjHDSGAiINCgLf3D/gHLJaw1Bz+ZNDaGFxrHMK4rMV7HJGiQNwFHDWAMXyz77qXx7b8d/SxhU+AI6Ib1ALkUwG0AGfD79lwxJquACtAbaMjGsxQ4xGQAtQ0FqGpbPXOgbsNZGxmTR1o1zRwAnhBCb+AVo8XKAG8qwO12d66kKYAlAAeUMMvoNe3BOYi0LMq5s2N/ETNs+/a44mCZgIchb/3/y3x7hshXA8QArT8e73IR8Nq941wLQAhwBFlNUW+kOHMvhmmAIUAoh8SIDnhAhyNVoYxugf6V93hAohYqATwToMeUyNy3z2hEsDsuME9A4jcdy/oBDDbbvQrAojcdw8g/ibwDJENZw17DcoJINohAZIjAZIjAZIjAZIjAZIjAZITLgD6lyVXQf+yK1wAEYsESA6FAKynAYa6IQSIPg9GgXDcEAJ4YFhNc1jqhRHAsxpYmsryUIgZkABe0CVAr28JlACMD1fOYXy4FUqAGtAkQKvHC5wAjC9bYHypRQHm6eAlDO/fYajxCFgBzDDfyIVY0xWgBTDDGfNXQA3fDPAaYAly8zyg1w8vgBl+E7dgqJtCADOOZs5hqRf+GmAN5OsCluALlAIUkERgC75ALUAhUgTW4AtDCLCkpxDsgS8ZUgDhh+YuQPRBAiRHAiRHAiRHAiRHAiRHAiRHAiRHAiTnPk3TLboIEcM0TTdNgORIgORIgOTczb7PBdGFiNdSMtcESM6PAJoCeZhnrQmQnCcBNAXGZ5mxJkByfgmgKTAua9muTgBJMB5bmW6eAiTBOOxluXsNIAn4Ocrw8CJQEvDiyc51FyAJ+PBm5r4NlAQ81GR1KlQ9TobJmUV6aVVLBAyuTOcmY10ixNDitNzlvC4h+tDjOuw/QLnkCOm07qwAAAAASUVORK5CYII=', 'base64');
app.get(['/remoto', '/remoto/'], (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(REMOTO_HTML);
});
app.get('/remoto/icon.png', (req, res) => {
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(REMOTO_ICON);
});

app.post('/api/np', receberNp);
app.put('/api/np/cover', express.raw({ type: 'image/jpeg', limit: '64kb' }), receberCapaApp);
app.get('/api/ucover/:codigo/:ver', servirCapaApp);
app.get('/api/device/ip', (req, res) => {
  const codigo = normalizarCodigo(req.headers['x-lyricat-code']);
  if (!codigoValido(codigo)) return res.status(401).json({ ok: 0, error: 'código inválido' });
  if (!limiteIp(req, 120)) return res.status(429).json({ ok: 0, error: 'devagar' });
  const r = codigoIp.get(codigo);
  if (!r) return res.json({ ok: 0 });
  return res.json({ ok: 1, ip: r.ip, age: Math.round((Date.now() - r.ts) / 1000) });
});
app.get('/api/np', lerNp);
app.get('/api/cover', servirCapa);

// Para monitor de uptime (evita o Render Free dormir) e checagem rápida.
app.get('/health', (req, res) => res.send('ok'));

if (require.main === module) {
  iniciarBanco().then(iniciarAparelhos).then(iniciarClima);
  const PORT = process.env.PORT || 3000;
  const servidor = app.listen(PORT, () => console.log('🚀 Servidor protegido rodando na porta ' + PORT));
  servidor.keepAliveTimeout = 65000;   // conexões dos aparelhos podem ser reaproveitadas
  servidor.headersTimeout = 66000;
}

process.on('unhandledRejection', (e) => console.error('❌ unhandledRejection:', e && e.stack || e));
process.on('uncaughtException', (e) => console.error('❌ uncaughtException:', e && e.stack || e));

module.exports = { textoParaClima, CLIMAS, classificarClima, melhorFonte, validarCmd, tomarCmd, cmdPend, cfgSnap, guardarIpLocal, codigoIp, limparAparelhosInativos, receberCapaApp, servirCapaApp, capasApp, autorizarAparelho, aparelhos, hashSegredo, ajustarCapa, receberNp, lerNp, npSlots, idSintetico, prepararLetraParaTela, prepararTextoParaTela, normalizarPontuacao, norm, limparTitulo, montarChave, melhorDaBusca, buscarLetra, obterLetra, normalizarItem, ADMIN_HTML };
