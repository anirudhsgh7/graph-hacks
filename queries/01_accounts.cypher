// Account lookups and per-account profiles.
// All reads. $-prefixed names are query parameters (never string-interpolated).

// name: account_search
// Find accounts by id prefix or by the owner's name.
MATCH (c:Customer)-[:OWNS]->(a:Account)
WHERE a.id = toUpper($q) OR a.id STARTS WITH toUpper($q) OR toLower(c.name) CONTAINS toLower($q)
RETURN a.id AS id, a.type AS type, a.status AS status, a.anomaly_score AS anomaly_score, c.name AS owner
ORDER BY id
LIMIT 20

// name: accounts_by_id
// Basic facts for a list of account ids (used to validate tool inputs).
MATCH (a:Account)
WHERE a.id IN $ids
RETURN a.id AS id, a.type AS type, a.status AS status, a.anomaly_score AS anomaly_score

// name: account_profile
// Owner, age, status, legacy anomaly score and in/out transfer totals for $id.
MATCH (c:Customer)-[:OWNS]->(a:Account {id: $id})
OPTIONAL MATCH (a)-[o:TRANSFER]->(r:Account)
WITH c, a, count(o) AS out_count, sum(o.amount) AS out_total, count(DISTINCT r) AS out_counterparties
OPTIONAL MATCH (s:Account)-[i:TRANSFER]->(a)
RETURN a.id AS id, a.type AS type, a.status AS status, a.opened_at AS opened_at,
       a.country AS country, a.anomaly_score AS anomaly_score, c.id AS customer_id, c.name AS owner,
       out_count, out_total, out_counterparties,
       count(i) AS in_count, sum(i.amount) AS in_total, count(DISTINCT s) AS in_counterparties

// name: account_owned_by_same_customer
// Other accounts held by the owner of $id.
MATCH (a:Account {id: $id})<-[:OWNS]-(c:Customer)-[:OWNS]->(b:Account)
WHERE b.id <> $id
RETURN b.id AS id

// name: inbound_sender_repeats
// How many times each sender paid $id (one-time customers vs repeat counterparties).
MATCH (s:Account)-[i:TRANSFER]->(a:Account {id: $id})
RETURN s.id AS sender, count(i) AS times, sum(i.amount) AS total

// name: anomaly_rank
// Rank of a score among all accounts (1 = highest).
MATCH (b:Account)
RETURN count(b) AS total, sum(CASE WHEN b.anomaly_score > $score THEN 1 ELSE 0 END) AS higher

// name: account_transfers
// Every transfer touching the given accounts (for forwarding-speed statistics).
MATCH (a:Account)-[t:TRANSFER]->(b:Account)
WHERE a.id IN $ids OR b.id IN $ids
RETURN a.id AS src, b.id AS dst, t.id AS id, t.amount AS amount, t.ts AS ts
ORDER BY ts

// name: frozen_accounts
// Accounts an analyst has frozen through the console.
MATCH (a:Account {status: 'frozen'})
RETURN a.id AS id

// name: graph_counts
// Size of the demo world (health check).
MATCH (a:Account)
WITH count(a) AS accounts
MATCH ()-[t:TRANSFER]->()
RETURN accounts, count(t) AS transfers

// name: dbms_procedures
// Capability probe: which algo.* procedures this FalkorDB build provides.
CALL dbms.procedures() YIELD name
RETURN collect(name) AS names
