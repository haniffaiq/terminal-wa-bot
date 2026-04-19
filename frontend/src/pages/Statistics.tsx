import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchApi } from '@/lib/api';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

interface StatsData {
  [hour: string]: { [bot: string]: number };
}

const COLORS = ['#2563eb', '#16a34a', '#dc2626', '#ca8a04', '#9333ea', '#0891b2', '#e11d48', '#65a30d'];

export default function Statistics() {
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [stats, setStats] = useState<StatsData>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadStats();
  }, [date]);

  async function loadStats() {
    setLoading(true);
    try {
      const data = await fetchApi<{ success: boolean; data: StatsData }>(`/stats/${date}`);
      setStats(data.data || {});
    } catch {
      setStats({});
    } finally {
      setLoading(false);
    }
  }

  const allBots = new Set<string>();
  Object.values(stats).forEach(hour => {
    Object.keys(hour).forEach(bot => allBots.add(bot));
  });
  const botList = Array.from(allBots);

  const chartData = Array.from({ length: 24 }, (_, i) => {
    const hour = String(i).padStart(2, '0');
    const entry: Record<string, string | number> = { hour: `${hour}:00` };
    botList.forEach(bot => {
      entry[bot] = stats[hour]?.[bot] || 0;
    });
    return entry;
  });

  const botTotals: Record<string, number> = {};
  Object.values(stats).forEach(hour => {
    Object.entries(hour).forEach(([bot, count]) => {
      botTotals[bot] = (botTotals[bot] || 0) + count;
    });
  });

  const grandTotal = Object.values(botTotals).reduce((s, v) => s + v, 0);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Statistics</h1>

      <div className="flex items-end gap-4">
        <div className="space-y-2">
          <Label>Date</Label>
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-48" />
        </div>
      </div>

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Messages per Hour</CardTitle>
            </CardHeader>
            <CardContent>
              {botList.length === 0 ? (
                <p className="text-gray-400 text-center py-10">No data for this date</p>
              ) : (
                <ResponsiveContainer width="100%" height={400}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="hour" fontSize={12} />
                    <YAxis fontSize={12} />
                    <Tooltip />
                    <Legend />
                    {botList.map((bot, i) => (
                      <Bar key={bot} dataKey={bot} fill={COLORS[i % COLORS.length]} stackId="a" />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-gray-500">Total</p>
                <p className="text-2xl font-bold">{grandTotal}</p>
              </CardContent>
            </Card>
            {Object.entries(botTotals).map(([bot, total]) => (
              <Card key={bot}>
                <CardContent className="pt-6">
                  <p className="text-sm text-gray-500 truncate">{bot}</p>
                  <p className="text-2xl font-bold">{total}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
