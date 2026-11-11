import asyncio

import pytest

from llm.core.types import LLMInput, LLMOutput, Message, Role, ToolCall, ToolDefinition
from llm.tools import ReActAgent, ToolExecutor, ToolRegistry

pytestmark = pytest.mark.unit


def test_request_options_survive_every_tool_round_trip() -> None:
    requests: list[LLMInput] = []
    registry = ToolRegistry()
    tool = ToolDefinition(name="lookup", description="Look up a value", parameters={})
    registry.register(tool, lambda: "found")

    class Provider:
        def generate(self, request: LLMInput) -> LLMOutput:
            requests.append(request)
            assert request.metadata == {"request_id": "req-17", "response_format": "json"}
            assert request.stream is True
            assert request.model == "custom-model"
            assert request.temperature == 0.25
            assert request.max_tokens == 128
            assert request.tools == [tool]
            if len(requests) == 1:
                request.metadata["provider_internal"] = "local"
                return LLMOutput(content="", tool_calls=[ToolCall(id="call-1", name="lookup", arguments={})])
            assert request.messages[-1].role == Role.TOOL
            assert request.messages[-1].content == "found"
            return LLMOutput(content="done")

    original = LLMInput(
        messages=[Message(role=Role.USER, content="look up")],
        model="custom-model", temperature=0.25, max_tokens=128, tools=[tool], stream=True,
        metadata={"request_id": "req-17", "response_format": "json"},
    )
    output = asyncio.run(ReActAgent(Provider(), ToolExecutor(registry)).run(original))

    assert output.content == "done"
    assert len(requests) == 2
    assert original.metadata == {"request_id": "req-17", "response_format": "json"}
    assert len(original.messages) == 1


def test_default_request_options_keep_existing_behavior() -> None:
    class Provider:
        def generate(self, request: LLMInput) -> LLMOutput:
            assert request.metadata == {}
            assert request.stream is False
            assert request.tools == []
            return LLMOutput(content="done")

    output = asyncio.run(ReActAgent(Provider(), ToolExecutor()).run(LLMInput(messages=[])))
    assert output.content == "done"
