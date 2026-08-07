async def test_health_returns_ok(client):
    res = await client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"
