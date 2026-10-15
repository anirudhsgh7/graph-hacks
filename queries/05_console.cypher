// Case store, audit trail, analyst actions and the subgraph sent to the UI canvas.
// Writes in this file run only from POST /api/investigate (to record results) and
// POST /api/actions/execute (after the analyst confirms). The agent cannot call them.

// name: graph_nodes
// Node details for the canvas.
MATCH (n)
WHERE (n:Account OR n:Device OR n:IPAddress) AND n.id IN $ids
RETURN n.id AS id, labels(n)[0] AS label, n.type AS type, n.kind AS kind,
       n.status AS status, n.anomaly_score AS anomaly_score

// name: graph_transfers
// Transfer edges for the canvas.
MATCH (a:Account)-[t:TRANSFER]->(b:Account)
WHERE t.id IN $ids
RETURN t.id AS id, a.id AS source, b.id AS target, t.amount AS amount, t.ts AS ts, t.channel AS channel

// name: graph_infra_links
// Account -> device / IP edges for the canvas.
MATCH (a:Account)-[r:USED_DEVICE|USED_IP]->(x)
WHERE a.id IN $accounts AND x.id IN $infra
RETURN a.id AS source, x.id AS target, type(r) AS type

// name: neighborhood_transfers
// Largest transfers touching the given accounts (canvas before any investigation).
MATCH (a:Account)-[t:TRANSFER]-(b:Account)
WHERE a.id IN $ids
RETURN DISTINCT t.id AS id, t.amount AS amount
ORDER BY amount DESC
LIMIT $limit

// name: case_list
MATCH (c:Case)
RETURN c.id AS id, c.title AS title, c.alert AS alert, c.status AS status,
       c.seed_accounts AS seed_accounts, c.created_at AS created_at,
       c.suggested_questions AS suggested_questions
ORDER BY id

// name: case_get
MATCH (c:Case {id: $id})
RETURN c.id AS id, c.title AS title, c.alert AS alert, c.status AS status,
       c.seed_accounts AS seed_accounts, c.created_at AS created_at,
       c.suggested_questions AS suggested_questions

// name: case_set_status
MATCH (c:Case {id: $id})
SET c.status = $status
RETURN c.id AS id, c.status AS status

// name: investigation_create
MATCH (c:Case {id: $case_id})
CREATE (c)-[:HAS_INVESTIGATION]->(i:Investigation {id: $id, question: $question, created_at: $created_at,
        conclusion: $conclusion, mode: $mode, summary: $summary, payload: $payload})
RETURN i.id AS id

// name: investigation_list
MATCH (c:Case {id: $case_id})-[:HAS_INVESTIGATION]->(i:Investigation)
RETURN i.id AS id, i.question AS question, i.created_at AS created_at, i.conclusion AS conclusion,
       i.mode AS mode, i.summary AS summary
ORDER BY created_at DESC

// name: investigation_latest
MATCH (c:Case {id: $case_id})-[:HAS_INVESTIGATION]->(i:Investigation)
RETURN i.payload AS payload
ORDER BY i.created_at DESC
LIMIT 1

// name: proposal_create
MATCH (i:Investigation {id: $investigation_id})
CREATE (i)-[:PROPOSES]->(p:Proposal {id: $id, case_id: $case_id, type: $type, label: $label,
        account_ids: $account_ids, evidence_refs: $evidence_refs, status: 'proposed'})
RETURN p.id AS id

// name: proposal_get
MATCH (p:Proposal {id: $id})
RETURN p.id AS id, p.case_id AS case_id, p.type AS type, p.label AS label,
       p.account_ids AS account_ids, p.evidence_refs AS evidence_refs, p.status AS status

// name: proposal_mark_executed
MATCH (p:Proposal {id: $id})
SET p.status = 'executed', p.executed_at = $at
RETURN p.id AS id

// name: accounts_freeze
// Freeze: the account can no longer send or receive (tools treat it as removed).
MATCH (a:Account)
WHERE a.id IN $ids AND a.status <> 'frozen'
SET a.status = 'frozen', a.frozen_at = $at
RETURN a.id AS id

// name: accounts_flag
MATCH (a:Account)
WHERE a.id IN $ids AND a.status = 'active'
SET a.status = 'flagged'
RETURN a.id AS id

// name: action_create
// Audit entry, linked to the case and to every account it touched.
MATCH (c:Case {id: $case_id})
CREATE (c)-[:HAS_ACTION]->(x:Action {id: $id, type: $type, label: $label, created_at: $created_at,
        account_ids: $account_ids, evidence_refs: $evidence_refs, proposal_id: $proposal_id,
        affected: $affected})
WITH x
UNWIND $affected AS aid
MATCH (a:Account {id: aid})
CREATE (x)-[:TARGETS]->(a)
RETURN count(a) AS linked

// name: audit_trail
MATCH (c:Case {id: $case_id})-[:HAS_ACTION]->(x:Action)
RETURN x.id AS id, x.type AS type, x.label AS label, x.created_at AS created_at,
       x.account_ids AS account_ids, x.affected AS affected, x.evidence_refs AS evidence_refs
ORDER BY created_at DESC
