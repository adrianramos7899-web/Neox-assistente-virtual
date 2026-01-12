import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { v4 as uuidv4 } from 'uuid';
import { ConnectionStatus } from './types';
import { 
  NEOX_SYSTEM_PROMPT, 
  DEFAULT_PROFILE_IMG, 
  DEFAULT_IDLE_IMG,
  DEFAULT_TYPING_IMG
} from './constants';
import { decode, decodeAudioData, encode } from './services/audio';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [isLive, setIsLive] = useState(false);
  const [visionEnabled, setVisionEnabled] = useState(false);
  
  // Refs para controle de hardware e sessão
  const audioContextRef = useRef<{ input: AudioContext; output: AudioContext } | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Inicializa o áudio apenas quando necessário (interação do usuário)
  const initAudio = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = {
        input: new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 }),
        output: new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 })
      };
    }
    if (audioContextRef.current.output.state === 'suspended') {
      audioContextRef.current.output.resume();
    }
  };

  // Função para capturar frames da câmera e enviar para o Neox
  const sendVideoFrame = useCallback(() => {
    if (!sessionRef.current || !