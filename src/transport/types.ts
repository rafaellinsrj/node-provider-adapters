// A transport is the only thing that touches the network. Adapters receive one by injection, so the same adapter code
// runs against the real provider (fetchTransport), a local fake (fakeTransport) or a recorded cassette (replayTransport).
export interface TransportRequest {
  method: 'GET' | 'POST' | 'DELETE';
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Headers;
  text(): Promise<string>;
}

export type Transport = (url: string, init: TransportRequest) => Promise<TransportResponse>;
