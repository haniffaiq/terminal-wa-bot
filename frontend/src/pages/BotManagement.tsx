import { useCallback, useEffect, useMemo, useState } from 'react';
import { PlugZap, Plus, Power, RotateCcw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { fetchApi, postApi } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import type { ApiResponse, BotHealth } from '@/lib/opsTypes';

interface BotStatusResponse {
  success: boolean;
  data: { active: string[]; inactive: string[] };
}

function formatDate(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function statusVariant(status: string): 'default' | 'destructive' | 'secondary' | 'outline' {
  const normalized = status.toLowerCase();
  if (normalized === 'online' || normalized === 'open' || normalized === 'connected') return 'default';
  if (normalized === 'restarting' || normalized === 'connecting') return 'secondary';
  if (normalized === 'offline' || normalized === 'closed' || normalized === 'disconnected') return 'destructive';
  return 'outline';
}

function legacyHealth(botId: string, online: boolean): BotHealth {
  return {
    botId,
    status: online ? 'online' : 'offline',
    successCount: 0,
    failCount: 0,
    activeJobCount: 0,
  };
}

export default function BotManagement() {
  const [botHealth, setBotHealth] = useState<BotHealth[]>([]);
  const [usingFallback, setUsingFallback] = useState(false);
  const [newBotId, setNewBotId] = useState('');
  const [isAdminBot, setIsAdminBot] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const { botStatuses, qrCode, setQrCode } = useSocket();

  const loadBots = useCallback(async () => {
    try {
      const data = await fetchApi<ApiResponse<BotHealth[]>>('/bot-health');
      setBotHealth(data.data || data.bots || []);
      setUsingFallback(false);
    } catch (err) {
      console.error('Failed to load bot health:', err);
      const fallback = await fetchApi<BotStatusResponse>('/bot-status');
      setBotHealth([
        ...(fallback.data?.active || []).map((botId) => legacyHealth(botId, true)),
        ...(fallback.data?.inactive || []).map((botId) => legacyHealth(botId, false)),
      ]);
      setUsingFallback(true);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadBots();
    });
  }, [loadBots]);

  async function handleAddBot() {
    if (!newBotId.trim()) return;
    try {
      const data = await postApi<{ success: boolean; qr?: string; is_admin_bot?: boolean }>('/addbot', {
        botname: newBotId.trim(),
        is_admin_bot: isAdminBot,
      });
      if (data.qr) {
        setQrCode({ botId: newBotId.trim(), qr: data.qr });
      }
      await loadBots();
    } catch (err) {
      console.error('Failed to add bot:', err);
    }
  }

  async function runBotAction(botId: string, action: () => Promise<unknown>) {
    setLoading(botId);
    try {
      await action();
      await loadBots();
    } finally {
      setLoading(null);
    }
  }

  async function handleRestart(botId: string) {
    await runBotAction(botId, () => postApi('/restart', { botname: botId }));
  }

  async function handleReconnect(bot: { botId: string; tenantId: string | null }) {
    await runBotAction(bot.botId, () => postApi(
      `/bot-health/${encodeURIComponent(bot.botId)}/reconnect`,
      bot.tenantId ? { tenant_id: bot.tenantId } : {}
    ));
  }

  async function handleDisconnect(botId: string) {
    await runBotAction(botId, () => postApi('/disconnect', { botId }));
  }

  async function handleDelete(botId: string) {
    if (!confirm(`Delete bot "${botId}"? This will remove its session permanently.`)) return;
    await runBotAction(botId, () => postApi('/deletebot', { botId }));
  }

  const rows = useMemo(() => {
    return botHealth.map((bot) => {
      const botId = bot.botId || bot.bot_id || 'unknown';
      const tenantId = bot.tenantId || bot.tenant_id || null;
      const realtimeStatus = botStatuses.get(botId);
      const rawStatus = realtimeStatus?.status || bot.status || bot.state || 'unknown';
      const normalizedStatus = rawStatus === 'open' ? 'online' : rawStatus;
      const heartbeat = bot.heartbeatAt || bot.heartbeat_at || bot.lastHeartbeatAt || bot.last_heartbeat_at || null;
      const lastSeen = bot.lastSeenAt || bot.last_seen_at || bot.updated_at || heartbeat;

      return {
        ...bot,
        botId,
        tenantId,
        tenantName: bot.tenantName || bot.tenant_name || null,
        displayStatus: normalizedStatus,
        heartbeat,
        lastSeen,
        successes: bot.successCount ?? bot.success_count ?? 0,
        failures: bot.failCount ?? bot.fail_count ?? bot.failureCount ?? bot.failure_count ?? bot.consecutive_failures ?? 0,
        activeJobs: bot.activeJobCount ?? bot.active_job_count ?? bot.activeJobs ?? bot.active_jobs ?? 0,
      };
    });
  }, [botHealth, botStatuses]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Bot Management</h1>
          {usingFallback && <Badge variant="secondary">Legacy fallback</Badge>}
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setQrCode(null); }}>
          <DialogTrigger render={<Button />}>
            <Plus className="h-4 w-4 mr-2" />Add Bot
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New Bot</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Bot ID</Label>
                <Input
                  value={newBotId}
                  onChange={(event) => setNewBotId(event.target.value)}
                  placeholder="e.g. bot_03"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isAdminBot}
                  onChange={(event) => setIsAdminBot(event.target.checked)}
                />
                <span className="text-sm">Set as Admin Bot (handles WhatsApp commands)</span>
              </label>
              <Button onClick={handleAddBot} disabled={!newBotId.trim()}>
                {isAdminBot ? 'Add Admin Bot' : 'Add Operation Bot'}
              </Button>
              {qrCode && (
                <div className="flex flex-col items-center gap-2">
                  <p className="text-sm text-muted-foreground">Scan this QR code with WhatsApp:</p>
                  <img src={qrCode.qr} alt="QR Code" className="w-64 h-64" />
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-md border bg-accent border-border p-4 text-sm text-accent-foreground">
        <p><strong>admin_bot</strong> starts with the server and handles WhatsApp commands.</p>
        <p className="mt-1">Operation bots handle message delivery. Each bot requires a different WhatsApp number.</p>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bot</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tenant</TableHead>
              <TableHead>Heartbeat</TableHead>
              <TableHead>Last Seen</TableHead>
              <TableHead className="text-right">Success</TableHead>
              <TableHead className="text-right">Fail</TableHead>
              <TableHead className="text-right">Active Jobs</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((bot) => {
              const canReconnect = ['offline', 'closed', 'disconnected', 'unknown'].includes(bot.displayStatus.toLowerCase());

              return (
                <TableRow key={bot.botId}>
                  <TableCell className="font-medium">{bot.botId}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(bot.displayStatus)}>
                      {bot.displayStatus}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{bot.tenantName || bot.tenantId || '-'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(bot.heartbeat)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(bot.lastSeen)}</TableCell>
                  <TableCell className="text-right tabular-nums">{bot.successes}</TableCell>
                  <TableCell className="text-right tabular-nums">{bot.failures}</TableCell>
                  <TableCell className="text-right tabular-nums">{bot.activeJobs}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleReconnect(bot)}
                        disabled={loading === bot.botId || !canReconnect}
                        title="Reconnect bot"
                      >
                        <PlugZap className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRestart(bot.botId)}
                        disabled={loading === bot.botId}
                        title="Restart bot"
                      >
                        <RotateCcw className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDisconnect(bot.botId)}
                        disabled={loading === bot.botId}
                        title="Disconnect bot"
                      >
                        <Power className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDelete(bot.botId)}
                        disabled={loading === bot.botId}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        title="Delete bot"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">No bots found</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
