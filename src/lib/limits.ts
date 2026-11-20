// Limits shared by the Worker and the SPA. The SPA bundles this module, so it must stay import-free.

/** Maximum links per POST /api/bulk request. */
export const BULK_MAX = 50;

/**
 * Maximum ids in one campaign association list: `campaignIds` on a link write
 * and `linkIds` on POST /api/campaigns/:id/links. Each list feeds one `inArray`,
 * and D1 caps a statement at 100 bound parameters.
 */
export const CAMPAIGN_LINKS_MAX = 50;
