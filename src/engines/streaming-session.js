'use strict';
const fs = require('node:fs');
const path = require('node:path');

// UI event replay and display history shared by native engine transports.
class StreamingSession {
  endBlock() {
    if (this.activeBlock) this.emitStream({ type: 'content_block_stop', index: this.activeBlock.index });
    this.activeBlock = null;
  }

  historyFile() {
    const dir = path.join(this.history.root, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, this.sessionId + '.jsonl');
  }

  appendHistory(role, text, outputBlocks) {
    fs.appendFileSync(this.historyFile(), JSON.stringify({ type: role, cwd: this.settings.cwd,
      ...(outputBlocks ? { outputBlocks } : {}),
      message: { role, content: [{ type: 'text', text }] } }) + '\n');
  }

  finish(result) {
    if (!this.running) return;
    clearTimeout(this.cancelTimer);
    this.endBlock();
    if (this.sessionId && (this.text || result.outputBlocks?.length)) {
      try { this.appendHistory('assistant', this.text, result.outputBlocks); }
      catch (error) { this.log(this.name + ': history write failed: ' + error.message); result = { ...result, subtype: 'error', is_error: true, result: "Could not save session history: " + error.message }; }
    }
    this.permissions.clear();
    this.running = false;
    const event = { type: 'result', session_id: this.sessionId, result: this.text, duration_ms: Date.now() - this.startedAt, ...result };
    this.emit(event);
    try { this.onResult(event); }
    catch (error) { this.log(this.name + ': result hook failed: ' + error.message); }
  }


  emit(event) {
    const message = { ...event, runId: this.gen, eventSeq: ++this.eventSeq, workspaceId: this.opts.workspaceId || null };
    if (this.running) {
      const last = this.replayEvents.at(-1);
      const delta = message.event?.delta;
      // Keep only the current turn for reattachment, coalescing token chunks.
      const key = { text_delta: 'text', thinking_delta: 'thinking', input_json_delta: 'partial_json' }[delta?.type];
      if (key && message.type === 'stream_event' && last?.type === 'stream_event'
        && message.event.type === 'content_block_delta' && last.event?.type === 'content_block_delta'
        && Number.isInteger(message.event.index) && last.event.index === message.event.index && last.event.delta?.type === delta.type
        && typeof delta[key] === 'string' && typeof last.event.delta[key] === 'string') {
        last.event.delta[key] += delta[key];
        last.eventSeq = message.eventSeq;
      } else this.replayEvents.push(structuredClone(message));
    }
    // A throwing subscriber must not wedge the engine's event loop.
    try { this.onEvent(message); }
    catch (error) { this.log(this.name + ': event handling failed: ' + error.message); }
  }
  emitStream(event) { this.emit({ type: 'stream_event', event }); }

  async liveState() {
    if (!this.running) return null;
    const file = this.sessionId && this.history.find(this.sessionId);
    const { messages = [] } = file ? await this.history.transcript(this.sessionId) : {};
    if (!this.running) return null;
    if (messages.at(-1)?.role === 'user' && messages.at(-1).text === this.prompt) messages.pop();
    return { sessionId: this.sessionId, workspaceId: this.opts.workspaceId || null, runId: this.gen,
      messages, prompt: this.prompt, events: this.replayEvents, eventSeq: this.eventSeq };
  }

}
module.exports = { StreamingSession };
