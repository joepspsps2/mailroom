// 電子報群發：一期信的狀態、凍結名單、分波派送、配速、暖機梯子、兩級煞車、對帳、郵差介面與假郵差。見 docs/broadcast.md。
export { DEFAULT_BROADCAST_CONFIG, resolveConfig, type BroadcastConfig } from './config.ts';
export {
  approveCampaign, cancelCampaign, canTransition, checkAudience, contentHash, getCampaign, pauseCampaign, recordPreflight, resumeCampaign, saveDraft,
  scheduleCampaign, unscheduleCampaign, CAMPAIGN_STATUSES, TRANSITIONS,
  type Audience, type CampaignInput, type CampaignRow, type CampaignStatus, type PreflightRecord,
} from './campaigns.ts';
export {
  activeHold, consume, consumeBatch, releaseHold, resolveUncertain, retryFailed, tick,
  type Alert, type BroadcastDeps, type BroadcastMessage, type BroadcastQueue, type ConsumeResult, type QueueMessageLike, type RecipientRow, type Render, type RenderResult, type TickReport,
} from './dispatch.ts';
export { ingestEvent, isPermanentBounce, type FeedbackInput, type IngestOptions, type IngestOutcome } from './events.ts';
export { freezeRecipients, type FrozenAudience } from './freeze.ts';
export { EVENT_TYPES, FakePostman, SIMULATOR_RULES, type EventType, type FakeOutcome, type FakePostmanOptions, type FakeRule, type Postman, type PostmanLimits, type PostmanMail, type PostmanOutcome, type ProviderEvent } from './postman.ts';
export { reconcileCampaign, type ReconcileReport } from './reconcile.ts';
export { campaignRates, domainRates, type CampaignRates } from './stats.ts';
export { campaignStatus, throttleStatus } from './status.ts';
export { currentStep, evaluateWarmup, planBlocked, planSteps, unblockWarmup, upsertWarmupStep, type GateResult, type StepInput, type WarmupStepRow } from './warmup.ts';
export { explainPause, type PauseExplanation } from './explain.ts';
export { parseAllowed, previewContent, sendTest, MAX_TEST_RECIPIENTS, type TestSendDeps } from './test-send.ts';
export { audiencePlan, type AudiencePlan } from './audience.ts';
