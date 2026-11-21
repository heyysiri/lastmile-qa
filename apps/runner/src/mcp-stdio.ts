import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {createMcpServer} from './mcp';

try {
 const server=createMcpServer();
 const handle=serveStdio(()=>server,{onerror:()=>console.error('lastmile qa. MCP protocol error')});
 process.once('SIGTERM',()=>{void handle.close();});
 process.once('SIGINT',()=>{void handle.close();});
} catch {
 console.error('Cannot start lastmile qa. MCP. Check RUNNER_URL, RUNNER_API_TOKEN, LASTMILE_DASHBOARD_URL, and LASTMILE_MCP_TIMEOUT_MS.');
 process.exitCode=1;
}
