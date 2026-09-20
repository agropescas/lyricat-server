const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// 🔒 CONEXÃO FORÇADA E INDEPENDENTE (IPv4 via Connection Pooler do Supabase)
const pool = new Pool({
  host: '://supabase.com', // Servidor do Pooler em São Paulo
  port: 6543,                                  // Porta correta do Pooler
  database: 'postgres',
  user: 'postgres.pmvoncwjjjbafmmieiaz',       // Usuário oficial com o ID do seu projeto
  password: process.env.DB_PASSWORD,           // Puxa a senha pura salva no Render
  ssl: { rejectUnauthorized: false }           // Exigido para conexões seguras na nuvem
});

// Essa função roda assim que o servidor liga. Cria a tabela se ela não existir no seu Supabase
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
    console.log("✅ Banco de dados e tabela verificados com sucesso!");
  } catch (err) {
    console.error("❌ Erro fatal ao iniciar tabela no banco:", err.message);
  }
}
iniciarBanco();

// Rota principal protegida por token para o seu ESP32
app.get('/api/lyrics', async (req, res) => {
  // 🔒 CHECAGEM DE SEGURANÇA: Verifica se a chave enviada pelo LyricAT bate com a do servidor
  const chaveRecebida = req.headers['x-lyricat-auth'];
  const chaveSecreta = process.env.LYRICAT_SECRET_TOKEN;

  if (!chaveRecebida || chaveRecebida !== chaveSecreta) {
    console.log("🚫 Tentativa de acesso bloqueada: Chave de API inválida ou ausente.");
    return res.status(401).json({ error: 'Não autorizado. Apenas aparelhos LyricAT configurados têm acesso.' });
  }

  const { track_id, artist, track, duration } = req.query;

  if (!track_id || !track || !artist) {
    return res.status(400).json({ error: 'Faltam dados obrigatórios (track_id, track, artist)' });
  }

  try {
    // 1. ETAPA: Procura primeiro no seu banco do Supabase pelo ID do Spotify
    const queryLocal = 'SELECT synced_lyrics FROM cache_letras WHERE track_id = \$1';
    const resLocal = await pool.query(queryLocal, [track_id]);

    if (resLocal.rows.length > 0) {
      console.log(`📦 Cache Hit (Evitou chamada externa!): ${track}`);
      return res.json({ syncedLyrics: resLocal[0].synced_lyrics });
    }

    // 2. ETAPA: Se não achou no banco, faz a busca na API pública do LRCLIB
    console.log(`🌐 Cache Miss (Buscando no LRCLIB...): ${track}`);
    const urlLrc = `https://lrclib.net{encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}&duration=${parseInt(duration || 0)}`;
    
    let syncedLyrics = "";
    try {
      const responseLrc = await axios.get(urlLrc, {
        headers: { 'User-Agent': 'LyricATUserCustomCache/1.0' },
        timeout: 4000
      });
      syncedLyrics = responseLrc.data.syncedLyrics || "";
    } catch (lrcErr) {
      console.log(`⚠️ Música não encontrada no LRCLIB ou erro na API externa.`);
    }

    // 3. ETAPA: Grava o resultado no seu banco (com a letra ou vazio) para proteger seu IP contra bans
    const querySalvar = 'INSERT INTO cache_letras (track_id, artist, track, synced_lyrics) VALUES (\$1, \$2, \$3, \$4) ON CONFLICT (track_id) DO NOTHING';
    await pool.query(querySalvar, [track_id, artist, track, syncedLyrics]);

    return res.json({ syncedLyrics });

  } catch (error) {
    console.error("❌ Erro interno no processamento:", error.message);
    return res.status(500).json({ syncedLyrics: "" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Servidor protegido rodando na porta " + PORT));
