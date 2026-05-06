import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fetchApi } from '@/lib/api';
import type { ApiResponse, OperationalEvent } from '@/lib/opsTypes';

function formatDate(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function eventType(event: OperationalEvent) {
  return event.type || event.eventType || event.event_type || event.status || 'event';
}

function eventTime(event: OperationalEvent) {
  return event.createdAt || event.created_at || event.timestamp || null;
}

function eventVariant(event: OperationalEvent): 'default' | 'destructive' | 'secondary' | 'outline' {
  const tone = `${event.severity || ''} ${event.status || ''} ${eventType(event)}`.toLowerCase();
  if (tone.includes('fail') || tone.includes('error')) return 'destructive';
  if (tone.includes('retry') || tone.includes('warn') || tone.includes('restart')) return 'secondary';
  if (tone.includes('sent') || tone.includes('resolve') || tone.includes('success')) return 'default';
  return 'outline';
}

function detailsText(details: OperationalEvent['details']) {
  if (!details) return '';
  return typeof details === 'string' ? details : JSON.stringify(details);
}

export default function Timeline() {
  const [events, setEvents] = useState<OperationalEvent[]>([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchApi<ApiResponse<OperationalEvent[]>>('/operational-events?limit=100');
      setEvents(data.data || data.events || []);
    } catch (err) {
      console.error('Failed to load operational events:', err);
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadEvents();
    });
  }, [loadEvents]);

  const filters = useMemo(() => {
    const uniqueTypes = Array.from(new Set(events.map(eventType))).filter(Boolean);
    return ['all', ...uniqueTypes.slice(0, 8)];
  }, [events]);

  const visibleEvents = filter === 'all'
    ? events
    : events.filter((event) => eventType(event) === filter);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold">Timeline</h1>
        <Button variant="outline" onClick={loadEvents} disabled={loading}>
          <RefreshCw className="h-4 w-4 mr-2" />Refresh
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {filters.map((item) => (
          <Button
            key={item}
            variant={filter === item ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(item)}
          >
            {item === 'all' ? 'All' : item}
          </Button>
        ))}
      </div>

      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div className="divide-y">
            {visibleEvents.map((event, index) => (
              <div key={event.id || `${eventType(event)}-${index}`} className="grid gap-3 p-4 lg:grid-cols-[180px_180px_1fr] lg:items-start">
                <div className="text-xs text-muted-foreground">{formatDate(eventTime(event))}</div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={eventVariant(event)}>{eventType(event)}</Badge>
                  {event.severity && <Badge variant="outline">{event.severity}</Badge>}
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">{event.message || detailsText(event.details) || 'Operational event'}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[
                      event.tenantName || event.tenant_name || event.tenantId || event.tenant_id,
                      event.botId || event.bot_id,
                      event.jobId || event.job_id || event.entity_id,
                    ].filter(Boolean).join(' / ') || 'System'}
                  </p>
                  {event.message && detailsText(event.details || event.metadata) && (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{detailsText(event.details || event.metadata)}</p>
                  )}
                </div>
              </div>
            ))}
            {visibleEvents.length === 0 && (
              <div className="p-8 text-center text-sm text-muted-foreground">No operational events</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
