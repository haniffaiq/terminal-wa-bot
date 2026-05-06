import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, Clock, MessageSquare } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchApi } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import type { ApiResponse, OperationalEvent, OpsSummary } from '@/lib/opsTypes';

interface BotStatusResponse {
  success: boolean;
  data: { active: string[]; inactive: string[] };
}

interface StatsData {
  [hour: string]: { [bot: string]: number };
}

interface DashboardFallback {
  activeBots: string[];
  inactiveBots: string[];
  messagesToday: number;
  failedCount: number;
}

function formatDate(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function eventLabel(event: OperationalEvent) {
  return event.type || event.eventType || event.event_type || event.status || 'event';
}

function eventTime(event: OperationalEvent) {
  return event.createdAt || event.created_at || event.timestamp || null;
}

function eventTone(event: OperationalEvent): 'default' | 'destructive' | 'outline' | 'secondary' {
  const severity = (event.severity || event.status || '').toLowerCase();
  if (severity.includes('fail') || severity.includes('error')) return 'destructive';
  if (severity.includes('warn') || severity.includes('retry')) return 'secondary';
  if (severity.includes('success') || severity.includes('sent') || severity.includes('resolve')) return 'default';
  return 'outline';
}

function detailsText(details: OperationalEvent['details'] | OperationalEvent['metadata']) {
  if (!details) return '';
  return typeof details === 'string' ? details : JSON.stringify(details);
}

export default function Dashboard() {
  const [opsSummary, setOpsSummary] = useState<OpsSummary | null>(null);
  const [recentEvents, setRecentEvents] = useState<OperationalEvent[]>([]);
  const [fallback, setFallback] = useState<DashboardFallback>({
    activeBots: [],
    inactiveBots: [],
    messagesToday: 0,
    failedCount: 0,
  });
  const [usingFallback, setUsingFallback] = useState(false);
  const { botStatuses } = useSocket();

  const loadFallbackData = useCallback(async () => {
    try {
      const [status, failed] = await Promise.all([
        fetchApi<BotStatusResponse>('/bot-status'),
        fetchApi<{ success: boolean; data: unknown[] }>('/failed-requests'),
      ]);
      const today = new Date().toISOString().split('T')[0];
      const stats = await fetchApi<{ success: boolean; data: StatsData }>(`/stats/${today}`).catch((): { success: boolean; data: StatsData } => ({
        success: false,
        data: {},
      }));
      const messagesToday = Object.values(stats.data || {}).reduce((sum, hour) => {
        return sum + Object.values(hour).reduce((hourSum, value) => hourSum + value, 0);
      }, 0);

      setFallback({
        activeBots: status.data?.active || [],
        inactiveBots: status.data?.inactive || [],
        messagesToday,
        failedCount: failed.data?.length || 0,
      });
    } catch (fallbackErr) {
      console.error('Failed to load fallback dashboard data:', fallbackErr);
      setFallback({ activeBots: [], inactiveBots: [], messagesToday: 0, failedCount: 0 });
    }
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [summary, events] = await Promise.all([
        fetchApi<ApiResponse<OpsSummary>>('/ops/summary'),
        fetchApi<ApiResponse<OperationalEvent[]>>('/operational-events?limit=8').catch((): ApiResponse<OperationalEvent[]> => ({
          success: false,
          events: [],
        })),
      ]);
      setOpsSummary(summary.data || null);
      setRecentEvents(summary.data?.recentEvents || events.data || events.events || []);
      setUsingFallback(false);
    } catch (err) {
      console.error('Failed to load ops summary:', err);
      setOpsSummary(null);
      setRecentEvents([]);
      setUsingFallback(true);
      await loadFallbackData();
    }
  }, [loadFallbackData]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadData();
    });
  }, [loadData]);

  const bots = opsSummary?.bots;
  const jobs = opsSummary?.jobs;
  const onlineBots = bots?.online ?? fallback.activeBots.length;
  const offlineBots = bots?.offline ?? fallback.inactiveBots.length;
  const totalBots = bots?.total ?? onlineBots + offlineBots;
  const activeJobs = (jobs?.queued ?? 0) + (jobs?.sending ?? 0) + (jobs?.retrying ?? 0);
  const messagesSent = jobs?.sent_today ?? jobs?.sent ?? fallback.messagesToday;
  const failedJobs = jobs?.failed ?? fallback.failedCount;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        {usingFallback && (
          <Badge variant="secondary" className="w-fit">
            Legacy data fallback
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Bots Online</CardTitle>
            <Bot className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{onlineBots}</div>
            <p className="text-xs text-muted-foreground">
              {offlineBots} offline of {totalBots} total
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Jobs</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeJobs}</div>
            <p className="text-xs text-muted-foreground">
              {jobs?.queued ?? 0} queued, {jobs?.retrying ?? 0} retrying
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Messages Sent</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{messagesSent}</div>
            <p className="text-xs text-muted-foreground">
              {jobs ? `${jobs.resolved} resolved, ${jobs.ignored} ignored` : 'Today from legacy stats'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Failed Jobs</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{failedJobs}</div>
            <p className="text-xs text-muted-foreground">Needs operator review</p>
          </CardContent>
        </Card>
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Recent Operational Events</h2>
        </div>
        <div className="overflow-hidden rounded-lg border">
          <div className="divide-y">
            {recentEvents.slice(0, 8).map((event, index) => (
              <div key={event.id || `${eventLabel(event)}-${index}`} className="grid gap-2 p-3 sm:grid-cols-[160px_1fr_180px] sm:items-center">
                <Badge variant={eventTone(event)} className="w-fit">
                  {eventLabel(event)}
                </Badge>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{event.message || detailsText(event.details || event.metadata) || 'Operational event'}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[event.tenantName || event.tenant_name, event.botId || event.bot_id, event.jobId || event.job_id || event.entity_id].filter(Boolean).join(' / ') || 'System'}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground sm:text-right">{formatDate(eventTime(event))}</span>
              </div>
            ))}
            {recentEvents.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {usingFallback ? 'Operational events unavailable from legacy endpoints' : 'No recent operational events'}
              </div>
            )}
          </div>
        </div>
      </section>

      {usingFallback && fallback.activeBots.concat(fallback.inactiveBots).length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Bot Status</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {fallback.activeBots.concat(fallback.inactiveBots).map((botId) => {
              const realtimeStatus = botStatuses.get(botId);
              const isOnline = realtimeStatus
                ? realtimeStatus.status === 'open'
                : fallback.activeBots.includes(botId);

              return (
                <div key={botId} className="flex items-center justify-between rounded-lg border p-3">
                  <span className="truncate font-medium">{botId}</span>
                  <Badge variant={isOnline ? 'default' : 'destructive'}>
                    {isOnline ? 'Online' : 'Offline'}
                  </Badge>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
