export interface EngineEvent {
  t: number;
  actor: number; // -1 = system/referee
  type: string;
  payload: Record<string, unknown>;
  visible_to: number[] | null; // null = everyone
}

export interface RefereeAnswers {
  [statementIdx: string]: {
    accuses: { choice: string; confidence: number; noulConfidence: number };
    claims_seer: { noul: number; confidence: number };
    defensive: { noul: number; confidence: number };
  };
}
