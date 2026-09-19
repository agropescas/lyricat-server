const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Abre a conexão direta com o seu banco do Supabase através da URL que vamos configurar no Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Garante conexão segura SSL exigida na nuvem
});

// Essa função roda assim que o servidor liga. Ela cria a tabela se ela não existir no seu Supabase
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

// Rota principal que o seu ESP32 vai chamar passando os dados da música
app.get('/api/lyrics', async (req, res) => {
  const { track_id, artist, track, duration } = req.query;

  // Validação básica para o servidor não processar lixo
  if (!track_id || !track || !artist) {
    return res.status(400).json({ error: 'Faltam dados obrigatórios (track_id, track, artist)' });
  }

  try {
    // 1. ETAPA: Olha no seu Supabase usando o ID do Spotify
    const queryLocal = 'SELECT synced_lyrics FROM cache_letras WHERE track_id = \$1';
    const resLocal = await pool.query(queryLocal, [track_id]);

    if (resLocal.rows.length > 0) {
      console.log(`📦 Cache Hit (Evitou chamada externa!): ${track}`);
      return res.json({ syncedLyrics: resLocal.rows.synced_lyrics });
    }

    // 2. ETAPA: Se não achou no banco, faz a busca padrão no LRCLIB
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
      console.log(`⚠️ Música não encontrada no LRCLIB ou erro na API externa. Salvando como vazia para evitar novos Rate Limits.`);
    }

    // 3. ETAPA: Grava o resultado no seu banco (mesmo que vazio) para proteger seu IP contra futuros bans
    const querySalvar = 'INSERT INTO cache_letras (track_id, artist, track, synced_lyrics) VALUES (\$1, \$2, \$3, \$4) ON CONFLICT (track_id) DO NOTHING';
    await pool.query(querySalvar, [track_id, artist, track, syncedLyrics]);

    return res.json({ syncedLyrics });

  } catch (error) {
    console.error("❌ Erro interno no processamento:", error.message);
    return res.status(500).json({ syncedLyrics: "" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando redondinho na porta ${PORT}`));
