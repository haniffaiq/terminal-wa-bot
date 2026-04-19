import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchApi } from '@/lib/api';
import { RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';

interface LogResponse {
  success: boolean;
  type: string;
  date: string;
  page: number;
  limit: number;
  totalLines: number;
  totalPages: number;
  lines: string[];
}

export default function Logs() {
  const [logType, setLogType] = useState('success');
  const [date, setDate] = useState(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  });
  const [logData, setLogData] = useState<LogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);

  async function loadLogs(p: number = page) {
    setLoading(true);
    try {
      const data = await fetchApi<LogResponse>(`/logs/${logType}/${date}?page=${p}&limit=200`);
      setLogData(data);
      setPage(p);
    } catch {
      setLogData(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Logs</h1>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label>Log Type</Label>
          <select
            value={logType}
            onChange={e => setLogType(e.target.value)}
            className="w-40 rounded-md border px-3 py-2 text-sm"
          >
            <option value="success">Success</option>
            <option value="error">Error</option>
            <option value="warn">Warning</option>
            <option value="req-res">Req/Res</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label>Date (YYYYMMDD)</Label>
          <Input value={date} onChange={e => setDate(e.target.value)} className="w-36" placeholder="20260419" />
        </div>
        <Button onClick={() => loadLogs(1)}>
          <RefreshCw className="h-4 w-4 mr-2" />Load Logs
        </Button>
      </div>

      {loading && <p className="text-gray-500">Loading...</p>}

      {logData && (
        <>
          <div className="flex items-center justify-between text-sm text-gray-500">
            <span>{logData.totalLines} total lines</span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => loadLogs(page - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span>Page {page} / {logData.totalPages}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= logData.totalPages}
                onClick={() => loadLogs(page + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="bg-gray-900 text-green-400 rounded-lg p-4 font-mono text-xs overflow-x-auto max-h-[600px] overflow-y-auto">
            {logData.lines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap">{line}</div>
            ))}
            {logData.lines.length === 0 && (
              <div className="text-gray-500">No log entries</div>
            )}
          </div>
        </>
      )}

      {!logData && !loading && (
        <p className="text-gray-400">Select log type and date, then click Load Logs</p>
      )}
    </div>
  );
}
