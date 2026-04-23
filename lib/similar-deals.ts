export { SIMILAR_PEERS_TOP_K } from "@/lib/similar-deals/constants";

export type { SimilarPeerForPrompt, SimilarPeerBundleForPipeline } from "@/lib/similar-deals/types";

export { fetchSimilarDealsHybrid } from "@/lib/similar-deals/fetch-hybrid";

export {
  fetchSimilarPeersAfterPhase1Parse,
  fetchSimilarPeerBundlesForPipeline,
  fetchSimilarPeersFromRetrievalProfile,
} from "@/lib/similar-deals/pipeline";

export { labeledSimilarCompanyInputs } from "@/lib/similar-deals/prompt-inputs";

export { afterPersistIndexDealEmbedding, indexDealEmbedding } from "@/lib/similar-deals/indexing";

export { fetchSimilarDealsFromDealId } from "@/lib/similar-deals/fetch-from-deal";
