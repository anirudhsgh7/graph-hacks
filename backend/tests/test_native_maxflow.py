"""Handling of FalkorDB's algo.maxFlow output (newer builds), with stubs, so the branch is
tested even on an engine that predates the procedure. On a build that has it,
seed.verify additionally checks native and Python results agree on real data."""
from agent.tools import Run, compute_capacity


class _StubDB:
    def __init__(self, has_maxflow):
        self.caps = {"maxflow": has_maxflow}

    def capabilities(self):
        return self.caps

    def disable_native_maxflow(self):
        self.caps["maxflow"] = False


class _StubView:
    name = "stub"

    def __init__(self, native_rows=None, native_error=None):
        self.native_rows, self.native_error = native_rows, native_error
        self.edges = [{"src": "s", "dst": "a", "capacity": 10.0}, {"src": "a", "dst": "t", "capacity": 4.0},
                      {"src": "s", "dst": "t", "capacity": 3.0}]

    def ro(self, name, params=None, timeout_ms=0):
        if name == "maxflow_native":
            if self.native_error:
                raise self.native_error
            return self.native_rows
        if name == "flow_edge_count":
            return [{"total": len(self.edges)}]
        if name == "flow_edges":
            return self.edges[params["skip"]:params["skip"] + params["limit"]]
        raise AssertionError(name)


def test_native_result_is_used_and_shaped():
    run = Run(_StubDB(True))
    view = _StubView(native_rows=[{"max_flow": 7.0, "pairs": [["s", "a"], ["a", "t"], ["s", "t"]],
                                   "flows": [4.0, 4.0, 3.0]}])
    result, receipts = compute_capacity(run, view, ["s"], ["t"])
    assert result.engine == "falkordb" and result.value == 7.0
    assert result.edge_flows[0] == ("s", "a", 4.0, 10.0)
    assert receipts[0].query == "maxflow_native"


def test_native_failure_falls_back_to_python_and_is_remembered():
    db = _StubDB(True)
    run = Run(db)
    view = _StubView(native_error=RuntimeError("unexpected shape"))
    result, _ = compute_capacity(run, view, ["s"], ["t"])
    assert result.engine == "python" and result.value == 7.0
    assert db.caps["maxflow"] is False


def test_exclusions_always_use_python():
    run = Run(_StubDB(True))
    view = _StubView(native_error=AssertionError("native must not be called with exclusions"))
    result, _ = compute_capacity(run, view, ["s"], ["t"], exclude={"a"})
    assert result.engine == "python" and result.value == 3.0
