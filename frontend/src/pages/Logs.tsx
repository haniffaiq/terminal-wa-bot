import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fetchApi } from '@/lib/api';
import { RefreshCw, ChevronLeft, ChevronRight, Search, ArrowDown } from 'lucide-react';

interface LogLine {
  type: string;
  text: string;
}

interface LogResponse {
  success: boolean;
  type: string;
  date: string;
  page: number;
  limit: number;
  totalLines: number;
  totalPages: number;
  lines: LogLine[];
}

const LOG_TABS = [
  { key: 'all', label: 'All' },
  { key: 'success', label: 'Success' },
  { key: 'error', label: 'Error' },
  { key: 'warn', label: 'Warning' },
  { key: 'req-res', label: 'Req/Res' },
];

const TYPE_COLORS: Record<string, string> = {
  success: 'text-green-400',
  error: 'text-red-400',
  warn: 'text-yellow-400',
  'req-res': 'text-blue-400',
};

const TYPE_BADGES: Record<string, string> = {
  success: 'bg-green-900/50 text-green-400 border-green-800',
  error: 'bg-red-900/50 text-red-400 border-red-800',
  warn: 'bg-yellow-900/50 text-yellow-400 border-yellow-800',
  'req-res': 'bg-blue-900/50 text-blue-400 border-blue-800',
};

export default function Logs() {
  const [logType, setLogType] = useState('all');
  const [date, setDate] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  });
  const [search, setSearch] = useState('');
  const [logData, setLogData] = useState<LogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-load on tab/date change
  useEffect(() => {
    loadLogs(1);
  }, [logType, date]);

  async function loadLogs(p: number = page) {
    setLoading(true);
    try {
      const searchParam = search ? `&search=${encodeURIComponent(search)}` : '';
      const data = await fetchApi<LogResponse>(`/logs/${logType}/${date}?page=${p}&limit=200${searchParam}`);
      setLogData(data);
      setPage(p);
      if (autoScroll) {
        setTimeout(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), 50);
      }
    } catch {
      setLogData(null);
    } finally {
      setLoading(false);
    }
  }

  function handleSearch() {
    loadLogs(1);
  }

  const formatDate = (d: string) => {
    if (d.length === 8) return `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;
    return d;
  };

  return (
    <div className="space-y-4 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Logs</h1>
        <span className="text-sm text-gray-500">{formatDate(date)}</span>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        {LOG_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setLogType(tab.key)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              logType === tab.key
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
            {logData && logType === tab.key && (
              <span className="ml-1.5 text-xs opacity-60">({logData.totalLines})</span>
            )}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Input
            type="date"
            value={`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`}
            onChange={e => setDate(e.target.value.replace(/-/g, ''))}
            className="w-40"
          />
        </div>

        <div className="flex items-center gap-2 flex-1 max-w-sm">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="Search logs... (transaction ID, group, etc)"
              className="pl-9"
            />
          </div>
          <Button variant="outline" size="sm" onClick={handleSearch}>
            Search
          </Button>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant={autoScroll ? 'default' : 'outline'}
            size="sm"
            onClick={() => setAutoScroll(!autoScroll)}
            title="Auto-scroll to bottom"
          >
            <ArrowDown className="h-3 w-3" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => loadLogs(page)}>
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Stats bar */}
      {logData && (
        <div className="flex items-center justify-between text-xs text-gray-500 px-1">
          <span>
            {logData.totalLines} lines
            {search && <span className="ml-1">(filtered)</span>}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              disabled={page <= 1}
              onClick={() => loadLogs(page - 1)}
            >
              <ChevronLeft className="h-3 w-3" />
            </Button>
            <span>{page} / {logData.totalPages || 1}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              disabled={page >= logData.totalPages}
              onClick={() => loadLogs(page + 1)}
            >
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}

      {/* Log viewer */}
      <div
        ref={logRef}
        className="flex-1 min-h-[500px] max-h-[calc(100vh-320px)] bg-gray-950 rounded-lg border border-gray-800 overflow-auto"
      >
        {loading && (
          <div className="flex items-center justify-center h-32 text-gray-500 text-sm">Loading...</div>
        )}

        {!loading && logData && logData.lines.length > 0 && (
          <table className="w-full text-xs font-mono">
            <tbody>
              {logData.lines.map((line, i) => (
                <tr
                  key={i}
                  className="hover:bg-gray-900/50 border-b border-gray-900"
                >
                  <td className="py-1 px-2 text-gray-600 text-right select-none w-10 align-top">
                    {(page - 1) * 200 + i + 1}
                  </td>
                  {logType === 'all' && (
                    <td className="py-1 px-1 w-16 align-top">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold border ${TYPE_BADGES[line.type] || 'text-gray-400'}`}>
                        {line.type === 'req-res' ? 'REQ' : line.type?.toUpperCase().slice(0, 4)}
                      </span>
                    </td>
                  )}
                  <td className={`py-1 px-2 whitespace-pre-wrap break-all align-top ${
                    logType === 'all' ? (TYPE_COLORS[line.type] || 'text-gray-300') : 'text-gray-300'
                  }`}>
                    {highlightSearch(line.text, search)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && logData && logData.lines.length === 0 && (
          <div className="flex items-center justify-center h-32 text-gray-600 text-sm">
            No log entries found{search && ` for "${search}"`}
          </div>
        )}

        {!loading && !logData && (
          <div className="flex items-center justify-center h-32 text-gray-600 text-sm">
            No log files found for this date
          </div>
        )}
      </div>
    </div>
  );
}

function highlightSearch(text: string, search: string) {
  if (!search) return text;
  const idx = text.toLowerCase().indexOf(search.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="bg-yellow-500/30 text-yellow-200 rounded px-0.5">{text.slice(idx, idx + search.length)}</span>
      {text.slice(idx + search.length)}
    </>
  );
}
