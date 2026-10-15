// Shared infrastructure and ring detection.

// name: shared_infrastructure
// Accounts that use the same device or IP address as $id (two hops: account -> device/IP -> account).
MATCH (a:Account {id: $id})-[:USED_DEVICE|USED_IP]->(x)<-[:USED_DEVICE|USED_IP]-(b:Account)
WHERE b.id <> $id
RETURN b.id AS account, labels(x)[0] AS via_kind, x.id AS via_id
ORDER BY account, via_id

// name: infrastructure_components
// Weakly connected components of the account-device-IP graph (algo.WCC).
// Accounts in one component are tied together by shared phones or networks.
CALL algo.WCC({nodeLabels: ['Account', 'Device', 'IPAddress'], relationshipTypes: ['USED_DEVICE', 'USED_IP']})
YIELD node, componentId
WITH node, componentId
WHERE 'Account' IN labels(node)
WITH componentId, collect(node.id) AS members
WHERE any(m IN members WHERE m IN $ids)
RETURN componentId, members

// name: shared_infrastructure_among
// The devices and IPs shared by pairs of accounts inside a candidate ring.
MATCH (a:Account)-[:USED_DEVICE|USED_IP]->(x)<-[:USED_DEVICE|USED_IP]-(b:Account)
WHERE a.id IN $ids AND b.id IN $ids AND a.id < b.id
RETURN a.id AS a, b.id AS b, labels(x)[0] AS via_kind, x.id AS via_id

// name: layering_pairs
// Pass-through pattern: money into $ids and out again within the window, similar amount.
MATCH (a:Account)-[t1:TRANSFER]->(m:Account)-[t2:TRANSFER]->(b:Account)
WHERE m.id IN $ids
  AND t2.ts > t1.ts AND t2.ts - t1.ts <= $window_ms
  AND t2.amount <= t1.amount AND t2.amount >= t1.amount * (1.0 - $fee_tolerance)
  AND a.id <> b.id
RETURN a.id AS src, m.id AS via, b.id AS dst, t1.id AS in_id, t2.id AS out_id,
       t1.amount AS in_amount, t2.amount AS out_amount, (t2.ts - t1.ts) AS gap_ms
ORDER BY gap_ms ASC
LIMIT 50
