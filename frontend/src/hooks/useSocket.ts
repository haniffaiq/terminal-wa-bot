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

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('bot:status', (data: BotStatus) => {
      setBotStatuses(prev => {
        const next = new Map(prev);
        next.set(data.botId, data);
        return next;
      });
    });

    socket.on('bot:qr', (data: { botId: string; qr: string }) => {
      setQrCode(data);
    });

    socket.on('bot:connected', (data: { botId: string }) => {
      setQrCode(null);
      setBotStatuses(prev => {
        const next = new Map(prev);
        next.set(data.botId, { botId: data.botId, status: 'open', timestamp: new Date().toISOString() });
        return next;
      });
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('bot:status');
      socket.off('bot:qr');
      socket.off('bot:connected');
    };
  }, []);

  return { botStatuses, qrCode, connected, setQrCode };
}
