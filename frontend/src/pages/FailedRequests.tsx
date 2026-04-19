import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { fetchApi, postApi } from '@/lib/api';
import { RotateCcw } from 'lucide-react';

interface FailedRequest {
  transactionId: string;
  number: string | string[];
  message: string;
  saved_at: string;
}

export default function FailedRequests() {
  const [requests, setRequests] = useState<FailedRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    loadRequests();
  }, []);

  async function loadRequests() {
    setLoading(true);
    try {
      const data = await fetchApi<{ success: boolean; data: FailedRequest[] }>('/failed-requests');
      setRequests(data.data || []);
    } catch {
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleRetryAll() {
    setRetrying(true);
    try {
      await postApi('/resend-failed', {});
      await loadRequests();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Failed Requests</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={loadRequests}>Refresh</Button>
          <Button onClick={handleRetryAll} disabled={retrying || requests.length === 0}>
            <RotateCcw className="h-4 w-4 mr-2" />{retrying ? 'Retrying...' : 'Retry All'}
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Transaction ID</th>
                <th className="text-left px-4 py-3 font-medium">Target</th>
                <th className="text-left px-4 py-3 font-medium">Message</th>
                <th className="text-left px-4 py-3 font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((req, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="px-4 py-3 font-mono text-xs">{req.transactionId}</td>
                  <td className="px-4 py-3 text-xs">
                    {Array.isArray(req.number) ? req.number.join(', ') : req.number}
                  </td>
                  <td className="px-4 py-3 max-w-xs truncate">{req.message?.substring(0, 80)}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {req.saved_at ? new Date(req.saved_at).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
              {requests.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                    No failed requests
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
