// Frozen mock fixtures for the three scripted demo scenarios (see plan.md §5).
// The frontend runs entirely on these until the real backend exposes POST /api/investigate.

import type { InvestigationResponse } from "@/lib/types";
import scenario1 from "./scenario-1.json";
import scenario2 from "./scenario-2.json";
import scenario3 from "./scenario-3.json";

export interface CaseMeta {
  id: string;
  title: string;
  alert: string;
  suggested: string[];
}

export const mockCaseList: CaseMeta[] = [
  {
    id: "case-001",
    title: "Operation Burst",
    alert: "14 transfers from A17 within 2 hours, to 12 recipients, most accounts opened under 30 days ago.",
    suggested: [
      "Who is behind the burst of transfers from account A17?",
      "Is A17 part of a larger ring?",
      "What happens if we freeze the ring?",
    ],
  },
  {
    id: "case-002",
    title: "Follow the money",
    alert: "Customer C42 reports an unauthorized $9,800 transfer that left their account overnight.",
    suggested: [
      "Trace the money from C42 to where it left the network",
      "Is this part of a known pattern?",
      "Who holds the receiving hub?",
    ],
  },
  {
    id: "case-003",
    title: "The quiet merchant",
    alert: "M8 flagged by the anomaly scorer (top 1% of transaction volume). No other alerts.",
    suggested: [
      "Is M8 part of a fraud ring?",
      "Why was M8 flagged, and is it benign?",
      "Does M8 share anything with known rings?",
    ],
  },
];

export function caseMeta(id: string): CaseMeta {
  return (
    mockCaseList.find((c) => c.id === id) ?? {
      id,
      title: `Case ${id}`,
      alert: "No briefing available for this case yet.",
      suggested: ["What do we know about this case so far?"],
    }
  );
}

export const mockResponses: Record<string, InvestigationResponse> = {
  "case-001": scenario1 as unknown as InvestigationResponse,
  "case-002": scenario2 as unknown as InvestigationResponse,
  "case-003": scenario3 as unknown as InvestigationResponse,
};
