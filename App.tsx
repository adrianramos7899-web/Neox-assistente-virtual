
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { v4 as uuidv4 } from 'uuid';
import { Message } from './types';
import { 
  NEOX_SYSTEM_PROMPT, 
  NEOX_LOGO, 
  DEFAULT_PROFILE_IMG, 
  DEFAULT_IDLE_IMG, 
  DEFAULT_TYPING_IMG 
} from './constants';
import { decode, decodeAudioData, encode } from './services/audio';

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [isLive, setIsLive] = useState(false);
  
  // Configurações - Carrega do localStorage ou usa o Padrão Global do código
  const [systemPrompt, setSystemPrompt] = useState(localStorage.getItem('neox_prompt') || NEOX_SYSTEM_PROMPT);
  const [profileImg, setProfileImg] = useState(localStorage.getItem('neox_profile_img') || DEFAULT_PROFILE_IMG);
  const [idleImg, setIdleImg] = useState(localStorage.getItem('neox_idle_img') || DEFAULT_IDLE_IMG);
  const [typingImg, setTypingImg] = useState(localStorage.getItem('neox_typing_img') || DEFAULT_TYPING_IMG);
  const [selectedVoice, setSelectedVoice] = useState(localStorage.getItem('neox_voice') || 'Charon');
  
  // Interface
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [isUnlocked, setIsUnlocked] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  const liveSessionRef = useRef<any>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  useEffect(() => {
    if (visionEnabled) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } })
        .then(stream => { if (videoRef.current) videoRef.current.srcObject = stream; })
        .catch(err => { console.error("Erro na câmera:", err); setVisionEnabled(false); });
    } else {
      const stream = videoRef.current?.srcObject as MediaStream;
      stream?.getTracks().forEach(track => track.stop());
    }
  }, [visionEnabled]);

  const initAudioContext = (rate = 24000) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: rate });
      nextStartTimeRef.current = audioContextRef.current.currentTime;
    }
    if (audioContextRef.current.state === 'suspended') audioContextRef.current.resume();
    return audioContextRef.current;
  };

  const playAudioChunk = async (base64Data: string) => {
    const ctx = initAudioContext(24000);
    try {
      const buffer = await decodeAudioData(decode(base64Data), ctx, 24000, 1);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const startTime = Math.max(nextStartTimeRef.current, ctx.currentTime);
      source.start(startTime);
      nextStartTimeRef.current = startTime + buffer.duration;
      audioSourcesRef.current.add(source);
      source.onended = () => audioSourcesRef.current.delete(source);
    } catch (e) { console.error("Erro de áudio", e); }
  };

  const stopAllAudio = () => {
    audioSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  };

  const toggleLiveMode = async () => {
    if (isLive) {
      liveSessionRef.current?.close();
      audioStreamRef.current?.getTracks().forEach(t => t.stop());
      setIsLive(false);
      setIsTyping(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;
      setIsLive(true);
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } } },
          systemInstruction: systemPrompt,
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              const pcmBlob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data) {
              await playAudioChunk(message.serverContent.modelTurn.parts[0].inlineData.data);
              setIsTyping(true);
            }
            if (message.serverContent?.turnComplete) setIsTyping(false);
            if (message.serverContent?.interrupted) stopAllAudio();
          },
          onclose: () => setIsLive(false),
          onerror: () => setIsLive(false),
        }
      });
      liveSessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("Erro no modo Live:", err);
      setIsLive(false);
    }
  };

  const speakText = async (text: string, retryCount = 0): Promise<void> => {
    const cleanText = text.replace(/[:;>][\(\)DP\_oO<xX\-]{1,3}/g, '').trim();
    if (!cleanText) return;
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: cleanText }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } } },
        },
      });
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) await playAudioChunk(base64Audio);
    } catch (err) {
      if (retryCount < 2) {
        await new Promise(r => setTimeout(r, 1000));
        return speakText(text, retryCount + 1);
      }
    }
  };

  const getCameraFrame = (): string | null => {
    if (!visionEnabled || !videoRef.current || !canvasRef.current) return null;
    const context = canvasRef.current.getContext('2d');
    if (!context) return null;
    canvasRef.current.width = videoRef.current.videoWidth;
    canvasRef.current.height = videoRef.current.videoHeight;
    context.drawImage(videoRef.current, 0, 0);
    return canvasRef.current.toDataURL('image/jpeg', 0.6).split(',')[1];
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim() || isTyping) return;

    initAudioContext();
    const currentText = inputText;
    setInputText('');
    addMessage('user', currentText);
    setIsTyping(true);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const frame = getCameraFrame();
      const parts: any[] = [{ text: currentText }];
      
      if (frame) {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: frame } });
      }

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [{ role: 'user', parts }],
        config: { systemInstruction: systemPrompt }
      });

      const reply = response.text || "Entendido.";
      setIsTyping(false);
      addMessage('model', reply);
      speakText(reply);
    } catch (err) {
      setIsTyping(false);
      addMessage('model', "Falha na conexão neural.");
    }
  };

  const addMessage = (role: 'user' | 'model', text: string) => {
    setMessages(prev => [...prev, { id: uuidv4(), role, text, timestamp: new Date() }]);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, setter: (val: string) => void) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base = reader.result as string;
        setter(base);
      };
      reader.readAsDataURL(file);
    }
  };

  const checkPassword = () => {
    if (passwordInput === 'k4..') setIsUnlocked(true);
    else alert('Senha incorreta.');
  };

  const resetChat = () => {
    if (confirm("Deseja fechar e limpar o chat?")) {
      setMessages([]);
      setInputText('');
      if (isLive) toggleLiveMode();
    }
  };

  const handleSaveEverything = () => {
    // Salva localmente para persistência pessoal
    localStorage.setItem('neox_prompt', systemPrompt);
    localStorage.setItem('neox_voice', selectedVoice);
    localStorage.setItem('neox_profile_img', profileImg);
    localStorage.setItem('neox_idle_img', idleImg);
    localStorage.setItem('neox_typing_img', typingImg);
    
    // Fecha o painel
    setIsConfigOpen(false);
    setIsUnlocked(false);
    setPasswordInput('');
    
    alert("Cérebro atualizado! (Lembre-se: para que OUTRAS pessoas vejam suas fotos automaticamente, o administrador precisa colocar as fotos direto no código constant.ts)");
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-[#1e293b] p-0 sm:p-6 font-sans text-gray-800">
      
      {/* Janela do Terminal */}
      <div className="w-full h-full sm:w-[95vw] sm:max-w-6xl sm:h-[90vh] bg-[#ebebeb] flex flex-col shadow-[0_20px_50px_rgba(0,0,0,0.5)] border-[3px] border-[#7da7d9] rounded-none sm:rounded-t-xl overflow-hidden relative">
        
        {/* Barra de Título */}
        <div className="h-10 shrink-0 bg-gradient-to-b from-[#b8d4f0] via-[#7da7d9] to-[#4c84c3] flex items-center justify-between px-3 select-none">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white drop-shadow-sm flex items-center gap-2">
              <span className={`text-xs ${isLive ? 'animate-pulse text-red-400' : ''}`}>♡</span> Neox Terminal {isLive && "(ESCUTANDO)"}
            </span>
          </div>
          
          <div className="flex items-center h-full gap-[1px] pt-1 pb-1">
             <button className="w-10 h-6 bg-gradient-to-b from-white/30 to-black/10 flex items-center justify-center border border-black/10 rounded-sm hover:from-white/50 transition-all"><div className="w-2.5 h-[1.5px] bg-white"></div></button>
             <button className="w-10 h-6 bg-gradient-to-b from-white/30 to-black/10 flex items-center justify-center border border-black/10 rounded-sm hover:from-white/50 transition-all"><div className="w-2 h-2 border-[1.5px] border-white"></div></button>
             <button onClick={resetChat} className="w-12 h-6 bg-gradient-to-b from-[#e37060] to-[#c73b2a] flex items-center justify-center border border-[#8f271b] rounded-sm ml-1 group hover:from-[#f08575] transition-all">
                <svg className="w-3 h-3 text-white stroke-[4]" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M18 6L6 18M6 6l12 12" /></svg>
             </button>
          </div>
        </div>

        {/* Layout Interno */}
        <div className="flex-1 flex flex-col sm:flex-row overflow-hidden border-t border-[#3b669e]">
          
          {/* Sidebar / Câmera */}
          <div className="w-full sm:w-72 bg-[#d6e4f5] border-b sm:border-b-0 sm:border-r border-[#9ebade] flex flex-col p-4 gap-4 shrink-0 shadow-inner">
            <div className="flex items-center justify-between gap-2">
              <h1 className="text-xs font-black tracking-widest text-[#2a5a8a] uppercase">Painel Neural</h1>
              <div className="flex gap-1">
                <button onClick={toggleLiveMode} className={`p-1.5 rounded transition-all shadow-sm border ${isLive ? 'bg-red-500 border-red-700 text-white animate-pulse' : 'bg-white/50 border-[#9ebade] text-[#2a5a8a] hover:bg-white'}`} title={isLive ? "Parar de Ouvir" : "Ouvir Voz"}>
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
                </button>
                <button onClick={() => setIsConfigOpen(true)} className="p-1.5 bg-white/50 border border-[#9ebade] text-[#2a5a8a] rounded hover:bg-white transition-all shadow-sm">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                </button>
              </div>
            </div>

            <div className="relative aspect-square sm:w-full bg-[#333] rounded-lg overflow-hidden border border-[#9ebade] shadow-inner">
              {visionEnabled ? (
                <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover grayscale brightness-90 contrast-110" />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center text-[#5a7a9a] gap-2">
                  <svg className="w-10 h-10 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                  <span className="text-[10px] font-black uppercase tracking-widest opacity-50">Câmera Off</span>
                </div>
              )}
              <button onClick={() => setVisionEnabled(!visionEnabled)} className="absolute inset-0 bg-blue-600/0 hover:bg-blue-600/20 flex items-center justify-center transition-all opacity-0 hover:opacity-100">
                <span className="px-3 py-1 bg-[#4c84c3] text-white text-[10px] font-black rounded uppercase">{visionEnabled ? "Off" : "On"}</span>
              </button>
            </div>
            
            <div className="hidden sm:block mt-auto text-[9px] text-[#5a7a9a] font-bold space-y-1 p-2 bg-white/30 rounded border border-[#9ebade]/50">
              <p>STATUS: {isLive ? "ESCUTANDO" : "ONLINE"}</p>
              <p>VISION: {visionEnabled ? "ATIVA" : "REPOUSO"}</p>
            </div>
          </div>

          {/* Chat Container */}
          <div className="flex-1 flex flex-col min-w-0 bg-white">
            <div className="flex-1 overflow-y-auto p-4 sm:p-8 flex flex-col gap-6 custom-scrollbar" ref={scrollRef}>
              {messages.length === 0 && !isTyping && !isLive && (
                 <div className="flex-1 flex flex-col items-center justify-center opacity-30 pointer-events-none text-center grayscale">
                    {idleImg ? <img src={idleImg} className="w-64 h-64 sm:w-80 sm:h-80 rounded-full object-cover border-8 border-[#ebebeb] shadow-xl" /> : <div className="w-64 h-64 sm:w-80 sm:h-80" dangerouslySetInnerHTML={{ __html: NEOX_LOGO }}></div>}
                    <h2 className="text-2xl font-black text-[#2a5a8a] tracking-[0.4em] uppercase mt-4">Neox</h2>
                 </div>
              )}
              
              {isLive && messages.length === 0 && (
                <div className="flex-1 flex flex-col items-center justify-center text-[#2a5a8a] opacity-60">
                  <div className="w-32 h-32 bg-[#4c84c3] rounded-full flex items-center justify-center animate-pulse shadow-xl border-4 border-white mb-6">
                    <svg className="w-16 h-16 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/></svg>
                  </div>
                  <p className="font-black uppercase tracking-widest text-lg">Modo Escuta Ativo</p>
                </div>
              )}

              {messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} gap-4 animate-in slide-in-from-bottom-2`}>
                  {msg.role === 'model' && (
                    <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl overflow-hidden mt-1 border border-[#9ebade] shadow-sm bg-[#ebebeb]">
                      {profileImg ? <img src={profileImg} className="w-full h-full object-cover" /> : <div className="w-full h-full p-3" dangerouslySetInnerHTML={{ __html: NEOX_LOGO }}></div>}
                    </div>
                  )}
                  <div className={`px-5 py-4 sm:px-6 sm:py-5 rounded-3xl shadow-sm max-w-[85%] sm:max-w-[70%] ${msg.role === 'user' ? 'bg-[#c5dcfa] text-[#1e3a5f] rounded-tr-none border border-[#9ab7db]' : 'bg-[#f5f5f5] text-gray-800 rounded-tl-none border border-gray-200'}`}>
                    <p className="text-base sm:text-lg font-medium">{msg.text}</p>
                    <div className="text-[9px] mt-2 font-black opacity-30 uppercase text-right">{msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                  </div>
                </div>
              ))}

              {isTyping && (
                <div className="flex justify-start gap-4">
                   <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl overflow-hidden mt-1 border border-[#9ebade] shadow-sm bg-[#ebebeb] animate-pulse">
                     {profileImg ? <img src={profileImg} className="w-full h-full object-cover" /> : <div className="w-full h-full p-3" dangerouslySetInnerHTML={{ __html: NEOX_LOGO }}></div>}
                   </div>
                   <div className="bg-[#f5f5f5] px-6 py-4 rounded-3xl border border-gray-200 flex gap-1.5 items-center">
                     <div className="w-2 h-2 bg-[#4c84c3] rounded-full animate-bounce"></div>
                     <div className="w-2 h-2 bg-[#4c84c3] rounded-full animate-bounce [animation-delay:0.2s]"></div>
                     <div className="w-2 h-2 bg-[#4c84c3] rounded-full animate-bounce [animation-delay:0.4s]"></div>
                   </div>
                </div>
              )}
            </div>

            {/* Barra de Input */}
            <div className="p-4 sm:p-6 bg-[#ebebeb] border-t border-gray-200">
              <div className="flex items-end gap-4 max-w-5xl mx-auto">
                 <div className="hidden sm:flex w-24 h-24 sm:w-32 sm:h-32 bg-white rounded-2xl border border-[#9ebade] items-center justify-center overflow-hidden shrink-0 shadow-sm relative">
                   {isTyping || isLive ? (
                     typingImg ? <img src={typingImg} className="w-full h-full object-cover" /> : <div className="w-16 h-16 animate-pulse" dangerouslySetInnerHTML={{ __html: NEOX_LOGO }}></div>
                   ) : (
                     idleImg ? <img src={idleImg} className="w-full h-full object-cover" /> : <div className="w-16 h-16 opacity-30" dangerouslySetInnerHTML={{ __html: NEOX_LOGO }}></div>
                   )}
                   {isLive && <div className="absolute inset-0 border-4 border-red-400/50 rounded-2xl animate-pulse"></div>}
                 </div>
                 
                 <form onSubmit={handleSendMessage} className="flex-1 flex flex-col gap-2">
                  <div className="relative group">
                    <input 
                      type="text" value={inputText} onChange={(e) => setInputText(e.target.value)}
                      placeholder={isLive ? "Ouvindo voz..." : "Digite..."} disabled={isLive}
                      className="w-full px-5 py-4 bg-white border border-[#9ebade] rounded-xl outline-none text-base font-bold text-gray-700 shadow-inner focus:border-[#4c84c3] disabled:bg-gray-50 transition-all"
                    />
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                      <button type="button" onClick={toggleLiveMode} className={`w-10 h-10 flex items-center justify-center rounded-lg shadow-sm border transition-all ${isLive ? 'bg-red-500 text-white border-red-600' : 'bg-white border-gray-200 text-[#4c84c3] hover:bg-gray-50'}`}>
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/></svg>
                      </button>
                      <button type="submit" className="w-12 h-10 bg-[#4c84c3] text-white flex items-center justify-center rounded-lg shadow-md hover:bg-[#3b669e] active:scale-95 disabled:opacity-30 transition-all" disabled={isTyping || isLive || !inputText.trim()}>
                        <svg className="w-6 h-6 rotate-90" fill="currentColor" viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>

        <canvas ref={canvasRef} className="hidden" />

        {/* Painel de Configuração */}
        {isConfigOpen && (
          <div className="absolute inset-0 z-[100] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-white w-full max-w-md rounded-lg shadow-2xl border-4 border-[#7da7d9] overflow-hidden animate-in zoom-in duration-200">
              <div className="bg-gradient-to-b from-[#b8d4f0] to-[#4c84c3] p-4 text-white font-black flex justify-between items-center border-b border-[#3b669e]">
                <span className="text-sm uppercase tracking-widest">Painel de Controle</span>
                <button onClick={() => {setIsConfigOpen(false); setIsUnlocked(false);}} className="text-white hover:text-black font-bold">✕</button>
              </div>

              {!isUnlocked ? (
                <div className="p-8 space-y-6">
                  <div className="text-center">
                    <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-4">Acesso Restrito</p>
                    <input type="password" value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && checkPassword()} placeholder="Senha" className="w-full p-4 bg-gray-50 border border-gray-200 rounded outline-none focus:border-[#4c84c3] text-center text-xl tracking-[0.5em] font-black" autoFocus />
                    <button onClick={checkPassword} className="w-full mt-4 bg-[#4c84c3] text-white p-4 rounded font-black hover:bg-[#3b669e] transition-all">ACESSAR</button>
                  </div>
                </div>
              ) : (
                <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto custom-scrollbar">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-[#5a7a9a] uppercase">Personalidade (Prompt)</label>
                    <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} className="w-full h-32 p-3 bg-gray-50 border border-gray-200 rounded text-xs font-medium outline-none focus:border-[#4c84c3] resize-none" placeholder="Quem é o Neox..." />
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-[#5a7a9a] uppercase">Voz</label>
                    <select value={selectedVoice} onChange={(e) => setSelectedVoice(e.target.value)} className="w-full p-3 bg-gray-50 border border-gray-200 rounded text-sm font-bold outline-none">
                      <option value="Charon">Charon</option><option value="Puck">Puck</option><option value="Kore">Kore</option><option value="Fenrir">Fenrir</option>
                    </select>
                  </div>

                  <div className="space-y-4 pt-4 border-t border-gray-100">
                    <label className="text-[10px] font-black text-[#5a7a9a] uppercase">Imagens (Envie e clique em Salvar)</label>
                    <div className="space-y-2">
                      <div className="bg-gray-50 p-2 rounded border border-gray-100 flex items-center justify-between">
                        <span className="text-[9px] font-bold text-[#4c84c3] uppercase">Avatar</span>
                        <input type="file" accept="image/*" onChange={(e) => handleFileUpload(e, setProfileImg)} className="text-[10px] w-40" />
                      </div>
                      <div className="bg-gray-50 p-2 rounded border border-gray-100 flex items-center justify-between">
                        <span className="text-[9px] font-bold text-[#4c84c3] uppercase">Repouso</span>
                        <input type="file" accept="image/*" onChange={(e) => handleFileUpload(e, setIdleImg)} className="text-[10px] w-40" />
                      </div>
                      <div className="bg-gray-50 p-2 rounded border border-gray-100 flex items-center justify-between">
                        <span className="text-[9px] font-bold text-[#4c84c3] uppercase">Ação</span>
                        <input type="file" accept="image/*" onChange={(e) => handleFileUpload(e, setTypingImg)} className="text-[10px] w-40" />
                      </div>
                    </div>
                  </div>

                  <button onClick={handleSaveEverything} className="w-full bg-[#3b669e] text-white p-4 rounded font-black uppercase tracking-widest mt-2 hover:bg-[#2a4a7a] transition-all shadow-md active:scale-95">
                    SALVAR ALTERAÇÕES
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #f1f1f1; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #4c84c3; border-radius: 3px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #3b669e; }
      `}</style>
    </div>
  );
};

export default App;
