// Hubs, capacity and freeze planning.

// name: rank_hubs
// Influence ranking over transfers (algo.pageRank): money sinks and collectors rise to the top.
CALL algo.pageRank('Account', 'TRANSFER')
YIELD node, score
RETURN node.id AS account, node.type AS type, node.status AS status, score
ORDER BY score DESC
LIMIT $limit

// name: pagerank_of
// PageRank score and overall rank for specific accounts.
CALL algo.pageRank('Account', 'TRANSFER')
YIELD node, score
WITH node, score
ORDER BY score DESC
WITH collect([node.id, score]) AS ranked
UNWIND range(0, size(ranked) - 1) AS i
WITH ranked[i] AS r, i
WHERE r[0] IN $ids
RETURN r[0] AS account, r[1] AS score, i + 1 AS rank

// name: maxflow_native
// Laundering capacity: maximum money that can move from $sources to $sinks (algo.maxFlow).
// Runs on FLOWS_TO (one edge per account pair, capacity = total money observed on it),
// because maxFlow requires a relationship type without parallel edges.
MATCH (s:Account) WHERE s.id IN $sources
WITH collect(s) AS sources
MATCH (t:Account) WHERE t.id IN $sinks
WITH sources, collect(t) AS sinks
CALL algo.maxFlow({sourceNodes: sources, targetNodes: sinks, relationshipTypes: ['FLOWS_TO'],
                   capacityProperty: 'capacity'})
YIELD edges, edgeFlows, maxFlow
RETURN maxFlow AS max_flow, [e IN edges | [startNode(e).id, endNode(e).id]] AS pairs, edgeFlows AS flows

// name: flow_edges
// The FLOWS_TO network with capacities (input to the Python flow solver used for minimum cuts,
// and for max-flow on FalkorDB builds that predate algo.maxFlow). Read in pages because
// FalkorDB caps result sets (RESULTSET_SIZE, 10000 in the official Docker image).
MATCH (a:Account)-[f:FLOWS_TO]->(b:Account)
RETURN a.id AS src, b.id AS dst, f.capacity AS capacity
ORDER BY src, dst
SKIP $skip
LIMIT $limit

// name: flow_edge_count
// How many FLOWS_TO edges exist (so paged reads can confirm they received all of them).
MATCH (:Account)-[f:FLOWS_TO]->(:Account)
RETURN count(f) AS total

// name: counterparty_volumes
// Money exchanged by each account with each counterparty, both directions (collateral of a freeze).
MATCH (a:Account)-[f:FLOWS_TO]-(b:Account)
WHERE a.id IN $ids
RETURN a.id AS account, b.id AS counterparty, sum(f.capacity) AS volume

// name: fork_remove_accounts
// WRITE, forks only: remove accounts from a disposable copy of the graph to simulate a freeze.
MATCH (a:Account)
WHERE a.id IN $ids
DETACH DELETE a
