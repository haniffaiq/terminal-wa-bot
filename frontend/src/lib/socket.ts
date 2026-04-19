import { io, Socket } from 'socket.io-client';
import { getCredentials } from './auth';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket) return socket;

  const creds = getCredentials();

  socket = io({
    auth: {
      username: creds?.username,
      password: creds?.password,
    },
    transports: ['websocket'],
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
