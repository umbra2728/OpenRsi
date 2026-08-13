from harnessblog.security import redact


def test_redacts_tokens_and_headers():
    value = {
        "api_key": "anything",
        "nested": ["sk-or-v1-abcdefghijklmnopqrstuvwxyz123456", "Authorization: Bearer hello"],
    }
    result = redact(value)
    assert result["api_key"] == "[REDACTED]"
    assert all(secret not in str(result) for secret in ("abcdefghijklmnopqrstuvwxyz", "hello"))

