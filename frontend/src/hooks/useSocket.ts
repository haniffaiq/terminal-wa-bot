import { useEffect, useState } from 'react';
import { getSocket } from '@/lib/socket';

interface BotStatus {
  botId: string;
  status: string;
  timestamp: string;
}

export function useSocket() {
  const [botStatuses, setBotStatuses] = useState<Map<string, BotStatus>>(new Map());
  const [qrCode, setQrCode] = useState<{ botId: string; qr: string } | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onBotStatus = (data: BotStatus) => {
      setBotStatuses(prev => {
        const next = new Map(prev);
        next.set(data.botId, data);
        return next;
      });
    };
    const onBotQr = (data: { botId: string; qr: string }) => {
      setQrCode(data);
    };
    const onBotConnected = (data: { botId: string }) => {
      setQrCode(null);
      setBotStatuses(prev => {
        const next = new Map(prev);
        next.set(data.botId, { botId: data.botId, status: 'open', timestamp: new Date().toISOString() });
        return next;
      });
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('bot:status', onBotStatus);
    socket.on('bot:qr', onBotQr);
    socket.on('bot:connected', onBotConnected);

    if (socket.connected) setConnected(true);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('bot:status', onBotStatus);
      socket.off('bot:qr', onBotQr);
      socket.off('bot:connected', onBotConnected);
    };
  }, []);

  return { botStatuses, qrCode, connected, setQrCode };
}
