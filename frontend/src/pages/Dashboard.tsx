import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fetchApi } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import { Bot, Users, AlertTriangle, MessageSquare } from 'lucide-react';

interface BotStatusResponse {
  success: boolean;
  data: { active: string[]; inactive: string[] };
}

interface StatsData {
  [hour: string]: { [bot: string]: number };
}

export default function Dashboard() {
  const [botData, setBotData] = useState<BotStatusResponse | null>(null);
  const [todayStats, setTodayStats] = useState<StatsData>({});
  const [failedCount, setFailedCount] = useState(0);
  const [groupCount, setGroupCount] = useState(0);
  const { botStatuses } = useSocket();

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [status, failed, groups] = await Promise.all([
        fetchApi<BotStatusResponse>('/bot-status'),
        fetchApi<{ success: boolean; data: unknown[] }>('/failed-requests'),
        fetchApi<{ success: boolean; group_count: number }>('/groups').catch(() => ({ success: false, group_count: 0 })),
      ]);
      setBotData(status);
      setFailedCount(failed.data?.length || 0);
      setGroupCount(groups.group_count || 0);

      const today = new Date().toISOString().split('T')[0];
      const stats = await fetchApi<{ success: boolean; data: StatsData }>(`/stats/${today}`).catch(() => ({ success: false, data: {} }));
      setTodayStats(stats.data || {});
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    }
  }

  const totalMessagesToday = Object.values(todayStats).reduce((sum, hour) => {
    return sum + Object.values(hour).reduce((s, v) => s + v, 0);
  }, 0);

  const activeBots = botData?.data?.active || [];
  const inactiveBots = botData?.data?.inactive || [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Bots</CardTitle>
            <Bot className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeBots.length}</div>
            <p className="text-xs text-muted-foreground">{inactiveBots.length} inactive</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Messages Today</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalMessagesToday}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Groups</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{groupCount}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Failed Requests</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{failedCount}</div>
          </CardContent>
        </Card>
      </div>

      <h2 className="text-lg font-semibold">Bot Status</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...activeBots, ...inactiveBots].map(botId => {
          const realtimeStatus = botStatuses.get(botId);
          const isOnline = realtimeStatus
            ? realtimeStatus.status === 'open'
            : activeBots.includes(botId);

          const botMessages = Object.values(todayStats).reduce((sum, hour) => {
            return sum + (hour[botId.split('_')[0]] || 0);
          }, 0);

          return (
            <Card key={botId}>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{botId}</span>
                  <Badge variant={isOnline ? 'default' : 'destructive'}>
                    {isOnline ? 'Online' : 'Offline'}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-2">
                  Messages today: {botMessages}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
