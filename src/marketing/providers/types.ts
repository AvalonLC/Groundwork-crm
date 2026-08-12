/**
 * The provider seam.
 *
 * Everything above this interface — snapshotting, batching, the drain loop,
 * suppression, attribution — is provider-agnostic. SendGrid is the only
 * implementation today because the CRM already sends transactional mail
 * through it (src/index.tsx sendEmail), so the account, the API key and the
 * deliverability reputation already exist.
 *
 * The seam is not speculative generality: campaign volume is exactly the kind
 * of traffic that gets an ESP account throttled or dropped, and the plausible
 * response is moving providers under time pressure. Keeping the escape hatch
 * cheap now is worth one interface.
 */

/** One recipient's per-message variation. The body itself is rendered once. */
export interface OutboundMessage {
  to: string;
  /** Replaces -firstName-, -unsubUrl-, -trackBase- and friends in the body. */
  substitutions: Record<string, string>;
  /** Echoed back verbatim on every webhook event for this message. */
  customArgs: Record<string, string>;
  headers?: Record<string, string>;
}

export interface SendBatchInput {
  from: { email: string; name: string };
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  /** Grouping label the provider reports on, e.g. the campaign id. */
  category?: string;
  messages: OutboundMessage[];
}

export interface SendBatchResult {
  ok: boolean;
  status: number;
  /** Provider-side id for the whole batch, when one is returned. */
  providerMessageId: string;
  error?: string;
  /**
   * True when the failure is worth retrying (throttling, provider outage,
   * network). False for a rejection that will fail identically forever, such
   * as a malformed payload or a revoked key.
   */
  retryable?: boolean;
}

export type EmailEventType =
  | 'processed'
  | 'delivered'
  | 'open'
  | 'click'
  | 'bounce'
  | 'dropped'
  | 'deferred'
  | 'spamreport'
  | 'unsubscribe'
  | 'group_unsubscribe';

/** A provider event mapped onto our own vocabulary. */
export interface NormalizedEvent {
  providerEventId: string;
  eventType: EmailEventType;
  email: string;
  companyId: string;
  campaignId: string;
  recipientId: string;
  url: string;
  reason: string;
  userAgent: string;
  ip: string;
  /** ISO 8601 UTC. */
  occurredAt: string;
  /** Bounce classification, where the provider distinguishes them. */
  hardBounce: boolean;
}

export interface DomainAuthRecord {
  type: string;
  host: string;
  data: string;
}

export interface DomainAuthResult {
  ok: boolean;
  providerDomainId: string;
  records: DomainAuthRecord[];
  error?: string;
}

export interface DomainValidateResult {
  ok: boolean;
  verified: boolean;
  error?: string;
}

export interface EmailProvider {
  readonly name: string;
  sendBatch(input: SendBatchInput): Promise<SendBatchResult>;
  /**
   * Verify the request signature and map the payload onto NormalizedEvent[].
   * Returns null when the signature does not verify — the caller must treat
   * null as "reject the request", never as "no events".
   */
  verifyWebhook(rawBody: string, headers: Headers, publicKey: string): Promise<NormalizedEvent[] | null>;
  createDomainAuth(domain: string): Promise<DomainAuthResult>;
  validateDomainAuth(providerDomainId: string): Promise<DomainValidateResult>;
}
