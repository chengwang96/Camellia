import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { tools } = require('./goal-tools.js');

export default function extension(pi) {
  pi.on('tool_call', async (event, context) => {
    if (event.toolName.startsWith('camellia_') || process.env.CAMELLIA_PI_PERMISSION === 'full') return;
    if (['read', 'grep', 'find', 'ls'].includes(event.toolName)) return;
    if (!context.hasUI || !await context.ui.confirm(event.toolName, JSON.stringify(event.input)))
      return { block: true, reason: 'Action denied by the user' };
  });
  if (!process.env.CAMELLIA_GOAL_ENDPOINT) return;
  for (const tool of tools) pi.registerTool({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema,
    async execute(_toolCallId, args, signal) {
      const result = await new Promise((resolve, reject) => {
        const socket = net.createConnection(process.env.CAMELLIA_GOAL_ENDPOINT);
        let buffer = '';
        const abort = () => socket.destroy(new Error('Tool call cancelled'));
        socket.setEncoding('utf8');
        socket.setTimeout(10000, () => socket.destroy(new Error('Camellia tool timed out')));
        socket.on('error', reject);
        socket.on('connect', () => socket.write(JSON.stringify({ token: process.env.CAMELLIA_GOAL_TOKEN, name: tool.name, arguments: args }) + '\n'));
        socket.on('data', chunk => {
          buffer += chunk;
          if (!buffer.includes('\n')) return;
          try { resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n')))); } catch (error) { reject(error); }
          socket.end();
        });
        socket.on('close', () => { signal?.removeEventListener('abort', abort); reject(new Error('Camellia tool connection closed')); });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result, isError: result.ok === false };
    },
  });
}
