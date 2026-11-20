"""Thin async wrapper around OpenAI with token and USD cost calculation.
and USD cost calculation.

Every call returns a `"usage"` dictionary shaped for `CostCaptureMiddleware`
(`kb/inngest_client.py`) and can also write directly to the `costs` table when
invoked outside an Inngest step middleware context.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from openai import AsyncOpenAI
from pydantic import BaseModel

from kb.config import settings
from kb.db.queries import insert_cost
from kb.db.session import get_session

_openai_client: AsyncOpenAI | None = None

# Per-million-token pricing table (input_usd, output_usd). Updated for OpenAI models
# with local-compatible pricing estimates.
MODEL_PRICING_PER_MTOK: dict[str, tuple[float, float]] = {
    # OpenAI models
    "gpt-4o": (2.50, 10.00),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4-turbo": (10.00, 30.00),
    "gpt-4": (30.00, 60.00),
    "gpt-3.5-turbo": (0.50, 1.50),
    "claude-haiku-5-5": (1.00, 5.00),
    "claude-haiku-4-5": (1.00, 5.00),
    "claude-haiku-4-5-20251001": (1.00, 5.00),
    "claude-3-5-haiku-latest": (0.80, 4.00),
    "claude-sonnet-4-20250514": (3.00, 15.00),
    "claude-sonnet-4-5": (3.00, 15.00),
    "claude-sonnet-5-5": (3.00, 15.00),
    "claude-3-5-sonnet-latest": (3.00, 15.00),
}


def get_openai_client() -> AsyncOpenAI:
    """Return a lazily-initialized `AsyncOpenAI` client."""
    global _openai_client
    if _openai_client is None:
        _openai_client = AsyncOpenAI(
            api_key=settings.openai_api_key or "sk-local",
            base_url=settings.openai_api_base,
        )
    return _openai_client


def estimate_llm_cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    """Compute estimated USD cost from input and output token counts."""
    in_price, out_price = MODEL_PRICING_PER_MTOK.get(
        model,
        (
            settings.openai_input_price_per_million_tokens,
            settings.openai_output_price_per_million_tokens,
        ),
    )
    usd = (input_tokens / 1_000_000) * in_price + (output_tokens / 1_000_000) * out_price
    return round(usd, 6)


async def record_llm_cost(
    *,
    model: str,
    input_tokens: int,
    output_tokens: int,
    est_usd: float,
    article_id: uuid.UUID | None = None,
) -> None:
    """Persist a single LLM invocation cost row to the `costs` table."""
    async with get_session() as session:
        await insert_cost(
            session,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            est_usd=est_usd,
            article_id=article_id,
        )
        await session.commit()


def _extract_json_object(raw_text: str) -> str:
    """Strip optional markdown code fences around JSON output."""
    stripped = raw_text.strip()
    fence_match = re.search(r"```(?:json)?\s*(\{.*\}|\[.*\])\s*```", stripped, re.DOTALL)
    if fence_match:
        return fence_match.group(1).strip()
    return stripped


async def call_llm(
    *,
    system_prompt: str,
    user_input: str,
    model: str,
    max_tokens: int = 2048,
    output_schema: type[BaseModel] | None = None,
    article_id: uuid.UUID | None = None,
    persist_cost: bool = False,
) -> dict[str, Any]:
    """Invoke OpenAI chat completion (with native JSON schema `response_format` when
    `output_schema` is provided) and return `{"output": ..., "usage": {...}}`.
    """
    client = get_openai_client()

    kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ],
    }

    if output_schema is not None:
        kwargs["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": "output",
                "schema": output_schema.model_json_schema(),
            },
        }

    response = await client.chat.completions.create(**kwargs)

    # OpenAI usage fields
    usage_obj = getattr(response, "usage", None)
    input_tokens = int(getattr(usage_obj, "prompt_tokens", 0) or 0)
    output_tokens = int(getattr(usage_obj, "completion_tokens", 0) or 0)
    est_usd = estimate_llm_cost_usd(model, input_tokens, output_tokens)

    usage: dict[str, Any] = {
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "est_usd": est_usd,
        "article_id": str(article_id) if article_id is not None else None,
    }

    if persist_cost:
        await record_llm_cost(
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            est_usd=est_usd,
            article_id=article_id,
        )

    # Parse the response content
    parsed_output: Any = None
    choice = response.choices[0] if response.choices else None
    if choice and choice.message:
        text_val = choice.message.content or ""
        if output_schema is not None:
            cleaned = _extract_json_object(text_val)
            parsed_output = json.loads(cleaned)
        else:
            parsed_output = text_val

    if output_schema is not None:
        validated = output_schema.model_validate(parsed_output)
        return {"output": validated.model_dump(mode="json"), "usage": usage}

    return {"output": str(parsed_output or ""), "usage": usage}
