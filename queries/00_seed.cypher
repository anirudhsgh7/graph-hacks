// Bulk loading of the synthetic world (backend/seed/load.py). Each query takes a list of
// rows in $rows and is run in batches. Writes; used only by the seed script.

// name: idx_account
CREATE INDEX FOR (a:Account) ON (a.id)

// name: idx_customer
CREATE INDEX FOR (c:Customer) ON (c.id)

// name: idx_device
CREATE INDEX FOR (d:Device) ON (d.id)

// name: idx_ip
CREATE INDEX FOR (i:IPAddress) ON (i.id)

// name: idx_case
CREATE INDEX FOR (c:Case) ON (c.id)

// name: idx_investigation
CREATE INDEX FOR (i:Investigation) ON (i.id)

// name: idx_proposal
CREATE INDEX FOR (p:Proposal) ON (p.id)

// name: idx_transfer
CREATE INDEX FOR ()-[t:TRANSFER]-() ON (t.id)

// name: load_customers
UNWIND $rows AS r
CREATE (:Customer {id: r.id, name: r.name, segment: r.segment})

// name: load_accounts
UNWIND $rows AS r
CREATE (:Account {id: r.id, type: r.type, opened_at: r.opened_at, country: r.country,
                  status: r.status, anomaly_score: r.anomaly_score})

// name: load_devices
UNWIND $rows AS r
CREATE (:Device {id: r.id, kind: r.kind})

// name: load_ips
UNWIND $rows AS r
CREATE (:IPAddress {id: r.id, addr: r.addr, asn_country: r.asn_country})

// name: load_owns
UNWIND $rows AS r
MATCH (c:Customer {id: r.customer}), (a:Account {id: r.account})
CREATE (c)-[:OWNS {since: r.since}]->(a)

// name: load_used_device
UNWIND $rows AS r
MATCH (a:Account {id: r.account}), (d:Device {id: r.device})
CREATE (a)-[:USED_DEVICE {last_seen: r.last_seen}]->(d)

// name: load_used_ip
UNWIND $rows AS r
MATCH (a:Account {id: r.account}), (i:IPAddress {id: r.ip})
CREATE (a)-[:USED_IP {last_seen: r.last_seen}]->(i)

// name: load_transfers
// ring_id / is_laundering are hidden ground truth: no product query reads them.
UNWIND $rows AS r
MATCH (a:Account {id: r.src}), (b:Account {id: r.dst})
CREATE (a)-[:TRANSFER {id: r.id, amount: r.amount, ts: r.ts, channel: r.channel,
                       ring_id: r.ring_id, is_laundering: r.is_laundering}]->(b)

// name: load_flows
// One FLOWS_TO edge per ordered account pair: capacity = total money observed on it.
UNWIND $rows AS r
MATCH (a:Account {id: r.src}), (b:Account {id: r.dst})
CREATE (a)-[:FLOWS_TO {capacity: r.capacity, tx_count: r.tx_count, first_ts: r.first_ts,
                       last_ts: r.last_ts}]->(b)

// name: load_cases
UNWIND $rows AS r
CREATE (:Case {id: r.id, title: r.title, alert: r.alert, seed_accounts: r.seed_accounts,
               created_at: r.created_at, status: r.status, suggested_questions: r.suggested_questions})
