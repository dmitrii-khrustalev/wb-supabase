export type JobMode = "history" | "daily";

export type LoaderResult = {
  done: boolean;
  cursor: Record<string, unknown>;
  rowsIn: number;
  rowsUpserted: number;
  rowsYesterday?: number;
  rowsOld?: number;
  retry?: boolean;
  error?: string;
  note?: string;
};

export type Seller = {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  history_from: string;
};

export type SyncJob = {
  id: string;
  seller_id: string;
  dataset: string;
  mode: JobMode;
  status: string;
  cursor: Record<string, unknown>;
  attempts: number;
  created_at?: string | null;
  started_at?: string | null;
};

export type LoaderContext = {
  seller: Seller;
  token: string;
  mode: JobMode;
  cursor: Record<string, unknown>;
  today: string;
  yesterday: string;
};
