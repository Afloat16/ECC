import json
from io import BytesIO
from urllib.parse import urlsplit
from urllib.request import Request

import pytest

from llm.core.types import LLMInput, Message, Role, ToolDefinition
from llm.providers.ollama import OllamaProvider

pytestmark = pytest.mark.unit


@pytest.mark.parametrize("suffix", ["", "/", "///"])
@pytest.mark.parametrize("source", ["constructor", "environment"])
def test_base_url_joins_chat_and_capability_paths_once(
    monkeypatch: pytest.MonkeyPatch, suffix: str, source: str,
) -> None:
    base = "http://localhost:11434/ollama"
    calls: list[str] = []

    def urlopen(request: Request, timeout: float) -> BytesIO:
        calls.append(request.full_url)
        endpoint = urlsplit(request.full_url).path
        assert endpoint in {"/ollama/api/show", "/ollama/api/chat"}
        result = {"capabilities": ["tools"]} if endpoint.endswith("/show") else {
            "message": {"content": "done"}, "done_reason": "stop",
        }
        return BytesIO(json.dumps(result).encode())

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    if source == "environment":
        monkeypatch.setenv("OLLAMA_BASE_URL", base + suffix)
        provider = OllamaProvider(default_model="custom-model")
    else:
        monkeypatch.setenv("OLLAMA_BASE_URL", "http://unused.example")
        provider = OllamaProvider(base_url=base + suffix, default_model="custom-model")
    output = provider.generate(LLMInput(
        messages=[Message(role=Role.USER, content="hello")],
        tools=[ToolDefinition(name="lookup", description="Look up a value", parameters={})],
    ))

    assert output.content == "done"
    assert calls == [base + "/api/show", base + "/api/chat"]
    assert provider.base_url == base


def test_default_ollama_endpoint_is_preserved(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
    assert OllamaProvider().base_url == "http://localhost:11434"
