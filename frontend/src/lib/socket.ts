import { io, Socket } from 'socket.io-client';
import { getToken, isAuthenticated } from './auth';

let socket: Socket | null = null;

export function getSocket(): Socket | null {
  if (!isAuthenticated()) return null;
  if (socket) return socket;

  socket = io({
    auth: { token: getToken() },
    transports: ['websocket'],
    reconnectionDelay: 5000,
    reconnectionAttempts: 10,
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
