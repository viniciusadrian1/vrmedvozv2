require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const multer = require('multer');
const fetch = require('node-fetch'); // node-fetch v2

// Importar contexto do chat especializado
require('./chat_context.js');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname)));

const upload = multer({ dest: path.join(__dirname, 'tmp') });
const ELEVEN_KEY = process.env.ELEVEN_API_KEY || '';
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// simple env check endpoint
app.get('/api/_env_check', (req, res) => {
  return res.json({
    haveOpenAI: !!OPENAI_KEY,
    haveEleven: !!ELEVEN_KEY,
    haveVoiceId: !!ELEVEN_VOICE_ID
  });
});

// Text chat endpoint -> OpenAI
app.post('/api/chat', async (req, res) => {
  try {
    // Aceitar múltiplos formatos de entrada
    let userText = '';
    
    // Se vier como array de mensagens (formato do frontend)
    if (req.body.messages && Array.isArray(req.body.messages)) {
      const lastUserMsg = req.body.messages.find(m => m.role === 'user');
      userText = lastUserMsg ? lastUserMsg.content : '';
    } else {
      // Formatos alternativos
      userText = (req.body.message || req.body.text || '').toString();
    }
    
    if (!userText) return res.status(400).json({ error: 'Missing message field' });
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

    // Usar o contexto especializado definido em chat_context.js
    const systemPrompt = global.CHAT_CONTEXT || 'Você é um assistente virtual especialista em pneumologia (pulmão e doenças respiratórias).';

    const payload = {
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ],
      max_tokens: 512,
      temperature: 0.2
    };

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify(payload)
    });
    const j = await r.json().catch(()=>null);
    if (!r.ok) {
      console.error('OpenAI chat error', r.status, j);
      return res.status(500).json({ error: 'OpenAI error', detail: j });
    }
    const answer = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    return res.json({ answer });
  } catch (err) {
    console.error('api/chat exception', err);
    return res.status(500).json({ error: String(err) });
  }
});

// Voice endpoint: STT -> OpenAI -> TTS (ElevenLabs)
app.post('/api/voice/chat', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!ELEVEN_KEY || !ELEVEN_VOICE_ID) {
      try { fs.unlinkSync(req.file.path); } catch(e){}
      return res.status(500).json({ error: 'ELEVEN_API_KEY or ELEVEN_VOICE_ID not configured' });
    }
    if (!OPENAI_KEY) {
      try { fs.unlinkSync(req.file.path); } catch(e){}
      return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    }

    const filePath = req.file.path;

    // STT request to ElevenLabs - send multipart/form-data with model_id and file
    const sttForm = new FormData();
    sttForm.append('model_id', 'scribe_v1');
    sttForm.append('file', fs.createReadStream(filePath));

    const sttHeaders = Object.assign({ 'xi-api-key': ELEVEN_KEY }, (sttForm.getHeaders ? sttForm.getHeaders() : {}));

    const sttResp = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: sttHeaders,
      body: sttForm
    });

    const sttText = await sttResp.text().catch(()=>null);
    let sttJson = null;
    try { sttJson = sttText ? JSON.parse(sttText) : null; } catch(e) { /* not json */ }

    try { fs.unlinkSync(filePath); } catch(e){}

    if (!sttResp.ok) {
      console.error('ElevenLabs STT error', sttResp.status, sttText);
      return res.status(500).json({ error: 'STT failed', status: sttResp.status, detail: sttJson || sttText });
    }

    const userText = (sttJson && (sttJson.text || sttJson.transcription)) || '';
    if (!userText) {
      return res.json({ transcript: '', reply: 'Não consegui transcrever o áudio.', audio_base64: '' });
    }

    // Send to OpenAI with specialized context
    const systemPrompt = global.CHAT_CONTEXT || 'Você é um assistente virtual especialista em pneumologia (pulmão e doenças respiratórias).';
    
    const aiPayload = {
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ],
      max_tokens: 512,
      temperature: 0.2
    };

    const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify(aiPayload)
    });

    const aiJson = await aiResp.json().catch(()=>null);
    if (!aiResp.ok) {
      console.error('OpenAI error', aiResp.status, aiJson);
      return res.status(500).json({ transcript: userText, reply: '', error: 'OpenAI error', detail: aiJson });
    }
    const replyText = (aiJson.choices && aiJson.choices[0] && aiJson.choices[0].message && aiJson.choices[0].message.content) || '';

    // TTS via ElevenLabs
    const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
    const ttsResp = await fetch(ttsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
        'xi-api-key': ELEVEN_KEY
      },
      body: JSON.stringify({ text: replyText })
    });

    if (!ttsResp.ok) {
      const txt = await ttsResp.text().catch(()=>null);
      console.error('TTS error', ttsResp.status, txt);
      return res.status(500).json({ transcript: userText, reply: replyText, error: 'TTS error', detail: txt });
    }

    const buffer = Buffer.from(await ttsResp.arrayBuffer());
    const audio_base64 = buffer.toString('base64');

    return res.json({ transcript: userText, reply: replyText, audio_base64 });
  } catch (err) {
    console.error('voice/chat exception', err);
    return res.status(500).json({ error: String(err) });
  }
});

// TTS-only endpoint (text -> audio)
app.post('/api/voice/tts', express.json(), async (req, res) => {
  try {
    const text = req.body.text || '';
    if (!text) return res.status(400).json({ error: 'Missing text' });
    if (!ELEVEN_KEY || !ELEVEN_VOICE_ID) return res.status(500).json({ error: 'ELEVEN not configured' });

    const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
    const ttsResp = await fetch(ttsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'audio/mpeg', 'xi-api-key': ELEVEN_KEY },
      body: JSON.stringify({ text })
    });
    if (!ttsResp.ok) {
      const txt = await ttsResp.text().catch(()=>null);
      return res.status(500).json({ error: 'TTS failed', detail: txt });
    }
    const buffer = Buffer.from(await ttsResp.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${port}`);
});