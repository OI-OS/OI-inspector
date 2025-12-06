import { useState, useEffect } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Server } from 'lucide-react';
import { InspectorConfig } from '@/lib/configurationTypes';

interface McpServer {
  name: string;
  command: string;
  args: string[];
  description?: string;
  tools_count?: number;
  health_status?: string;
}

interface ServerSelectorProps {
  onServerSelect: (server: McpServer | null) => void;
  config: InspectorConfig;
  className?: string;
}

const ServerSelector = ({ onServerSelect, className = "" }: ServerSelectorProps) => {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [selectedServer, setSelectedServer] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadServers();
  }, []);

  const loadServers = async () => {
    setLoading(true);
    try {
      // 🧠 BRAIN TRUST 4 INTEGRATION: Fetch real servers from BT4 database
      // Use the proxy server port where API endpoints are actually served
      const proxyAddress = `${window.location.protocol}//${window.location.hostname}:6277`;
      
      // Get auth token from URL parameters (MCP_PROXY_AUTH_TOKEN)
      const urlParams = new URLSearchParams(window.location.search);
      const proxyAuthToken = urlParams.get('MCP_PROXY_AUTH_TOKEN');
      
      const headers: HeadersInit = {};
      if (proxyAuthToken) {
        headers['Authorization'] = `Bearer ${proxyAuthToken}`;
      }
      
      const response = await fetch(`${proxyAddress}/api/bt4/servers`, { headers });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const serversData: McpServer[] = await response.json();
      setServers(serversData);
      
      console.log(`✅ Loaded ${serversData.length} servers from Brain Trust 4 database`);
    } catch (error) {
      console.error('Error loading servers from BT4 database:', error);
      
      // Fallback to a minimal server list if database is unavailable
      const fallbackServers: McpServer[] = [
        {
          name: 'mcp-monitor',
          command: 'mcp-monitor',
          args: ['-transport', 'stdio'],
          description: 'System monitoring (fallback mode)',
          health_status: 'unknown'
        }
      ];
      setServers(fallbackServers);
    } finally {
      setLoading(false);
    }
  };

  const handleServerChange = (serverName: string) => {
    setSelectedServer(serverName);
    if (serverName === 'manual') {
      onServerSelect(null);
    } else {
      const server = servers.find(s => s.name === serverName);
      onServerSelect(server || null);
    }
  };

  if (loading) {
    return (
      <div className={`space-y-2 ${className}`}>
        <label className="text-sm font-medium text-gray-600 dark:text-gray-400">
          MCP Server
        </label>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          Loading servers...
        </div>
      </div>
    );
  }

  return (
    <div className={`space-y-2 ${className}`}>
      <label className="text-sm font-medium" htmlFor="server-select">
        MCP Server
      </label>
      <Select value={selectedServer} onValueChange={handleServerChange}>
        <SelectTrigger id="server-select">
          <SelectValue placeholder="Select an MCP server" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="manual">
            <div className="flex items-center space-x-2">
              <Server className="w-4 h-4" />
              <span>Manual Configuration</span>
            </div>
          </SelectItem>
          {servers.map(server => (
            <SelectItem key={server.name} value={server.name}>
              <div className="flex items-center space-x-2">
                <div className="flex items-center space-x-1">
                  <Server className="w-4 h-4" />
                  {server.health_status && (
                    <div className={`w-2 h-2 rounded-full ${
                      server.health_status === 'healthy' ? 'bg-green-500' : 
                      server.health_status === 'unhealthy' ? 'bg-red-500' : 'bg-yellow-500'
                    }`} />
                  )}
                </div>
                <div className="flex-1">
                  <div className="flex items-center space-x-2">
                    <span className="font-medium">{server.name}</span>
                    {server.tools_count !== undefined && (
                      <span className="text-xs bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 px-1.5 py-0.5 rounded">
                        {server.tools_count} tools
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {server.description || 'No description available'}
                  </div>
                </div>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

export default ServerSelector;
