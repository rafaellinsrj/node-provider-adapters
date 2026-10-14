import {ProviderError} from '../errors.ts';
import type {Transport} from '../transport/types.ts';
import {callJson} from './http-json.ts';

// Social networks differ in every detail, so the adapter contract is deliberately tiny: publish one post for a
// connected account. Each network gets its own implementation; this one targets a Graph-style API.
export interface SocialAdapter {
  readonly network: string;
  publish(input: {accountId: string; accessToken: string; text: string; outboxId: string}): Promise<{postId: string}>;
}

export interface SocialAppConfig {
  clientId?: string;
  clientSecret?: string;
  apiVersion?: string;
  /** Most networks only allow publishing for third parties after an app review. */
  reviewApproved?: boolean;
}

export function socialAvailable(app: SocialAppConfig | undefined): {available: boolean; reason?: string} {
  if (!app?.clientId || !app.clientSecret) return {available: false, reason: 'oauth_configuration_required'};
  if (!app.reviewApproved) return {available: false, reason: 'app_review_required'};
  if (!/^v\d+\.\d+$/.test(app.apiVersion ?? '')) return {available: false, reason: 'api_version_required'};
  return {available: true};
}

export function graphLikeSocial(network: string, app: SocialAppConfig, transport: Transport, baseUrl: string): SocialAdapter {
  const status = socialAvailable(app);
  if (!status.available) throw new ProviderError(503, 'not_configured');
  return {
    network,
    async publish({accountId, accessToken, text, outboxId}) {
      if (!/^[0-9]{1,30}$/.test(accountId)) throw new ProviderError(422, 'path_denied');
      const res = await callJson(
        transport,
        `${baseUrl}/${app.apiVersion}/${accountId}/feed`,
        {method: 'POST', headers: {authorization: `Bearer ${accessToken}`, 'content-type': 'application/json'}, body: JSON.stringify({message: text, client_ref: outboxId})},
        {mutation: true},
      );
      if (res.status >= 400) throw new ProviderError(502, 'rejected');
      if (typeof res.body.id !== 'string') throw new ProviderError(503, 'invalid_result');
      return {postId: res.body.id};
    },
  };
}
