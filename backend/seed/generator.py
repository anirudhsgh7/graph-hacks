"""Deterministic synthetic AML world for "Follow the Money".

Everything here is synthetic and generated from a fixed RNG seed (42), so every
run produces the identical graph. The suspicious structures are *planted* by hand
in `_plant_*` functions below, written as readable event scripts, so anyone can
check the ground truth against what the agent finds.

Planted structures (see seed_groundtruth.json after a load):
  Ring 1  A17 A22 A31 A47 A52 A63 A68  - layered mule ring, 3 shared devices,
          2 shared IPs, cashes out at hub H3. A non-ring account (A77) carries a
          bypass route A52 -> A77 -> H3.
  Ring 2  A91 A33 A75                  - fee-skimming chain from victim C42 to H1.
  Ring 3  A12 A26 A39 A58 A64          - second mule ring cashing out at H5.
  Benign  A95 A96 A97 A98              - family sharing a home tablet and Wi-Fi.
  Benign  M8                           - busy merchant; tops the legacy volume score.
  Exit    X9                           - external exchange; H1, H3 and H5 all pay it.
"""
from __future__ import annotations

import math
import random
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone

SEED = 42
NOW = datetime(2026, 10, 15, 0, 0, tzinfo=timezone.utc)
WINDOW_START = datetime(2026, 10, 1, 0, 0, tzinfo=timezone.utc)
DAY_MS = 86_400_000
MIN_MS = 60_000

RING1 = ["A17", "A22", "A31", "A47", "A52", "A63", "A68"]
RING2 = ["A91", "A33", "A75"]
RING3 = ["A12", "A26", "A39", "A58", "A64"]
FAMILY = ["A95", "A96", "A97", "A98"]
DORMANT = [f"A{n}" for n in range(80, 89)]          # burst recipients that never forward
HUBS = ["H1", "H3", "H5"]
EXIT = "X9"
MERCHANT = "M8"
MERCHANT_SETTLEMENT = "A101"
BACKGROUND = [f"A{n}" for n in range(100, 660)]      # 560 ordinary accounts
RING1_VICTIMS = ["A110", "A111", "A112", "A113", "A114", "A115", "A116"]
RING2_VICTIMS = ["C42", "A120", "A121"]
RING3_VICTIMS = ["A130", "A131", "A132"]

FIRST = ["Aarav", "Maya", "Liam", "Zara", "Noah", "Isha", "Omar", "Lena", "Kabir", "Ava",
         "Ravi", "Nora", "Ethan", "Sara", "Arjun", "Mia", "Leo", "Tara", "Dev", "Ella"]
LAST = ["Shah", "Patel", "Smith", "Khan", "Garcia", "Mehta", "Brown", "Iyer", "Lopez", "Rao",
        "Wilson", "Das", "Moore", "Nair", "Clark", "Bose", "Young", "Kapoor", "Hill", "Sen"]


def ts(day: int, hhmm: str) -> int:
    """Epoch ms for 2026-10-<day> at HH:MM UTC."""
    hh, mm = (int(x) for x in hhmm.split(":"))
    return int(datetime(2026, 10, day, hh, mm, tzinfo=timezone.utc).timestamp() * 1000)


@dataclass
class World:
    customers: list[dict] = field(default_factory=list)
    accounts: list[dict] = field(default_factory=list)
    devices: list[dict] = field(default_factory=list)
    ips: list[dict] = field(default_factory=list)
    owns: list[dict] = field(default_factory=list)
    used_device: list[dict] = field(default_factory=list)
    used_ip: list[dict] = field(default_factory=list)
    transfers: list[dict] = field(default_factory=list)
    flows: list[dict] = field(default_factory=list)
    cases: list[dict] = field(default_factory=list)
    ground_truth: dict = field(default_factory=dict)


class _Builder:
    def __init__(self) -> None:
        self.rng = random.Random(SEED)
        self.w = World()
        self._acc: dict[str, dict] = {}
        self._dev: set[str] = set()
        self._ip: set[str] = set()
        self._raw_transfers: list[tuple] = []   # (src, dst, amount, ts, channel, ring_id, laundering)

    # ---- primitives -------------------------------------------------------
    def account(self, acc_id: str, kind: str, age_days: int, country: str = "US") -> None:
        cust_id = f"CU-{len(self.w.customers) + 1:04d}"
        name = f"{self.rng.choice(FIRST)} {self.rng.choice(LAST)}"
        segment = {"personal": "retail", "business": "smb", "merchant": "smb",
                   "external": "institution"}[kind]
        self.w.customers.append({"id": cust_id, "name": name, "segment": segment})
        opened = int((NOW.timestamp() - age_days * 86400) * 1000)
        acc = {"id": acc_id, "type": kind, "opened_at": opened, "country": country,
               "status": "active", "anomaly_score": 0.0}
        self._acc[acc_id] = acc
        self.w.accounts.append(acc)
        self.w.owns.append({"customer": cust_id, "account": acc_id, "since": opened})

    def device(self, acc_id: str, dev_id: str, kind: str = "mobile") -> None:
        if dev_id not in self._dev:
            self._dev.add(dev_id)
            self.w.devices.append({"id": dev_id, "kind": kind})
        self.w.used_device.append({"account": acc_id, "device": dev_id, "last_seen": ts(14, "12:00")})

    def ip(self, acc_id: str, ip_id: str) -> None:
        if ip_id not in self._ip:
            self._ip.add(ip_id)
            n = int(ip_id.split("-")[1])
            self.w.ips.append({"id": ip_id, "addr": f"10.{n // 250}.{n % 250}.{(n * 7) % 250 + 1}",
                               "asn_country": "US"})
        self.w.used_ip.append({"account": acc_id, "ip": ip_id, "last_seen": ts(14, "12:00")})

    def tx(self, src: str, dst: str, amount: float, when: int, channel: str = "imps",
           ring_id: int = 0, laundering: bool = False) -> None:
        self._raw_transfers.append((src, dst, round(float(amount), 2), when, channel, ring_id, laundering))

    def _rand_ts(self) -> int:
        start = int(WINDOW_START.timestamp() * 1000)
        return start + self.rng.randrange(0, 14 * DAY_MS)

    def _rand_amount(self) -> float:
        return round(min(5000.0, max(5.0, math.exp(self.rng.gauss(math.log(150), 1.0)))), 2)

    # ---- the world --------------------------------------------------------
    def build(self) -> World:
        self._accounts()
        self._infrastructure()
        self._background_activity()
        self._plant_merchant()
        self._plant_family()
        self._plant_ring1()
        self._plant_ring2()
        self._plant_ring3()
        self._plant_hub_activity()
        self._finalise_transfers()
        self._score_accounts()
        self._cases()
        self._ground_truth()
        return self.w

    def _accounts(self) -> None:
        r = self.rng
        for acc in BACKGROUND:
            kind = "business" if r.random() < 0.15 else "personal"
            self.account(acc, kind, r.randint(200, 2000), r.choice(["US", "US", "US", "GB", "IN", "SG"]))
        self.account("A77", "personal", 1460)
        self.account("C42", "personal", 2100)
        for i, acc in enumerate(DORMANT):
            self.account(acc, "personal", (3 + 4 * i) if i < 6 else 300 + 50 * i)
        for acc, age in zip(RING1, [41, 27, 24, 22, 19, 16, 12]):
            self.account(acc, "personal", age)
        for acc, age in zip(RING2, [33, 29, 26]):
            self.account(acc, "personal", age)
        for acc, age in zip(RING3, [38, 31, 28, 25, 21]):
            self.account(acc, "personal", age)
        for acc in FAMILY:
            self.account(acc, "personal", 1200 if acc == "A95" else 640)
        for hub in HUBS:
            self.account(hub, "business", 420 + 30 * HUBS.index(hub))
        self.account(MERCHANT, "merchant", 1500)
        self.account(EXIT, "external", 900, "VG")
        # The merchant settles into an account held by the same customer.
        merchant_owner = next(o["customer"] for o in self.w.owns if o["account"] == MERCHANT)
        for o in self.w.owns:
            if o["account"] == MERCHANT_SETTLEMENT:
                o["customer"] = merchant_owner

    def _infrastructure(self) -> None:
        r = self.rng
        n = 0
        personal = [a for a in self.w.accounts if a["id"] not in set(RING1 + RING2 + RING3 + FAMILY)
                    and a["id"] != MERCHANT]
        for acc in personal:
            n += 1
            self.device(acc["id"], f"D-{n:03d}", "desktop" if acc["type"] != "personal" else "mobile")
            self.ip(acc["id"], f"IP-{n:03d}")
        # 20 ordinary households share one device + IP (benign noise for the pivot).
        pool = [a for a in BACKGROUND]
        r.shuffle(pool)
        for k in range(20):
            a, b = pool[2 * k], pool[2 * k + 1]
            self.device(b, f"D-{self._dev_of(a)}")
        for pos in range(3):
            self.device(MERCHANT, f"D-95{pos}", "pos")
        self.ip(MERCHANT, "IP-950")
        # Ring 1: three shared phones, two shared IPs.
        for acc, devs, ip_ in [("A17", ["D-901", "D-902"], "IP-901"), ("A22", ["D-901"], "IP-901"),
                               ("A31", ["D-902"], "IP-901"), ("A47", ["D-902", "D-903"], "IP-902"),
                               ("A52", ["D-903"], "IP-902"), ("A63", ["D-901"], "IP-902"),
                               ("A68", ["D-903"], "IP-902")]:
            for d in devs:
                self.device(acc, d)
            self.ip(acc, ip_)
        for acc in RING2:
            self.device(acc, "D-911")
            self.ip(acc, "IP-911")
        for acc, devs in [("A12", ["D-921"]), ("A26", ["D-921"]), ("A39", ["D-921", "D-922"]),
                          ("A58", ["D-922"]), ("A64", ["D-922"])]:
            for d in devs:
                self.device(acc, d)
            self.ip(acc, "IP-921")
        for acc in FAMILY:
            self.device(acc, "D-931", "tablet")
            self.ip(acc, "IP-931")

    def _dev_of(self, acc_id: str) -> str:
        for link in self.w.used_device:
            if link["account"] == acc_id:
                return link["device"].split("-", 1)[1]
        raise KeyError(acc_id)

    def _background_activity(self) -> None:
        r = self.rng
        pool = BACKGROUND + ["A77", "C42"]
        for _ in range(7800):
            src, dst = r.sample(pool, 2)
            self.tx(src, dst, self._rand_amount(), self._rand_ts(), r.choice(["upi", "imps", "neft", "card"]))

    def _plant_merchant(self) -> None:
        """M8: 320 independent one-time customers, five settlements to its own account."""
        r = self.rng
        payers = r.sample(BACKGROUND, 320)
        total = 0.0
        for p in payers:
            amount = round(r.uniform(15, 180), 2)
            total += amount
            self.tx(p, MERCHANT, amount, self._rand_ts(), "card")
        for k, day in enumerate([3, 6, 9, 12, 14]):
            self.tx(MERCHANT, MERCHANT_SETTLEMENT, round(total / 5 * (0.97 + 0.01 * k), 2),
                    ts(day, "23:30"), "neft")

    def _plant_family(self) -> None:
        """A95 pays allowances to A96-A98; the kids spend slowly at ordinary accounts."""
        r = self.rng
        self.tx("A140", "A95", 6200.0, ts(1, "09:00"), "neft")       # salary
        for day in (1, 8):
            for kid, amt in zip(FAMILY[1:], (450.0, 380.0, 300.0)):
                self.tx("A95", kid, amt, ts(day, "19:30"), "upi")
        for kid in FAMILY[1:]:
            for _ in range(6):
                self.tx(kid, r.choice(BACKGROUND), round(r.uniform(8, 60), 2), self._rand_ts(), "upi")

    def _plant_ring1(self) -> None:
        """The primary demo. Day 14: victims fund three entry mules, A17 bursts 14 transfers
        to 12 recipients in two hours, money is layered in hops of 6-18 minutes into A47 and
        out to hub H3. A52 also routes through a non-ring account, A77."""
        L = lambda s, d, a, t: self.tx(s, d, a, ts(14, t), "imps", 1, True)  # noqa: E731
        # Victim inflows (scam proceeds) into three entry accounts.
        for src, dst, amt, t in [("A110", "A17", 5200, "08:40"), ("A111", "A17", 4800, "09:05"),
                                 ("A112", "A17", 6100, "09:30"), ("A113", "A17", 3900, "09:50"),
                                 ("A114", "A63", 4500, "09:20"), ("A115", "A63", 3800, "10:05"),
                                 ("A116", "A68", 5600, "09:45")]:
            self.tx(src, dst, amt, ts(14, t), "upi", 0, True)
        # The burst: 14 transfers from A17 to 12 recipients between 10:02 and 11:58.
        L("A17", "A22", 4600, "10:02"); L("A17", "A63", 3500, "10:20")
        L("A17", "A68", 2700, "10:45"); L("A17", "A22", 4500, "11:10")
        L("A17", "A63", 3300, "11:30")
        for i, (acc, t) in enumerate(zip(DORMANT, ["10:08", "10:26", "10:39", "10:51", "11:02",
                                                     "11:17", "11:36", "11:44", "11:58"])):
            self.tx("A17", acc, 120 + 30 * i, ts(14, t), "imps", 1, True)
        # Layer 1 -> layer 2 (each forward 11-13 minutes after the inflow, ~2.5% skimmed).
        L("A63", "A31", 4380, "09:31"); L("A68", "A52", 5450, "09:58")
        L("A22", "A31", 4480, "10:14"); L("A63", "A52", 3700, "10:17")
        L("A63", "A52", 3410, "10:33"); L("A68", "A52", 2630, "10:57")
        L("A22", "A31", 4390, "11:24"); L("A63", "A31", 3220, "11:41")
        # Layer 2 -> aggregator A47, and the bypass through A77.
        L("A31", "A47", 4270, "09:44"); L("A52", "A47", 5320, "10:11")
        # A77 forwards exactly what it receives, so ring capacity is exactly 30,100.
        L("A31", "A47", 4370, "10:27"); L("A52", "A77", 3520, "10:30")
        L("A52", "A47", 3330, "10:45"); L("A52", "A77", 2490, "11:08")
        L("A31", "A47", 4280, "11:36"); L("A31", "A47", 3140, "11:55")
        # Aggregator and bypass cash out at H3.
        L("A47", "H3", 4160, "09:52"); L("A47", "H3", 5190, "10:22")
        L("A47", "H3", 4260, "10:39"); L("A77", "H3", 3520, "10:44")
        L("A47", "H3", 3250, "10:58"); L("A77", "H3", 2490, "11:21")
        L("A47", "H3", 4170, "11:47"); L("A47", "H3", 3060, "12:06")

    def _plant_ring2(self) -> None:
        """C42 loses $9,800; it moves C42 -> A91 -> A33 -> A75 -> H1 in 26 minutes, 3-5% per hop.
        Two earlier chains through the same mules make H1 a recurring destination."""
        for day, victim, amounts, start in [
            (14, "C42", [9800, 9460, 9120, 8790], "14:05"),
            (13, "A120", [6200, 5960, 5730, 5520], "16:00"),
            (12, "A121", [4400, 4240, 4080, 3930], "11:30"),
        ]:
            path = [victim, "A91", "A33", "A75", "H1"]
            h, m = (int(x) for x in start.split(":"))
            gaps = [0, 8, 9, 9]
            minute = h * 60 + m
            for hop, (amt, gap) in enumerate(zip(amounts, gaps)):
                minute += gap
                laundering = True
                self.tx(path[hop], path[hop + 1], amt,
                        ts(day, f"{minute // 60:02d}:{minute % 60:02d}"),
                        "imps", 0 if hop == 0 else 2, laundering)

    def _plant_ring3(self) -> None:
        L = lambda s, d, a, t: self.tx(s, d, a, ts(13, t), "imps", 3, True)  # noqa: E731
        for src, amt, t in [("A130", 4100, "13:00"), ("A131", 3700, "13:20"), ("A132", 5200, "13:45")]:
            self.tx(src, "A12", amt, ts(13, t), "upi", 0, True)
        L("A12", "A26", 4000, "13:12"); L("A12", "A39", 3610, "13:33")
        L("A12", "A26", 5070, "13:58"); L("A26", "A58", 3900, "13:25")
        L("A39", "A58", 3520, "13:46"); L("A26", "A58", 4950, "14:10")
        L("A58", "A64", 3800, "13:37"); L("A58", "A64", 3430, "13:59")
        L("A58", "A64", 4830, "14:22"); L("A64", "H5", 3710, "13:49")
        L("A64", "H5", 3350, "14:11"); L("A64", "H5", 4710, "14:35")

    def _plant_hub_activity(self) -> None:
        """Hubs look like busy OTC desks: legitimate small customers, then a nightly sweep to X9."""
        r = self.rng
        for hub in HUBS:
            for cust in r.sample(BACKGROUND, 20):
                self.tx(cust, hub, round(r.uniform(100, 900), 2), self._rand_ts(), "imps")
        # Nightly sweeps (sum of what arrived that day, minus a 1.5% margin).
        inflow: dict[tuple[str, int], list[float]] = defaultdict(lambda: [0.0, 0.0])
        for src, dst, amt, when, _ch, _ring, laundering in self._raw_transfers:
            if dst in HUBS:
                day = (when - int(WINDOW_START.timestamp() * 1000)) // DAY_MS + 1
                inflow[(dst, day)][0] += amt
                if laundering:
                    inflow[(dst, day)][1] += amt
        for (hub, day), (amt, dirty) in sorted(inflow.items()):
            if day <= 14:
                self.tx(hub, EXIT, round(amt * 0.985, 2), ts(day, "23:50"), "swift",
                        {"H1": 2, "H3": 1, "H5": 3}[hub] if dirty else 0, dirty > 0)

    def _finalise_transfers(self) -> None:
        self._raw_transfers.sort(key=lambda t: (t[3], t[0], t[1]))
        agg: dict[tuple[str, str], dict] = {}
        for i, (src, dst, amt, when, ch, ring, laund) in enumerate(self._raw_transfers, start=1):
            tid = f"T-{i:05d}"
            self.w.transfers.append({"src": src, "dst": dst, "id": tid, "amount": amt, "ts": when,
                                     "channel": ch, "ring_id": ring, "is_laundering": laund})
            f = agg.setdefault((src, dst), {"src": src, "dst": dst, "capacity": 0.0, "tx_count": 0,
                                            "first_ts": when, "last_ts": when})
            f["capacity"] = round(f["capacity"] + amt, 2)
            f["tx_count"] += 1
            f["first_ts"] = min(f["first_ts"], when)
            f["last_ts"] = max(f["last_ts"], when)
        self.w.flows = list(agg.values())

    def _score_accounts(self) -> None:
        """A deliberately *legacy-style* volume/velocity score, like a rules engine produces.
        It is one weak signal the agent can read; the graph decides what it means."""
        tx_count: dict[str, int] = defaultdict(int)
        counterparties: dict[str, set] = defaultdict(set)
        inflows: dict[str, list[int]] = defaultdict(list)
        fast_out: dict[str, float] = defaultdict(float)
        out_vol: dict[str, float] = defaultdict(float)
        for t in self.w.transfers:
            tx_count[t["src"]] += 1
            tx_count[t["dst"]] += 1
            counterparties[t["src"]].add(t["dst"])
            counterparties[t["dst"]].add(t["src"])
            inflows[t["dst"]].append(t["ts"])
        for t in self.w.transfers:
            out_vol[t["src"]] += t["amount"]
            if any(0 < t["ts"] - i <= 60 * MIN_MS for i in inflows[t["src"]]):
                fast_out[t["src"]] += t["amount"]
        sharers: dict[str, set] = defaultdict(set)
        by_infra: dict[str, set] = defaultdict(set)
        for link in self.w.used_device:
            by_infra[link["device"]].add(link["account"])
        for link in self.w.used_ip:
            by_infra[link["ip"]].add(link["account"])
        for accs in by_infra.values():
            for a in accs:
                sharers[a] |= accs - {a}
        max_log = max(math.log1p(c) for c in tx_count.values())
        max_cp = max(len(c) for c in counterparties.values())
        now_ms = NOW.timestamp() * 1000
        for acc in self.w.accounts:
            a = acc["id"]
            volume = math.log1p(tx_count[a]) / max_log
            breadth = len(counterparties[a]) / max_cp
            velocity = fast_out[a] / out_vol[a] if out_vol[a] else 0.0
            youth = max(0.0, 1 - (now_ms - acc["opened_at"]) / DAY_MS / 90)
            shared = min(len(sharers[a]), 5) / 5
            score = 0.45 * volume + 0.20 * breadth + 0.15 * velocity + 0.10 * youth + 0.10 * shared
            acc["anomaly_score"] = round(score, 3)

    def _cases(self) -> None:
        created = ts(14, "12:30")
        self.w.cases = [
            {"id": "case-001", "title": "Burst of transfers from A17",
             "alert": "14 transfers from account A17 within 2 hours to 12 different recipients, "
                      "most of them opened in the last 30 days.",
             "seed_accounts": ["A17"], "created_at": created, "status": "open",
             "suggested_questions": ["Who is behind this burst of transfers?",
                                     "Where does the money end up?",
                                     "What is the smallest freeze that stops it?"]},
            {"id": "case-002", "title": "Unauthorized $9,800 debit from C42",
             "alert": "Customer complaint: $9,800 left account C42 without authorization on Oct 14.",
             "seed_accounts": ["C42"], "created_at": ts(14, "16:10"), "status": "open",
             "suggested_questions": ["Follow the $9,800 from C42.",
                                     "Who received the money and is it part of a network?"]},
            {"id": "case-003", "title": "Top-1% anomaly score: M8",
             "alert": "Merchant account M8 is in the top 1% of the rules-engine anomaly score "
                      "(high volume, high degree).",
             "seed_accounts": ["M8"], "created_at": ts(14, "18:00"), "status": "open",
             "suggested_questions": ["Is M8 laundering money?"]},
            {"id": "case-004", "title": "Shared-device cluster around A95",
             "alert": "Four accounts (A95-A98) log in from the same tablet and IP address.",
             "seed_accounts": ["A95"], "created_at": ts(14, "18:20"), "status": "open",
             "suggested_questions": ["Is the A95 cluster a mule ring?"]},
        ]

    def _ground_truth(self) -> None:
        self.w.ground_truth = {
            "seed": SEED,
            "rings": {"1": RING1, "2": RING2, "3": RING3},
            "hubs": {"1": "H3", "2": "H1", "3": "H5"},
            "exit": EXIT,
            "ring1_entries": ["A17", "A63", "A68"],
            "ring1_bypass_account": "A77",
            "ring1_capacity_to_H3": 30100.0,
            "ring1_minimum_freeze": ["A47", "A52"],
            "c42_chain": ["C42", "A91", "A33", "A75", "H1"],
            "c42_chain_minutes": 26,
            "benign_clusters": {"family": FAMILY, "merchant": [MERCHANT]},
            "burst": {"account": "A17", "transfers": 14, "recipients": 12, "minutes": 116},
        }


def build_world() -> World:
    return _Builder().build()


if __name__ == "__main__":  # quick stats without a database
    w = build_world()
    print(f"accounts={len(w.accounts)} devices={len(w.devices)} ips={len(w.ips)} "
          f"transfers={len(w.transfers)} flows={len(w.flows)}")
    top = sorted(w.accounts, key=lambda a: -a["anomaly_score"])[:8]
    print("top anomaly:", [(a["id"], a["anomaly_score"]) for a in top])
