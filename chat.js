// chat.js - cleaned voice-mode integration
document.addEventListener('DOMContentLoaded', () => {
  const chatMessagesEl = document.getElementById('chatMessages');
  const chatFormEl = document.getElementById('chatForm');
  const chatInputEl = document.getElementById('chatInput');
  const sendBtnEl = document.getElementById('sendBtn');

  // Ensure chatMessages exists
  if (!chatMessagesEl) {
    console.warn('chatMessages element not found.');
    return;
  }

  // Ensure record button exists or create it
  let recordBtn = document.getElementById('recordBtn');
  if (!recordBtn) {
    recordBtn = document.createElement('button');
    recordBtn.id = 'recordBtn';
    recordBtn.type = 'button';
    recordBtn.className = 'px-3 py-2 rounded bg-red-600 hover:bg-red-500 text-white mr-2';
    recordBtn.textContent = '🎤 Falar';
    if (sendBtnEl && sendBtnEl.parentNode) sendBtnEl.parentNode.insertBefore(recordBtn, sendBtnEl);
    else if (chatFormEl) chatFormEl.appendChild(recordBtn);
  } else {
    // ensure it's type=button so clicking doesn't submit form
    if (recordBtn.tagName === 'BUTTON') recordBtn.type = 'button';
  }

  function escapeHtml(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function scrollToBottom(){ try { chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight; } catch(e){} }

  function addMsg(text, user=true) {
    const wrapper = document.createElement('div');
    wrapper.className = (user ? 'flex justify-end my-2' : 'flex justify-start my-2');
    wrapper.innerHTML = `<div class="max-w-[85%] rounded-lg ${user ? 'bg-emerald-700 text-white' : 'bg-gray-100 text-gray-900'} px-3 py-2 text-sm">${escapeHtml(text)}</div>`;
    chatMessagesEl.appendChild(wrapper);
    scrollToBottom();
    return wrapper;
  }

  async function fetchAnswerFromServer(text) {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ messages: [ { role: 'user', content: text } ] })
    });
    if (!res.ok) {
      const t = await res.text().catch(()=>null);
      throw new Error(t || res.statusText || 'Erro /api/chat');
    }
    const j = await res.json();
    return j.answer || j.reply || '';
  }

  if (chatFormEl) {
    chatFormEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = chatInputEl.value.trim();
      if (!text) return;
      addMsg(text, true);
      chatInputEl.value = '';
      sendBtnEl.disabled = true;
      const thinkingEl = addMsg('⏳ Pensando...', false);
      try {
        const answer = await fetchAnswerFromServer(text);
        if (thinkingEl) thinkingEl.remove();
        addMsg(answer, false);
        // play TTS
        try {
          const ttsResp = await fetch('/api/voice/tts', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ text: answer }) });
          if (ttsResp.ok) {
            const blob = await ttsResp.blob();
            const url = URL.createObjectURL(blob);
            const a = new Audio(url); a.play().catch(()=>{});
          }
        } catch(e){ console.warn('TTS play failed', e); }
      } catch (err) {
        console.error(err);
        if (thinkingEl) thinkingEl.remove();
        addMsg('Erro ao consultar o chat: ' + (err.message||err), false);
      } finally {
        sendBtnEl.disabled = false;
      }
    });
  }

  // Voice recording logic
  let mediaRecorder = null;
  let chunks = [];
  let isRecording = false;
  let currentStream = null;

  recordBtn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    if (!isRecording) {
      try {
        currentStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch(err) {
        alert('Permissão de microfone negada ou indisponível: ' + (err.message||err));
        return;
      }
      mediaRecorder = new MediaRecorder(currentStream);
      chunks = [];
      mediaRecorder.ondataavailable = e => { if (e.data && e.data.size>0) chunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        await handleVoiceBlob(blob);
        try { currentStream.getTracks().forEach(t=>t.stop()); } catch(e){}
      };
      mediaRecorder.start();
      isRecording = true;
      recordBtn.textContent = '⏹️ Parar';
      recordBtn.classList.remove('bg-red-600'); recordBtn.classList.add('bg-gray-600');
    } else {
      try { mediaRecorder && mediaRecorder.state !== 'inactive' && mediaRecorder.stop(); } catch(e){}
      isRecording = false;
      recordBtn.textContent = '🎤 Falar';
      recordBtn.classList.remove('bg-gray-600'); recordBtn.classList.add('bg-red-600');
    }
  });

  async function handleVoiceBlob(blob) {
    const tempEl = addMsg('⏳ Transcrevendo áudio...', true);
    const inner = tempEl.querySelector('div');
    const fd = new FormData();
    fd.append('file', blob, 'recording.webm');
    try {
      const res = await fetch('/api/voice/chat', { method: 'POST', body: fd });
      if (!res.ok) {
        const t = await res.text().catch(()=>null);
        tempEl.remove();
        addMsg('Erro ao processar áudio: ' + (t||res.statusText), false);
        return;
      }
      const j = await res.json();
      if (j.transcript) {
        if (inner) inner.innerHTML = escapeHtml(j.transcript);
      } else {
        tempEl.remove();
        addMsg('(Áudio enviado, sem transcrição)', true);
      }
      if (j.reply) addMsg(j.reply, false);
      if (j.audio_base64) {
        try {
          const audioBlob = base64ToBlob(j.audio_base64, 'audio/mpeg');
          const url = URL.createObjectURL(audioBlob);
          const a = new Audio(url);
          await a.play().catch(e=>console.warn('play failed', e));
        } catch(e){ console.warn('audio decode', e); }
      }
    } catch (err) {
      console.error(err);
      tempEl.remove();
      addMsg('Erro ao enviar áudio: ' + (err.message||err), false);
    }
  }

  function base64ToBlob(base64, mime) {
    const bytes = atob(base64||'');
    const out = new Uint8Array(bytes.length);
    for (let i=0;i<bytes.length;i++) out[i]=bytes.charCodeAt(i);
    return new Blob([out], { type: mime });
  }

});
