export interface Summary {
  briefSummary: string;
  participants: string;
  keyPoints: string;
  agreements: string;
  legallySignificant: string;
  cautions: string;
}

export interface TranscribeResult {
  transcript: string;
  summary: Summary;
  partialFailure?: string;
}
