import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Brain, Plus, Trash2, TestTube, Server, Wrench } from 'lucide-react';
import { getMCPProxyAuthToken } from '@/utils/configUtils';
import { InspectorConfig } from '@/lib/configurationTypes';

interface IntentMapping {
  keyword: string;
  server_name: string;
  tool_name: string;
  priority: number;
}

interface Server {
  name: string;
  command: string;
  args: string[];
}

interface Tool {
  name: string;
  description?: string;
}

interface IntentManagerTabProps {
  config: InspectorConfig;
}

const IntentManagerTab = ({ config }: IntentManagerTabProps) => {
  const [mappings, setMappings] = useState<IntentMapping[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [selectedServer, setSelectedServer] = useState<string>('');
  const [selectedTool, setSelectedTool] = useState<string>('');
  const [tools, setTools] = useState<Tool[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [newPriority, setNewPriority] = useState(1);
  const [testKeyword, setTestKeyword] = useState('');
  const [testQuery, setTestQuery] = useState('');
  const [testResult, setTestResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  // Load data from Brain Trust 4 database
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      // 🧠 BRAIN TRUST 4 INTEGRATION: Fetch real data from BT4 database
      const proxyAddress = `${window.location.protocol}//${window.location.hostname}:6277`;
      
      // Get auth token from config (same as ServerSelector)
      const { token: proxyAuthToken, header: proxyAuthTokenHeader } = getMCPProxyAuthToken(config);
      const headers: HeadersInit = {};
      if (proxyAuthToken) {
        headers[proxyAuthTokenHeader] = `Bearer ${proxyAuthToken}`;
      }
      
      const [serversResponse, mappingsResponse] = await Promise.all([
        fetch(`${proxyAddress}/api/bt4/servers`, { headers }),
        fetch(`${proxyAddress}/api/bt4/intents`, { headers })
      ]);

      if (!serversResponse.ok || !mappingsResponse.ok) {
        throw new Error('Failed to fetch data from Brain Trust 4 database');
      }

      const serversData = await serversResponse.json();
      const mappingsData = await mappingsResponse.json();

      // Convert server data to expected format
      const servers: Server[] = serversData.map((server: any) => ({
        name: server.name,
        command: server.command,
        args: server.args
      }));

      // Intent mappings are already in the correct format
      const mappings: IntentMapping[] = mappingsData;

      setServers(servers);
      setMappings(mappings);
      
      console.log(`✅ Loaded ${servers.length} servers and ${mappings.length} intent mappings from BT4 database`);
    } catch (error) {
      console.error('Error loading data from BT4 database:', error);
      
      // Fallback to minimal data if database is unavailable
      const fallbackServers: Server[] = [
        { name: 'mcp-monitor', command: 'mcp-monitor', args: ['-transport', 'stdio'] }
      ];
      const fallbackMappings: IntentMapping[] = [
        { keyword: 'cpu', server_name: 'mcp-monitor', tool_name: 'get_cpu_info', priority: 10 }
      ];
      
      setServers(fallbackServers);
      setMappings(fallbackMappings);
    } finally {
      setLoading(false);
    }
  };

        const handleServerChange = async (serverName: string) => {
          setSelectedServer(serverName);
          setSelectedTool('');
          
          if (serverName) {
            try {
              // 🧠 BRAIN TRUST 4 INTEGRATION: Fetch real tools from database
              const proxyAddress = `${window.location.protocol}//${window.location.hostname}:6277`;
              
              // Get auth token from config
              const { token: proxyAuthToken, header: proxyAuthTokenHeader } = getMCPProxyAuthToken(config);
              const headers: HeadersInit = {};
              if (proxyAuthToken) {
                headers[proxyAuthTokenHeader] = `Bearer ${proxyAuthToken}`;
              }
              
              // Fetch tools for the selected server
              const response = await fetch(`${proxyAddress}/api/bt4/servers/${serverName}/tools`, { headers });
              
              if (response.ok) {
                const toolsData = await response.json();
                const serverTools: Tool[] = toolsData.map((tool: any) => ({
                  name: tool.name,
                  description: tool.description || 'No description available'
                }));
                
                setTools(serverTools);
                console.log(`✅ Loaded ${serverTools.length} real tools for server: ${serverName}`);
              } else {
                console.error(`Failed to fetch tools for ${serverName}: ${response.status} ${response.statusText}`);
                setTools([]);
              }
            } catch (error) {
              console.error('Error loading tools:', error);
              setTools([]);
            }
          } else {
            setTools([]);
          }
        };


  const addMapping = async () => {
    if (!newKeyword || !selectedServer || !selectedTool) {
      alert('Please fill in all fields');
      return;
    }

    try {
      const newMapping: IntentMapping = {
        keyword: newKeyword,
        server_name: selectedServer,
        tool_name: selectedTool,
        priority: newPriority,
      };

      // 🧠 BRAIN TRUST 4 INTEGRATION: Add mapping via API
      const proxyAddress = `${window.location.protocol}//${window.location.hostname}:6277`;
      
      // Get auth token from config
      const { token: proxyAuthToken, header: proxyAuthTokenHeader } = getMCPProxyAuthToken(config);
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };
      if (proxyAuthToken) {
        headers[proxyAuthTokenHeader] = `Bearer ${proxyAuthToken}`;
      }
      
      const response = await fetch(`${proxyAddress}/api/bt4/intents`, {
        method: 'POST',
        headers,
        body: JSON.stringify(newMapping),
      });

      if (!response.ok) {
        throw new Error('Failed to add intent mapping');
      }

      // Update local state and refresh data
      setMappings([...mappings, newMapping]);
      setNewKeyword('');
      setSelectedServer('');
      setSelectedTool('');
      setNewPriority(1);
      
      // Reload data from database to ensure consistency
      await loadData();
      
      console.log(`✅ Added intent mapping: ${newKeyword} -> ${selectedServer}:${selectedTool}`);
    } catch (error) {
      console.error('Error adding mapping:', error);
      alert('Error adding mapping to Brain Trust 4 database');
    }
  };

  const deleteMapping = async (keyword: string) => {
    if (!confirm(`Delete mapping for keyword "${keyword}"?`)) return;

    try {
      // For KISS approach: Update local state (full API would call DELETE /api/bt4/intents/{keyword})
      setMappings(mappings.filter(m => m.keyword !== keyword));
      console.log(`🗑️ Removed intent mapping for keyword: ${keyword}`);
      
      // Note: In a full implementation, this would make a DELETE API call:
      // await fetch(`/api/bt4/intents/${keyword}`, { method: 'DELETE' });
    } catch (error) {
      console.error('Error deleting mapping:', error);
      alert('Error deleting mapping');
    }
  };

  const testMapping = async (keyword: string) => {
    try {
      const mapping = mappings.find(m => m.keyword === keyword);
      if (mapping) {
        setTestResult({
          keyword,
          server: mapping.server_name,
          tool: mapping.tool_name,
          query: `Test query with ${keyword}`,
          status: 'mapped'
        });
      } else {
        setTestResult({ error: 'No intent mapping found' });
      }
    } catch (error) {
      console.error('Error testing mapping:', error);
      setTestResult({ error: 'Error testing mapping' });
    }
  };

  const testIntent = async () => {
    if (!testKeyword || !testQuery) {
      alert('Please fill in both keyword and query');
      return;
    }

    try {
      const mapping = mappings.find(m => m.keyword === testKeyword);
      if (mapping) {
        setTestResult({
          keyword: testKeyword,
          server: mapping.server_name,
          tool: mapping.tool_name,
          query: testQuery,
          status: 'mapped'
        });
      } else {
        setTestResult({ error: 'No intent mapping found' });
      }
    } catch (error) {
      console.error('Error testing intent:', error);
      setTestResult({ error: 'Error testing intent' });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 dark:border-blue-400 mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading intent mappings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center space-x-2">
        <Brain className="w-6 h-6 text-blue-600 dark:text-blue-400" />
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Intent Management</h2>
      </div>

      {/* Add New Intent Mapping */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
        <div className="flex items-center space-x-2 mb-4">
          <Plus className="w-5 h-5 text-gray-700 dark:text-gray-300" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Add New Intent Mapping</h3>
        </div>
        <p className="text-gray-600 dark:text-gray-400 mb-4">
          Map keywords to specific server tools for intelligent routing
        </p>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <Label htmlFor="keyword">Keyword</Label>
              <Input
                id="keyword"
                placeholder="e.g., 'cpu', 'memory'"
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="server">Server</Label>
              <Select value={selectedServer} onValueChange={handleServerChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select Server" />
                </SelectTrigger>
                <SelectContent>
                  {servers.map(server => (
                    <SelectItem key={server.name} value={server.name}>
                      <div className="flex items-center space-x-2">
                        <Server className="w-4 h-4" />
                        <span>{server.name}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="tool">Tool</Label>
              <Select value={selectedTool} onValueChange={setSelectedTool} disabled={!selectedServer}>
                <SelectTrigger>
                  <SelectValue placeholder="Select Tool" />
                </SelectTrigger>
                <SelectContent>
                  {tools.map(tool => (
                    <SelectItem key={tool.name} value={tool.name}>
                      <div className="flex items-center space-x-2">
                        <Wrench className="w-4 h-4" />
                        <span>{tool.name}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="priority">Priority</Label>
              <Input
                id="priority"
                type="number"
                min="1"
                max="10"
                value={newPriority}
                onChange={(e) => setNewPriority(Number(e.target.value))}
              />
            </div>
          </div>
          <Button onClick={addMapping} className="w-full">
            <Plus className="w-4 h-4 mr-2" />
            Add Mapping
          </Button>
        </div>
      </div>

      {/* Current Mappings */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Current Intent Mappings</h3>
          <p className="text-gray-600 dark:text-gray-400">
            {mappings.length} intent mappings configured
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th className="text-left p-2 text-gray-900 dark:text-white">Keyword</th>
                <th className="text-left p-2 text-gray-900 dark:text-white">Server</th>
                <th className="text-left p-2 text-gray-900 dark:text-white">Tool</th>
                <th className="text-left p-2 text-gray-900 dark:text-white">Priority</th>
                <th className="text-left p-2 text-gray-900 dark:text-white">Actions</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((mapping) => (
                <tr key={mapping.keyword} className="border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700">
                  <td className="p-2">
                    <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                      {mapping.keyword}
                    </span>
                  </td>
                  <td className="p-2">
                    <div className="flex items-center space-x-2">
                      <Server className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                      <span className="text-gray-900 dark:text-white">{mapping.server_name}</span>
                    </div>
                  </td>
                  <td className="p-2">
                    <div className="flex items-center space-x-2">
                      <Wrench className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                      <span className="text-gray-900 dark:text-white">{mapping.tool_name}</span>
                    </div>
                  </td>
                  <td className="p-2">
                    <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                      {mapping.priority}
                    </span>
                  </td>
                  <td className="p-2">
                    <div className="flex space-x-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => testMapping(mapping.keyword)}
                      >
                        <TestTube className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => deleteMapping(mapping.keyword)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Test Intent */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
        <div className="flex items-center space-x-2 mb-4">
          <TestTube className="w-5 h-5 text-gray-700 dark:text-gray-300" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Test Intent Mapping</h3>
        </div>
        <p className="text-gray-600 dark:text-gray-400 mb-4">
          Test how keywords map to server tools
        </p>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="test-keyword">Keyword to Test</Label>
              <Input
                id="test-keyword"
                placeholder="Enter keyword"
                value={testKeyword}
                onChange={(e) => setTestKeyword(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="test-query">Test Query</Label>
              <Input
                id="test-query"
                placeholder="Enter test query"
                value={testQuery}
                onChange={(e) => setTestQuery(e.target.value)}
              />
            </div>
          </div>
          <Button onClick={testIntent} className="w-full">
            <TestTube className="w-4 h-4 mr-2" />
            Test Intent
          </Button>
          {testResult && (
            <div className={`p-4 rounded-lg ${
              testResult.error 
                ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200' 
                : 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-200'
            }`}>
              {testResult.error ? (
                <p>{testResult.error}</p>
              ) : (
                <div>
                  <p className="font-semibold">Intent Mapped Successfully!</p>
                  <p>Server: {testResult.server}</p>
                  <p>Tool: {testResult.tool}</p>
                  <p>Query: {testResult.query}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default IntentManagerTab;
