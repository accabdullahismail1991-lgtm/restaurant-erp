// Shared across CartPanel's estimate and the offline order queue's own
// estimate, since both must agree with the API's real VAT calculation
// (Sales module) that runs at order-creation time.
export const VAT_RATE = 0.15;
