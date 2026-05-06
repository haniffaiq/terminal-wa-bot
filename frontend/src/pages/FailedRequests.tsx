import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, EyeOff, RefreshCw, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { fetchApi, postApi } from '@/lib/api';
import type { ApiResponse, MessageJob } from '@/lib/opsTypes';

interface FailedRequest {
  transactionId: string;
  number: string | string[];
  message: string;
  saved_at: string;
}

interface FailedRow {
  id: string;
  status: string;
  attempts: number;
  lastError: string;
  nextAttemptAt: string | null;
  target: string;
  message: string;
  createdAt: string | null;
  updatedAt: string | null;
  legacy: boolean;
}

function formatDate(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function formatTarget(value?: string | string[] | null) {
  if (Array.isArray(value)) return value.join(', ');
  return value || '-';
}

function statusVariant(status: string): 'default' | 'destructive' | 'secondary' | 'outline' {
  const normalized = status.toLowerCase();
  if (normalized === 'failed') return 'destructive';
  if (normalized === 'retrying') return 'secondary';
  if (normalized === 'resolved' || normalized === 'sent') return 'default';
  return 'outline';
}

function normalizeJob(job: MessageJob): FailedRow {
  return {
    id: job.id,
    status: job.status || 'unknown',
    attempts: job.attempts ?? job.attempt_count ?? 0,
    lastError: job.lastError || job.last_error || job.error || '-',
    nextAttemptAt: job.nextAttemptAt || job.next_attempt_at || null,
    target: formatTarget(job.target || job.target_id || job.number || job.recipient || job.payload?.target || job.payload?.number),
    message: job.message || job.payload?.message || '',
    createdAt: job.createdAt || job.created_at || null,
    updatedAt: job.updatedAt || job.updated_at || null,
    legacy: false,
  };
}

function normalizeLegacy(request: FailedRequest): FailedRow {
  return {
    id: request.transactionId,
    status: 'failed',
    attempts: 0,
    lastError: '-',
    nextAttemptAt: null,
    target: formatTarget(request.number),
    message: request.message || '',
    createdAt: request.saved_at || null,
    updatedAt: request.saved_at || null,
    legacy: true,
  };
}

export default function FailedRequests() {
  const [rows, setRows] = useState<FailedRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);

  const loadRequests = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchApi<ApiResponse<MessageJob[]>>('/jobs?status=failed,retrying');
      setRows((data.data || data.jobs || []).map(normalizeJob));
      setUsingFallback(false);
    } catch (err) {
      console.error('Failed to load jobs endpoint, using legacy failed requests:', err);
      const data = await fetchApi<{ success: boolean; data: FailedRequest[] }>('/failed-requests').catch(() => ({
        success: false,
        data: [],
      }));
      setRows((data.data || []).map(normalizeLegacy));
      setUsingFallback(true);
    } finally {
      setSelectedIds(new Set());
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadRequests();
    });
  }, [loadRequests]);

  async function runAction(actionId: string, action: () => Promise<unknown>) {
    setActionLoading(actionId);
    try {
      await action();
      await loadRequests();
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRetry(id: string) {
    await runAction(`retry:${id}`, () => postApi(`/jobs/${encodeURIComponent(id)}/retry`, {}));
  }

  async function handleResolve(id: string) {
    await runAction(`resolve:${id}`, () => postApi(`/jobs/${encodeURIComponent(id)}/resolve`, {}));
  }

  async function handleIgnore(id: string) {
    await runAction(`ignore:${id}`, () => postApi(`/jobs/${encodeURIComponent(id)}/ignore`, {}));
  }

  async function handleBulkRetry() {
    if (usingFallback) {
      await runAction('bulk-retry', () => postApi('/resend-failed', {}));
      return;
    }

    const ids = Array.from(selectedIds);
    await runAction('bulk-retry', () => postApi('/jobs/bulk-retry', ids.length > 0 ? { ids } : {}));
  }

  function toggleSelected(id: string, checked: boolean) {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const selectableRows = useMemo(() => rows.filter((row) => !row.legacy), [rows]);
  const allSelected = selectableRows.length > 0 && selectableRows.every((row) => selectedIds.has(row.id));
  const bulkLabel = usingFallback
    ? 'Retry All'
    : selectedIds.size > 0
      ? `Retry Selected (${selectedIds.size})`
      : 'Retry Failed';

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Failed Requests</h1>
          {usingFallback && <Badge variant="secondary">Legacy fallback</Badge>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={loadRequests} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-2" />Refresh
          </Button>
          <Button onClick={handleBulkRetry} disabled={actionLoading === 'bulk-retry' || rows.length === 0}>
            <RotateCcw className="h-4 w-4 mr-2" />{bulkLabel}
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    disabled={usingFallback || selectableRows.length === 0}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setSelectedIds(new Set(checked ? selectableRows.map((row) => row.id) : []));
                    }}
                    aria-label="Select all jobs"
                  />
                </TableHead>
                <TableHead>Job</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead>Last Error</TableHead>
                <TableHead>Next Attempt</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(row.id)}
                      disabled={row.legacy}
                      onChange={(event) => toggleSelected(row.id, event.target.checked)}
                      aria-label={`Select job ${row.id}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="max-w-[180px] truncate font-mono text-xs">{row.id}</div>
                    {row.message && <div className="max-w-[220px] truncate text-xs text-muted-foreground">{row.message}</div>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.attempts}</TableCell>
                  <TableCell>
                    <div className="max-w-[260px] truncate text-xs text-muted-foreground">{row.lastError}</div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(row.nextAttemptAt)}</TableCell>
                  <TableCell>
                    <div className="max-w-[180px] truncate text-xs">{row.target}</div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(row.createdAt)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(row.updatedAt)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRetry(row.id)}
                        disabled={row.legacy || actionLoading === `retry:${row.id}`}
                        title="Retry job"
                      >
                        <RotateCcw className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleResolve(row.id)}
                        disabled={row.legacy || actionLoading === `resolve:${row.id}`}
                        title="Resolve job"
                      >
                        <CheckCircle2 className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleIgnore(row.id)}
                        disabled={row.legacy || actionLoading === `ignore:${row.id}`}
                        title="Ignore job"
                      >
                        <EyeOff className="h-3 w-3" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="px-4 py-8 text-center text-muted-foreground">
                    No failed or retrying jobs
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
