import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fetchApi, postApi } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Key, Copy, Trash2, RefreshCw, Check } from 'lucide-react';

interface KeyData {
  exists: boolean;
  masked_key?: string;
}

export default function Webhook() {
  const [keyData, setKeyData] = useState<KeyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const user = getUser();

  useEffect(() => { loadKey(); }, []);

  if (!user?.tenantId) {
    return <div className="text-muted-foreground">No tenant context. Super admin cannot manage webhook keys directly.</div>;
  }

  async function loadKey() {
    setLoading(true);
    try {
      const data = await fetchApi<KeyData>('/webhook/keys');
      setKeyData(data);
    } catch {
      setKeyData({ exists: false });
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerate() {
    if (keyData?.exists && !confirm('This will replace your existing API key. Any integrations using the old key will stop working. Continue?')) return;
    try {
      const data = await postApi<{ key: string }>('/webhook/keys', {});
      setNewKey(data.key);
      setKeyData({ exists: true, masked_key: data.key.substring(0, 8) + '...' });
    } catch {}
  }

  async function handleRevoke() {
    if (!confirm('Revoke this API key? Any integrations using it will stop working.')) return;
    try {
      await fetchApi('/webhook/keys', { method: 'DELETE' });
      setKeyData({ exists: false });
      setNewKey(null);
    } catch {}
  }

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  }

  const curlExample = `curl -X POST ${window.location.origin}/api/webhook/send \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: your-api-key" \\
  -d '{"number":["group@g.us"],"message":"Hello"}'`;

  const payloadExample = `{
  "number": ["group@g.us"],
  "message": "Hello"
}`;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Webhook</h1>

      {/* Section 1: API Key Management */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Key className="h-4 w-4" />API Key
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : keyData?.exists ? (
            <>
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">Current key:</span>
                <code className="bg-muted px-3 py-1 rounded text-sm font-mono">{keyData.masked_key}</code>
                <Badge variant="default">Active</Badge>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={handleGenerate}>
                  <RefreshCw className="h-4 w-4 mr-2" />Generate New Key
                </Button>
                <Button variant="outline" className="text-destructive" onClick={handleRevoke}>
                  <Trash2 className="h-4 w-4 mr-2" />Revoke
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">No API key configured. Generate one to use the webhook endpoint.</p>
              <Button onClick={handleGenerate}>
                <Key className="h-4 w-4 mr-2" />Generate Key
              </Button>
            </>
          )}

          {newKey && (
            <div className="border-2 border-yellow-500 bg-yellow-50 dark:bg-yellow-950 rounded-md p-4 space-y-2">
              <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                Save this key -- it won't be shown again
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-background border rounded px-3 py-2 text-sm font-mono break-all">{newKey}</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(newKey, 'key')}>
                  {copied === 'key' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 2: Documentation */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Documentation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Endpoint</h3>
            <code className="block bg-muted px-3 py-2 rounded text-sm font-mono">POST /api/webhook/send</code>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">Header</h3>
            <code className="block bg-muted px-3 py-2 rounded text-sm font-mono">X-API-Key: your-api-key</code>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">Payload</h3>
            <pre className="bg-muted px-4 py-3 rounded text-sm font-mono overflow-x-auto">{payloadExample}</pre>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">cURL Example</h3>
              <Button size="sm" variant="outline" onClick={() => copyToClipboard(curlExample, 'curl')}>
                {copied === 'curl' ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
                {copied === 'curl' ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <pre className="bg-muted px-4 py-3 rounded text-sm font-mono overflow-x-auto whitespace-pre-wrap">{curlExample}</pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
