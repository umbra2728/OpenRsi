import json
import urllib.error
import urllib.request

import pytest

from harnessblog.proxy import OpenRouterProxy


def test_proxy_rejects_bad_token_before_upstream():
    proxy = OpenRouterProxy("never-sent", 1, host="127.0.0.1")
    proxy.start()
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{proxy.port}/v1/responses",
            data=json.dumps({"model": "openai/gpt-5.6-sol"}).encode(),
            headers={"Authorization": "Bearer wrong", "Content-Type": "application/json"},
        )
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(req)
        assert exc.value.code == 401
    finally:
        proxy.stop()


def test_proxy_rejects_unlisted_model_before_upstream():
    proxy = OpenRouterProxy("never-sent", 1, host="127.0.0.1")
    proxy.start()
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{proxy.port}/v1/responses",
            data=json.dumps({"model": "bad/model"}).encode(),
            headers={"Authorization": f"Bearer {proxy.state.client_token}", "Content-Type": "application/json"},
        )
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(req)
        assert exc.value.code == 403
    finally:
        proxy.stop()

