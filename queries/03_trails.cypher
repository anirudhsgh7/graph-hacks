// Money trails: shortest paths, the transfers behind each hop, and forward tracing.

// name: money_trail_paths
// Shortest routes from $src to $dst over FLOWS_TO (algo.SPpaths), up to $path_count of them.
MATCH (s:Account {id: $src}), (t:Account {id: $dst})
CALL algo.SPpaths({sourceNode: s, targetNode: t, relTypes: ['FLOWS_TO'], relDirection: 'outgoing',
                   maxLen: $max_len, pathCount: $path_count})
YIELD path, pathWeight
RETURN [n IN nodes(path) | n.id] AS nodes, pathWeight AS hops

// name: hop_transfers
// The individual TRANSFER records behind each (from, to) hop of a path.
UNWIND $pairs AS p
MATCH (a:Account {id: p[0]})-[t:TRANSFER]->(b:Account {id: p[1]})
RETURN a.id AS src, b.id AS dst, t.id AS id, t.amount AS amount, t.ts AS ts
ORDER BY ts

// name: largest_outflow
// The single largest transfer out of $id (the usual starting point of a complaint).
MATCH (a:Account {id: $id})-[t:TRANSFER]->(b:Account)
RETURN b.id AS dst, t.id AS id, t.amount AS amount, t.ts AS ts
ORDER BY amount DESC, ts DESC
LIMIT 1

// name: transfer_by_id
// One transfer by id.
MATCH (a:Account)-[t:TRANSFER {id: $id}]->(b:Account)
RETURN a.id AS src, b.id AS dst, t.id AS id, t.amount AS amount, t.ts AS ts

// name: onward_transfers
// Next hop when following funds: transfers out of $id shortly after the money arrived,
// for an amount the incoming transfer could have paid for (minus a fee).
MATCH (a:Account {id: $id})-[t:TRANSFER]->(b:Account)
WHERE t.ts > $after AND t.ts <= $until AND t.amount <= $max_amount AND t.amount >= $min_amount
RETURN b.id AS dst, b.type AS dst_type, t.id AS id, t.amount AS amount, t.ts AS ts
ORDER BY amount DESC, ts ASC
