import {socialAvailable, type SocialAppConfig} from './social.ts';

// One place that answers "can this provider be used right now, and if not, why". The UI shows the reason; business
// code checks `available` before offering a feature, so a missing key degrades a feature instead of crashing.
export interface IntegrationsConfig {
  enabled: boolean;
  payments?: {apiKey?: string; webhookSecrets?: string[]};
  email?: {apiKey?: string};
  kyc?: {apiKey?: string; workflowId?: string; webhookSecret?: string};
  social?: Record<string, SocialAppConfig>;
}

export type ProviderAvailability = {available: boolean; reason?: string};

export function providerStatus(config: IntegrationsConfig): Record<string, ProviderAvailability> {
  const on = config.enabled === true;
  const reason = (ok: boolean, why: string) => (ok ? {available: true} : {available: false, reason: on ? why : 'integrations_disabled'});
  return {
    payments: reason(on && !!config.payments?.apiKey && !!config.payments.webhookSecrets?.length, 'payments_configuration_required'),
    email: reason(on && !!config.email?.apiKey, 'email_configuration_required'),
    kyc: reason(on && !!config.kyc?.apiKey && !!config.kyc.workflowId && !!config.kyc.webhookSecret, 'kyc_configuration_required'),
    ...Object.fromEntries(Object.entries(config.social ?? {}).map(([network, app]) => [network, on ? socialAvailable(app) : {available: false, reason: 'integrations_disabled'}])),
  };
}
