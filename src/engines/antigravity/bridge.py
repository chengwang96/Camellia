"""Camellia's ACP transport for the official Antigravity SDK.

Only the local router URL crosses this boundary. The SDK owns agent execution
and persistence; Camellia owns credentials, workspace metadata and presentation.
"""

import asyncio
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import uuid

from session_storage import copy_session

from google.antigravity import Agent, LocalOpenAIAgentConfig, types
from google.antigravity.hooks import hooks, policy


def emit(message):
    print(json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=False), flush=True)


def read_json(file, fallback=None):
    return json.loads(file.read_text(encoding="utf-8")) if file.exists() else fallback


class Bridge:
    def __init__(self, config):
        self.config = config
        self.tool_free = "executionPolicy" in config
        if self.tool_free:
            if config["executionPolicy"] != "tool-free-v1" or importlib.metadata.version("google-antigravity") not in ("0.1.17", "0.1.20"):
                raise ValueError("Unverified Antigravity execution policy or SDK version")
            native = config.get("settings", {})
            if native.get("mcpServers") or native.get("skillsPaths"):
                raise ValueError("Tool-free Antigravity cannot load MCP servers or skills")
        self.root = Path(config["home"])
        self.agent = None
        self.session_id = None
        self.model = None
        self.mode = "default"
        self.pending = {}
        self.turn = None
        self.mcp_servers = []
        self.preparation = None
        self.prepared_id = None
        self.preparation_closed = False

    def update(self, update):
        emit({"method": "session/update", "params": {"sessionId": self.session_id, "update": update}})

    async def approve(self, tool):
        if self.tool_free:
            return False
        request_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        name = tool.name.value if isinstance(tool.name, types.BuiltinTools) else tool.name
        emit({"id": request_id, "method": "session/request_permission", "params": {
            "sessionId": self.session_id,
            "toolCall": {"title": name, "rawInput": tool.args, "toolCallId": tool.id},
            "options": [{"optionId": "allow", "kind": "allow_once", "name": "Allow once"},
                        {"optionId": "deny", "kind": "reject_once", "name": "Deny"}],
        }})
        try:
            allowed = await future
            if not allowed:
                self.update({"sessionUpdate": "tool_call_update", "toolCallId": tool.id or tool.step_id,
                             "title": name, "status": "failed", "content": [{"type": "content",
                             "content": {"type": "text", "text": "Action denied"}}]})
            return allowed
        finally:
            self.pending.pop(request_id, None)

    async def open_agent(self):
        # The SDK copies configuration. A bound Bridge method would also copy
        # its active asyncio task; a function keeps the callback by reference.
        async def approve(tool):
            return await self.approve(tool)

        @hooks.on_compaction
        async def on_compaction(step):
            self.update({"sessionUpdate": "camellia_compaction", "state": "completed"})

        reads = [types.BuiltinTools.VIEW_FILE, types.BuiltinTools.LIST_DIR,
                 types.BuiltinTools.FIND_FILE, types.BuiltinTools.SEARCH_DIR,
                 types.BuiltinTools.FINISH]
        policies = [policy.ask_user("*", handler=approve)]
        policies.extend(policy.allow(tool.value) for tool in reads)
        if self.mode == "acceptEdits":
            policies.extend(policy.allow(tool.value) for tool in [types.BuiltinTools.CREATE_FILE, types.BuiltinTools.EDIT_FILE])
        if self.mode == "bypassPermissions":
            policies = [policy.allow_all()]
        if self.tool_free:
            policies = [policy.deny("*")]
        capabilities = types.CapabilitiesConfig(
            enabled_tools=[] if self.tool_free else reads if self.mode == "plan" else None,
            # Clarifications use regular chat turns in the shared interface.
            disabled_tools=None if self.tool_free or self.mode == "plan" else [types.BuiltinTools.ASK_QUESTION],
            enable_subagents=not self.tool_free and self.mode != "plan",
        )

        @hooks.pre_tool_call_decide
        async def before_tool(tool):
            name = tool.name.value if isinstance(tool.name, types.BuiltinTools) else tool.name
            self.update({"sessionUpdate": "tool_call", "toolCallId": tool.id or tool.step_id,
                         "title": name, "rawInput": tool.args, "status": "in_progress"})
            return types.HookResult(allow=True)

        @hooks.post_tool_call
        async def after_tool(tool):
            name = tool.name.value if isinstance(tool.name, types.BuiltinTools) else tool.name
            result = tool.error or tool.result
            self.update({"sessionUpdate": "tool_call_update", "toolCallId": tool.id or tool.step_id,
                         "title": name, "status": "failed" if tool.error else "completed",
                         "content": [{"type": "content", "content": {"type": "text", "text":
                             json.dumps(result, ensure_ascii=False, default=str) if isinstance(result, (dict, list)) else str(result or "")}}]})

        @hooks.on_tool_error
        async def tool_error(error):
            self.update({"sessionUpdate": "tool_call_update", "toolCallId": error.call_id or error.step_id,
                         "title": error.tool_name, "status": "failed", "content": [{"type": "content",
                         "content": {"type": "text", "text": str(error)}}]})

        native = self.config.get("settings", {})
        servers = []
        configured_servers = dict(native.get("mcpServers", {}))
        for server in self.mcp_servers:
            configured_servers[server["name"]] = {"command": server["command"], "args": server.get("args", []),
                                                  "env": {entry["name"]: entry["value"] for entry in server.get("env", [])}}
        for name, server in configured_servers.items():
            if (self.mode == "plan" and (name != "camellia_goals" or not any(entry["name"] == name for entry in self.mcp_servers))) or server.get("disabled"):
                continue
            if "command" in server:
                servers.append(types.McpStdioServer(name=name, command=server["command"], args=server.get("args", []), env=server.get("env")))
            else:
                servers.append(types.McpStreamableHttpServer(name=name, url=server["url"], headers=server.get("headers", {})))
        self.session_dir = self.root / "sessions" / self.session_id
        self.session_dir.mkdir(parents=True, exist_ok=True)
        metadata = read_json(self.session_dir / "session.json", {})
        instructions = native.get("instructions", "")
        if self.mode == "plan":
            instructions += "\nPlan and inspect only. Do not change files or execute commands."
        config = LocalOpenAIAgentConfig(
            model=self.model, base_url=self.config["baseUrl"], workspaces=[self.cwd],
            save_dir=str(self.session_dir / "native"), app_data_dir=str(self.root / "data"),
            conversation_id=metadata.get("conversationId"), system_instructions=instructions or None,
            # SDK 0.1.16's OpenAI strategy does not forward config.policies.
            # Enforce through its public tool-decision hook instead.
            policies=[], hooks=[before_tool, policy.enforce(policies), after_tool, tool_error, on_compaction], capabilities=capabilities,
            mcp_servers=servers, skills_paths=[] if self.tool_free else native.get("skillsPaths", []),
            subagents=[] if self.tool_free else None,
        )
        self.agent = Agent(config)
        await self.agent.__aenter__()

    async def prepare_native(self):
        # SDK 0.1.17 allocates its database during the handshake, but its public
        # conversation_id remains empty until a step update. The fresh, scoped
        # directory must contain one native database. The main-process raw
        # inventory independently verifies its SQLite identity before input.
        if self.turn is not None:
            raise ValueError("Native preparation must precede the first prompt")
        if not self.agent:
            await self.open_agent()
        directory = self.session_dir / "native"
        names = []
        for entry in directory.iterdir():
            if len(names) >= 3 or not re.fullmatch(r"[0-9a-f]{32}\.db(?:-(?:wal|shm))?", entry.name):
                raise ValueError("Ambiguous prepared Antigravity storage")
            if entry.is_symlink() or not entry.is_file() or entry.stat().st_nlink != 1:
                raise ValueError("Linked prepared Antigravity storage")
            names.append(entry.name)
        ids = {name[:32] for name in names}
        if len(ids) != 1 or next(iter(ids)) + ".db" not in names:
            raise ValueError("Prepared Antigravity storage is unavailable")
        native_id = next(iter(ids))
        metadata = read_json(self.session_dir / "session.json", {})
        if metadata.get("conversationId", native_id) != native_id:
            raise ValueError("Prepared Antigravity storage changed identity")
        self.save_native_id(native_id)
        self.prepared_id = native_id
        return {"sessionId": self.session_id, "conversationId": native_id}

    def save_native_id(self, native_id):
        if not re.fullmatch(r"[0-9a-f]{32}", native_id or ""):
            raise ValueError("Invalid Antigravity native identity")
        if self.prepared_id and native_id != self.prepared_id:
            raise ValueError("Antigravity native identity changed after preparation")
        file = self.session_dir / "session.json"
        temporary = file.with_suffix(".tmp")
        temporary.write_text(json.dumps({"conversationId": native_id}), encoding="utf-8")
        temporary.replace(file)

    async def prompt(self, params):
        if any(part["type"] == "image" for part in params["prompt"]):
            raise ValueError("Image attachments are not supported by the current Antigravity SDK connection. Use Claude or Kimi for image conversations.")
        if not self.agent:
            await self.open_agent()
        content = []
        for part in params["prompt"]:
            if part["type"] == "text":
                content.append(part["text"])
        try:
            response = await self.agent.chat(content)
            async for chunk in response.chunks:
                if isinstance(chunk, (types.Text, types.Thought)):
                    self.update({"sessionUpdate": "agent_thought_chunk" if isinstance(chunk, types.Thought) else "agent_message_chunk",
                                 "content": {"type": "text", "text": chunk.text}})
            if response.stop_reason != types.StopReason.UNSPECIFIED:
                raise RuntimeError("Antigravity stopped: " + response.stop_reason.value.replace("_", " ").lower())
            usage = response.usage_metadata
            return {"stopReason": "end_turn", "usage": {
                "input_tokens": max(0, (usage.prompt_token_count or 0) - (usage.cached_content_token_count or 0)),
                "output_tokens": (usage.candidates_token_count or 0) + (usage.thoughts_token_count or 0),
                "cache_read_input_tokens": usage.cached_content_token_count or 0,
            }} if usage else {"stopReason": "end_turn"}
        except asyncio.CancelledError:
            return {"stopReason": "cancelled"}
        finally:
            if self.agent.conversation_id:
                self.save_native_id(self.agent.conversation_id)

    async def handle(self, message):
        method, params = message.get("method"), message.get("params", {})
        if not method:
            future = self.pending.get(message.get("id"))
            if future and not future.done():
                future.set_result(message.get("result", {}).get("outcome", {}).get("optionId") == "allow")
            return
        try:
            if method == "initialize":
                result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True},
                          "agentInfo": {"name": "Camellia Antigravity", "version": "0.3.0"}}
            elif method in ("session/new", "session/resume", "session/fork"):
                if self.preparation:
                    raise ValueError("Prepared session identity is fixed")
                if self.tool_free and params.get("mcpServers"):
                    raise ValueError("Tool-free Antigravity cannot load MCP servers")
                source = params.get("sessionId")
                if source:
                    uuid.UUID(source)
                    if not (self.root / "sessions" / source / "session.json").is_file():
                        raise ValueError("The saved Antigravity session is unavailable")
                self.session_id = source if method == "session/resume" else str(uuid.uuid4())
                self.cwd = params["cwd"]
                self.mcp_servers = params.get("mcpServers", [])
                if method == "session/fork":
                    copy_session(self.root / "sessions" / source, self.root / "sessions" / self.session_id)
                result = {"sessionId": self.session_id}
            elif method == "session/set_config_option":
                if params["configId"] == "model":
                    if self.preparation and self.model != params["value"]:
                        raise ValueError("Prepared session model is fixed")
                    self.model = params["value"]
                result = {"configOptions": []}
            elif method == "session/set_mode":
                if self.tool_free and params["modeId"] not in ("default", "plan"):
                    raise ValueError("Tool-free Antigravity cannot elevate permissions")
                if self.preparation and self.mode != params["modeId"]:
                    raise ValueError("Prepared session mode is fixed")
                self.mode = params["modeId"]
                result = {}
            elif method == "session/camellia_prepare":
                if not self.session_id or params.get("sessionId") != self.session_id:
                    raise ValueError("Native preparation identity mismatch")
                if self.preparation_closed:
                    raise ValueError("Native preparation has stopped")
                if not self.preparation:
                    self.preparation = asyncio.create_task(self.prepare_native())
                try:
                    result = await self.preparation
                except asyncio.CancelledError:
                    raise ValueError("Native preparation cancelled") from None
            elif method == "session/prompt":
                if self.preparation and (self.preparation_closed or not self.prepared_id):
                    raise ValueError("Native preparation has not succeeded")
                if self.turn and not self.turn.done():
                    raise ValueError("A response is already running")
                self.turn = asyncio.create_task(self.prompt(params))
                result = await self.turn
            elif method in ("session/cancel", "session/close"):
                if self.preparation:
                    self.preparation_closed = True
                if self.preparation and not self.preparation.done():
                    self.preparation.cancel()
                    await asyncio.gather(self.preparation, return_exceptions=True)
                for future in self.pending.values():
                    if not future.done():
                        future.set_result(False)
                if self.agent and self.turn and not self.turn.done():
                    await self.agent.conversation.cancel()
                    await self.turn
                if method == "session/close" and self.agent:
                    await self.agent.__aexit__(None, None, None)
                    self.agent = None
                result = {}
            else:
                raise ValueError("Unsupported method: " + method)
            if "id" in message:
                emit({"id": message["id"], "result": result})
        except Exception as error:
            if "id" in message:
                emit({"id": message["id"], "error": {"code": -32000, "message": str(error)}})

    async def run(self):
        tasks = set()
        try:
            while line := await asyncio.to_thread(sys.stdin.readline):
                task = asyncio.create_task(self.handle(json.loads(line)))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if self.agent:
                await self.agent.__aexit__(None, None, None)


if __name__ == "__main__":
    config = json.loads(os.environ["CAMELLIA_ANTIGRAVITY_CONFIG"])
    asyncio.run(Bridge(config).run())
