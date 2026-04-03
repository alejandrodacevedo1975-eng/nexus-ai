const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const db = new Database('nexus.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, model TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER, role TEXT, content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt TEXT, url TEXT, model TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const MODELS = [
  { id: 'meta-llama/llama-3.1-8b-instruct:free', name: 'Llama 3.1 8B', badge: 'GRATIS' },
  { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1', badge: 'GRATIS' },
  { id: 'mistralai/mistral-7b-instruct:free', name: 'Mistral 7B', badge: 'GRATIS' },
  { id: 'qwen/qwen-2.5-7b-instruct:free', name: 'Qwen 2.5 7B', badge: 'GRATIS' },
  { id: 'google/gemma-3-27b-it:free', name: 'Gemma 3 27B', badge: 'GRATIS' },
  { id: 'microsoft/phi-3-mini-128k-instruct:free', name: 'Phi-3 Mini', badge: 'GRATIS' },
  { id: 'openchat/openchat-7b:free', name: 'OpenChat 7B', badge: 'GRATIS' },
];

const IMAGE_MODELS = [
  { id: 'fal-ai/flux/schnell', name: 'Flux Schnell (rápido)' },
  { id: 'fal-ai/flux/dev', name: 'Flux Dev (calidad)' },
  { id: 'fal-ai/stable-diffusion-v3-medium', name: 'Stable Diffusion 3' },
];

app.post('/api/settings', (req, res) => {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(req.body.key, req.body.value);
  res.json({ ok: true });
});
app.get('/api/settings/:key', (req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(req.params.key);
  res.json({ value: row ? row.value : null });
});
app.get('/api/models', (req, res) => res.json(MODELS));
app.get('/api/image-models', (req, res) => res.json(IMAGE_MODELS));

app.get('/api/conversations', (req, res) =>
  res.json(db.prepare('SELECT * FROM conversations ORDER BY created_at DESC LIMIT 50').all()));
app.post('/api/conversations', (req, res) => {
  const result = db.prepare('INSERT INTO conversations (title, model) VALUES (?, ?)').run(req.body.title || 'Nueva conversación', req.body.model);
  res.json({ id: result.lastInsertRowid });
});
app.delete('/api/conversations/:id', (req, res) => {
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(req.params.id);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
app.get('/api/conversations/:id/messages', (req, res) =>
  res.json(db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(req.params.id)));

app.post('/api/chat', async (req, res) => {
  const { conversation_id, message, model } = req.body;
  const apiKeyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('openrouter_key');
  if (!apiKeyRow?.value) return res.status(400).json({ error: 'NO_API_KEY' });
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(conversation_id, 'user', message);
  const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?').get(conversation_id);
  if (msgCount.c === 1) db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(message.substring(0, 40), conversation_id);
  const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversation_id);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKeyRow.value}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://nexusai.app', 'X-Title': 'NexusAI' },
      body: JSON.stringify({ model: model || MODELS[0].id, messages: history.map(m => ({ role: m.role, content: m.content })), max_tokens: 2048 })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const reply = data.choices[0].message.content;
    db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(conversation_id, 'assistant', reply);
    res.json({ reply });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/generate-image', async (req, res) => {
  const { prompt, model } = req.body;
  const falKeyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('fal_key');
  if (!falKeyRow?.value) return res.status(400).json({ error: 'NO_FAL_KEY' });
  try {
    const falModel = model || 'fal-ai/flux/schnell';
    const response = await fetch(`https://fal.run/${falModel}`, {
      method: 'POST',
      headers: { 'Authorization': `Key ${falKeyRow.value}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, image_size: { width: 1024, height: 1024 }, num_images: 1, enable_safety_checker: true })
    });
    const data = await response.json();
    if (!data.images?.[0]?.url) return res.status(400).json({ error: data.error || 'No se generó imagen' });
    const imageUrl = data.images[0].url;
    db.prepare('INSERT INTO images (prompt, url, model) VALUES (?, ?, ?)').run(prompt, imageUrl, falModel);
    res.json({ url: imageUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/images', (req, res) =>
  res.json(db.prepare('SELECT * FROM images ORDER BY created_at DESC LIMIT 50').all()));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NexusAI corriendo en puerto ${PORT}`));
