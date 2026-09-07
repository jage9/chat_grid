from __future__ import annotations


def test_nickname_taken_is_case_insensitive(world) -> None:
    server = world.server
    world.join("Jage", client_id="1")
    world.join("Alice", client_id="2")

    assert server._is_nickname_taken("jage", exclude_client_id="2")
    assert server._is_nickname_taken("JAGE", exclude_client_id="2")
    assert not server._is_nickname_taken("jage", exclude_client_id="1")


def test_nickname_key_uses_casefold(world) -> None:
    server = world.server
    assert server._nickname_key("Jage") == server._nickname_key("jage")
