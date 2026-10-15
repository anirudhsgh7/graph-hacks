"""Pure-Python flow solver: small graphs with answers checkable by hand."""
from graph.flow import max_flow, min_vertex_cut


def test_max_flow_two_routes():
    edges = [("s", "a", 10), ("a", "t", 5), ("s", "b", 7), ("b", "t", 8)]
    assert max_flow(edges, ["s"], ["t"]).value == 12  # 5 via a, 7 via b


def test_max_flow_respects_exclusions_and_empty_sides():
    edges = [("s", "a", 10), ("a", "t", 5), ("s", "b", 7), ("b", "t", 8)]
    assert max_flow(edges, ["s"], ["t"], exclude={"a"}).value == 7
    assert max_flow(edges, ["s"], ["t"], exclude={"s"}).value == 0


def test_min_vertex_cut_prefers_cheap_chokepoint_near_sink():
    # s1, s2 -> x -> y -> t : cutting x or y works; equal cost -> closest to the sink (y)
    edges = [("s1", "x", 1), ("s2", "x", 1), ("x", "y", 1), ("y", "t", 1)]
    cut = min_vertex_cut(edges, ["s1", "s2"], ["t"], {})
    assert cut.feasible and cut.accounts == ["y"]


def test_min_vertex_cut_avoids_costly_accounts():
    # two parallel routes; one middle node is "busy" (expensive)
    edges = [("s", "a", 1), ("a", "t", 1), ("s", "b", 1), ("b", "c", 1), ("c", "t", 1)]
    # the source is expensive here too, otherwise freezing it alone (cost 1) is the cheapest cut
    cut = min_vertex_cut(edges, ["s"], ["t"], {"s": 5.0, "a": 1.0, "b": 1.9, "c": 1.0})
    assert sorted(cut.accounts) == ["a", "c"]


def test_min_vertex_cut_may_freeze_the_source_itself():
    edges = [("s", "t", 5)]
    cut = min_vertex_cut(edges, ["s"], ["t"], {"s": 1.0})
    assert cut.feasible and cut.accounts == ["s"]   # freezing the source itself is allowed
