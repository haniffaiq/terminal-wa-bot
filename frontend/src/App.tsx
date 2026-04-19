import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Layout } from '@/components/Layout';
import Dashboard from '@/pages/Dashboard';
import BotManagement from '@/pages/BotManagement';
import SendMessage from '@/pages/SendMessage';
import Groups from '@/pages/Groups';
import FailedRequests from '@/pages/FailedRequests';
import Statistics from '@/pages/Statistics';
import Logs from '@/pages/Logs';

export default function App() {
  const [, setAuthed] = useState(false);

  return (
    <BrowserRouter>
      <ProtectedRoute onLogin={() => setAuthed(true)}>
        <Layout onLogout={() => setAuthed(false)}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/bots" element={<BotManagement />} />
            <Route path="/send" element={<SendMessage />} />
            <Route path="/groups" element={<Groups />} />
            <Route path="/failed" element={<FailedRequests />} />
            <Route path="/stats" element={<Statistics />} />
            <Route path="/logs" element={<Logs />} />
          </Routes>
        </Layout>
      </ProtectedRoute>
    </BrowserRouter>
  );
}
